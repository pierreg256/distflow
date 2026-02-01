import * as net from 'net';

/**
 * Node registration entry in the PMD registry
 */
export interface NodeInfo {
  nodeId: string;
  alias?: string;
  host: string;
  port: number;
  lastHeartbeat: number;
}

/**
 * PMD protocol message types
 */
export enum MessageType {
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
export interface Message {
  type: MessageType;
  payload: any;
  requestId?: string;
}

/**
 * PMD Client - communicates with the PMD daemon
 */
export class PMDClient {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingRequests: Map<string, (response: any) => void> = new Map();
  private eventHandlers: Map<string, Array<(data: any) => void>> = new Map();
  private requestCounter = 0;
  private readonly host: string;
  private readonly port: number;

  constructor(host: string = 'localhost', port: number = 4369) {
    this.host = host;
    this.port = port;
  }

  /**
   * Connect to PMD
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.setupSocketHandlers();
        resolve();
      });

      this.socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });

    this.socket.on('error', (err) => {
      console.error('PMD socket error:', err);
    });

    this.socket.on('close', () => {
      console.log('PMD connection closed');
    });
  }

  /**
   * Process incoming data buffer
   */
  private processBuffer(): void {
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);

      if (this.buffer.length >= 4 + length) {
        const messageData = this.buffer.slice(4, 4 + length);
        this.buffer = this.buffer.slice(4 + length);

        try {
          const message: Message = JSON.parse(messageData.toString('utf-8'));
          this.handleMessage(message);
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      } else {
        break;
      }
    }
  }

  /**
   * Handle incoming message
   */
  private handleMessage(message: Message): void {
    if (message.type === MessageType.RESPONSE && message.requestId) {
      const handler = this.pendingRequests.get(message.requestId);
      if (handler) {
        handler(message.payload);
        this.pendingRequests.delete(message.requestId);
      }
    } else if (message.type === MessageType.EVENT) {
      const { event, peer } = message.payload;
      const handlers = this.eventHandlers.get(event) || [];
      handlers.forEach(h => h(peer));
    }
  }

  /**
   * Send message to PMD
   */
  private async sendMessage(type: MessageType, payload: any): Promise<any> {
    if (!this.socket) {
      throw new Error('Not connected to PMD');
    }

    const requestId = `req_${++this.requestCounter}`;

    const message: Message = {
      type,
      payload,
      requestId
    };

    return new Promise((resolve, reject) => {
      const json = JSON.stringify(message);
      const data = Buffer.from(json, 'utf-8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length, 0);

      this.pendingRequests.set(requestId, resolve);

      this.socket!.write(Buffer.concat([length, data]), (err) => {
        if (err) {
          this.pendingRequests.delete(requestId);
          reject(err);
        }
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error('Request timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Register node with PMD
   */
  async register(nodeId: string, alias: string | undefined, host: string, port: number): Promise<void> {
    const response = await this.sendMessage(MessageType.REGISTER, {
      nodeId,
      alias,
      host,
      port
    });

    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Unregister node from PMD
   */
  async unregister(nodeId: string): Promise<void> {
    const response = await this.sendMessage(MessageType.UNREGISTER, { nodeId });

    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Resolve alias to node info
   */
  async resolve(alias: string): Promise<any> {
    const response = await this.sendMessage(MessageType.RESOLVE, { alias });

    if (response.error) {
      throw new Error(response.error);
    }

    return response.node;
  }

  /**
   * List all registered nodes
   */
  async list(): Promise<any[]> {
    const response = await this.sendMessage(MessageType.LIST, {});
    return response.nodes || [];
  }

  /**
   * Send heartbeat
   */
  async heartbeat(nodeId: string): Promise<void> {
    const response = await this.sendMessage(MessageType.HEARTBEAT, { nodeId });

    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Watch for peer events
   */
  async watch(): Promise<void> {
    const response = await this.sendMessage(MessageType.WATCH, {});

    if (response.error) {
      throw new Error(response.error);
    }
  }

  /**
   * Register event handler
   */
  on(event: string, handler: (data: any) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(handler);
  }

  /**
   * Disconnect from PMD
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = undefined;
    }
  }
}
