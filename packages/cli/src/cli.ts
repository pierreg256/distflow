#!/usr/bin/env node

import * as net from 'net';

/**
 * PMD protocol message types
 */
enum MessageType {
  REGISTER = 'register',
  UNREGISTER = 'unregister',
  RESOLVE = 'resolve',
  LIST = 'list',
  HEARTBEAT = 'heartbeat',
  WATCH = 'watch',
  RESPONSE = 'response',
  EVENT = 'event'
}

/**
 * Base message structure
 */
interface Message {
  type: MessageType;
  payload: any;
  requestId?: string;
}

/**
 * PMD CLI Client
 */
class PMDCLIClient {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private requestCounter = 0;

  async connect(host: string = 'localhost', port: number = 4369): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host, port }, () => {
        this.setupSocket();
        resolve();
      });

      this.socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  private setupSocket(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
    });
  }

  async sendRequest(type: MessageType, payload: any): Promise<any> {
    if (!this.socket) {
      throw new Error('Not connected');
    }

    const requestId = `req_${++this.requestCounter}`;
    const message: Message = { type, payload, requestId };

    const json = JSON.stringify(message);
    const data = Buffer.from(json, 'utf-8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    this.socket.write(Buffer.concat([length, data]));

    // Wait for response
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, 5000);

      const checkBuffer = () => {
        if (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32BE(0);

          if (this.buffer.length >= 4 + length) {
            const messageData = this.buffer.slice(4, 4 + length);
            this.buffer = this.buffer.slice(4 + length);

            try {
              const response: Message = JSON.parse(messageData.toString('utf-8'));
              if (response.requestId === requestId) {
                clearTimeout(timeout);
                resolve(response.payload);
                return;
              }
            } catch (err) {
              clearTimeout(timeout);
              reject(err);
              return;
            }
          }
        }

        setTimeout(checkBuffer, 100);
      };

      checkBuffer();
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
    }
  }
}

/**
 * CLI Commands
 */
async function pmdStatus(port: number): Promise<void> {
  try {
    const client = new PMDCLIClient();
    await client.connect('localhost', port);
    
    const nodes = await client.sendRequest(MessageType.LIST, {});
    
    console.log('PMD Status:');
    console.log(`  Port: ${port}`);
    console.log(`  Registered nodes: ${nodes.nodes.length}`);
    
    client.disconnect();
  } catch (err) {
    console.error('PMD not running or unreachable');
    process.exit(1);
  }
}

async function pmdList(port: number): Promise<void> {
  try {
    const client = new PMDCLIClient();
    await client.connect('localhost', port);
    
    const response = await client.sendRequest(MessageType.LIST, {});
    const nodes = response.nodes || [];
    
    console.log('Registered nodes:');
    if (nodes.length === 0) {
      console.log('  (none)');
    } else {
      nodes.forEach((node: any) => {
        console.log(`  - ${node.alias || node.nodeId}`);
        console.log(`    Node ID: ${node.nodeId}`);
        console.log(`    Address: ${node.host}:${node.port}`);
        console.log(`    Last heartbeat: ${new Date(node.lastHeartbeat).toISOString()}`);
      });
    }
    
    client.disconnect();
  } catch (err) {
    console.error('Failed to list nodes:', err);
    process.exit(1);
  }
}

async function pmdResolve(alias: string, port: number): Promise<void> {
  try {
    const client = new PMDCLIClient();
    await client.connect('localhost', port);
    
    const response = await client.sendRequest(MessageType.RESOLVE, { alias });
    
    if (response.error) {
      console.error(`Alias '${alias}' not found`);
      process.exit(1);
    }
    
    const node = response.node;
    console.log(`Resolved '${alias}':`);
    console.log(`  Node ID: ${node.nodeId}`);
    console.log(`  Address: ${node.host}:${node.port}`);
    
    client.disconnect();
  } catch (err) {
    console.error('Failed to resolve alias:', err);
    process.exit(1);
  }
}

async function pmdKill(_port: number): Promise<void> {
  console.log('Kill command not implemented yet');
  console.log('Please manually stop the PMD process');
}

function showHelp(): void {
  console.log('distflow CLI');
  console.log('');
  console.log('Usage:');
  console.log('  distflow pmd status [--port PORT]');
  console.log('  distflow pmd list [--port PORT]');
  console.log('  distflow pmd resolve <alias> [--port PORT]');
  console.log('  distflow pmd kill [--port PORT]');
  console.log('  distflow node info');
  console.log('');
  console.log('Options:');
  console.log('  --port PORT    PMD port (default: 4369)');
}

/**
 * Main CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    showHelp();
    return;
  }

  let port = 4369;

  // Parse port option
  const portIndex = args.indexOf('--port');
  if (portIndex !== -1 && portIndex + 1 < args.length) {
    port = parseInt(args[portIndex + 1], 10);
  }

  const command = args[0];
  const subcommand = args[1];

  if (command === 'pmd') {
    switch (subcommand) {
      case 'status':
        await pmdStatus(port);
        break;
      case 'list':
        await pmdList(port);
        break;
      case 'resolve':
        if (args.length < 3) {
          console.error('Usage: distflow pmd resolve <alias>');
          process.exit(1);
        }
        await pmdResolve(args[2], port);
        break;
      case 'kill':
        await pmdKill(port);
        break;
      default:
        console.error(`Unknown pmd command: ${subcommand}`);
        showHelp();
        process.exit(1);
    }
  } else if (command === 'node') {
    if (subcommand === 'info') {
      console.log('Node info command not implemented yet');
    } else {
      console.error(`Unknown node command: ${subcommand}`);
      showHelp();
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    showHelp();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
