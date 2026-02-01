import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import * as net from 'net';
import { EventEmitter } from 'events';
import { Mailbox, MailboxConfig, MessageMetadata } from './mailbox';
import { PMDClient, NodeInfo } from './pmd-client';
import { Transport } from './transport';

/**
 * Node runtime configuration
 */
export interface NodeRuntimeOptions {
  alias?: string;
  pmdPort?: number;
  pmdHost?: string;
  mailbox?: MailboxConfig;
}

/**
 * Peer information
 */
export interface PeerInfo {
  alias?: string;
  nodeId: string;
  host: string;
  port: number;
}

/**
 * NodeRuntime - Main entry point for the distributed framework
 * Singleton pattern - one node per process
 */
export class NodeRuntime extends EventEmitter {
  private static instance?: NodeRuntime;
  private static lockFile?: string;

  private nodeId: string;
  private alias?: string;
  private mailbox: Mailbox;
  private pmdClient: PMDClient;
  private transport: Transport;
  private heartbeatTimer?: NodeJS.Timeout;
  private pmdProcess?: child_process.ChildProcess;
  private isStarted = false;

  private constructor(options: NodeRuntimeOptions = {}) {
    super();

    // Generate unique node ID
    this.nodeId = this.generateNodeId();
    this.alias = options.alias;

    // Initialize components
    this.mailbox = new Mailbox(options.mailbox);
    this.pmdClient = new PMDClient(
      options.pmdHost ?? 'localhost',
      options.pmdPort ?? 4369
    );
    this.transport = new Transport();
  }

  /**
   * Start the node runtime (singleton)
   */
  static async start(options: NodeRuntimeOptions = {}): Promise<NodeRuntime> {
    // Check if already started
    if (NodeRuntime.instance) {
      return NodeRuntime.instance;
    }

    // Create lock file to prevent multiple instances
    const lockFile = path.join(os.tmpdir(), `distflow-node-${process.pid}.lock`);
    
    if (fs.existsSync(lockFile)) {
      throw new Error('Node already running in this process');
    }

    fs.writeFileSync(lockFile, process.pid.toString());
    NodeRuntime.lockFile = lockFile;

    // Clean up lock file on exit
    process.on('exit', () => {
      if (NodeRuntime.lockFile && fs.existsSync(NodeRuntime.lockFile)) {
        fs.unlinkSync(NodeRuntime.lockFile);
      }
    });

    // Create instance
    const instance = new NodeRuntime(options);
    await instance.initialize(options.pmdPort ?? 4369);

    NodeRuntime.instance = instance;
    return instance;
  }

  /**
   * Initialize the node runtime
   */
  private async initialize(pmdPort: number): Promise<void> {
    // Try to start PMD if not running
    await this.ensurePMDRunning(pmdPort);

    // Start transport layer
    const port = await this.transport.listen();

    // Setup transport message handler
    this.transport.onMessage((message, meta) => {
      this.mailbox.push({ payload: message, meta });
    });

    // Setup mailbox handler
    this.mailbox.onMessage((message, meta) => {
      // Emit to allow user handlers
      this.emit('message', message, meta);
    });

    // Connect to PMD
    await this.connectToPMD();

    // Register with PMD
    await this.pmdClient.register(this.nodeId, this.alias, 'localhost', port);

    // Watch for peer events
    await this.pmdClient.watch();

    this.pmdClient.on('peer:join', (peer) => {
      this.emit('peer:join', peer);
    });

    this.pmdClient.on('peer:leave', (peer) => {
      this.emit('peer:leave', peer);
    });

    // Start heartbeat
    this.startHeartbeat();

    this.isStarted = true;
  }

  /**
   * Ensure PMD is running, start if needed
   */
  private async ensurePMDRunning(port: number): Promise<void> {
    // Try to connect to existing PMD
    const testSocket = net.createConnection({ host: 'localhost', port });
    
    return new Promise((resolve, reject) => {
      testSocket.on('connect', () => {
        testSocket.end();
        resolve();
      });

      testSocket.on('error', async () => {
        // PMD not running, start it
        console.log('Starting PMD...');
        try {
          await this.startPMD(port);
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Start PMD daemon
   */
  private async startPMD(port: number): Promise<void> {
    // Try to find PMD cli.js in multiple locations
    const possiblePaths = [
      path.join(__dirname, '../../pmd/dist/cli.js'),  // Monorepo workspace
      path.join(__dirname, '../../../@distflow/pmd/dist/cli.js'),  // node_modules
      require.resolve('@distflow/pmd/dist/cli.js')  // Try to resolve from node_modules
    ];

    let pmdPath: string | undefined;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        pmdPath = p;
        break;
      }
    }

    if (!pmdPath) {
      throw new Error(`PMD cli.js not found. Tried: ${possiblePaths.join(', ')}. Please build @distflow/pmd first.`);
    }

    // Start PMD as child process
    this.pmdProcess = child_process.spawn('node', [pmdPath, '--port', port.toString()], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    this.pmdProcess.unref();

    // Wait for PMD to be ready
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  /**
   * Connect to PMD with retry
   */
  private async connectToPMD(retries: number = 5): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.pmdClient.connect();
        return;
      } catch (err) {
        if (i === retries - 1) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this.pmdClient.heartbeat(this.nodeId);
      } catch (err) {
        console.error('Heartbeat failed:', err);
      }
    }, 1000); // Every 1 second (1/3 of PMD TTL for safety margin)
  }

  /**
   * Generate unique node ID
   */
  private generateNodeId(): string {
    const machineId = os.hostname();
    const pid = process.pid;
    const random = crypto.randomBytes(8).toString('hex');

    const hash = crypto.createHash('sha256');
    hash.update(`${machineId}-${pid}-${random}`);
    
    return hash.digest('hex').substring(0, 16);
  }

  /**
   * Send message to another node
   */
  async send(target: string, message: any): Promise<void> {
    if (!this.isStarted) {
      throw new Error('Node not started');
    }

    // Resolve target (could be alias or nodeId)
    let nodeInfo: NodeInfo;
    
    try {
      nodeInfo = await this.pmdClient.resolve(target);
    } catch (err) {
      throw new Error(`Failed to resolve target: ${target}`);
    }

    // Send via transport
    await this.transport.send(
      nodeInfo.host,
      nodeInfo.port,
      this.nodeId,
      nodeInfo.nodeId,
      message
    );
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: any, meta: MessageMetadata) => void): void {
    this.on('message', handler);
  }

  /**
   * Discover peers
   */
  async discover(): Promise<PeerInfo[]> {
    if (!this.isStarted) {
      throw new Error('Node not started');
    }

    const nodes = await this.pmdClient.list();
    return nodes.filter(n => n.nodeId !== this.nodeId).map(n => ({
      alias: n.alias,
      nodeId: n.nodeId,
      host: n.host,
      port: n.port
    }));
  }

  /**
   * Get node ID
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Get alias
   */
  getAlias(): string | undefined {
    return this.alias;
  }

  /**
   * Shutdown the node
   */
  async shutdown(): Promise<void> {
    if (!this.isStarted) {
      return;
    }

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Unregister from PMD
    try {
      await this.pmdClient.unregister(this.nodeId);
    } catch (err) {
      console.error('Failed to unregister:', err);
    }

    // Disconnect from PMD
    this.pmdClient.disconnect();

    // Stop transport
    await this.transport.stop();

    // Clean up lock file
    if (NodeRuntime.lockFile && fs.existsSync(NodeRuntime.lockFile)) {
      fs.unlinkSync(NodeRuntime.lockFile);
    }

    this.isStarted = false;
    NodeRuntime.instance = undefined;
  }
}
