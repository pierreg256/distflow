import * as net from 'net';
import * as crypto from 'crypto';
import { MessageMetadata } from './mailbox';

/**
 * Node message for transport
 */
interface NodeMessage {
  from: string;
  to: string;
  payload: any;
  timestamp: number;
}

/**
 * TCP Transport - handles peer-to-peer communication
 */
export class Transport {
  private server?: net.Server;
  private connections: Map<string, net.Socket> = new Map();
  private buffer: Map<net.Socket, Buffer> = new Map();
  private messageHandler?: (message: any, meta: MessageMetadata) => void;
  private port?: number;

  /**
   * Start TCP server
   */
  async listen(port: number = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));

      this.server.listen(port, () => {
        const address = this.server!.address();
        if (typeof address === 'object' && address !== null) {
          this.port = address.port;
          resolve(address.port);
        } else {
          reject(new Error('Failed to get server port'));
        }
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Handle incoming connection
   */
  private handleConnection(socket: net.Socket): void {
    this.buffer.set(socket, Buffer.alloc(0));

    socket.on('data', (data) => {
      let buf = this.buffer.get(socket)!;
      buf = Buffer.concat([buf, data]);
      this.buffer.set(socket, buf);

      this.processBuffer(socket);
    });

    socket.on('error', (err) => {
      console.error('Transport socket error:', err);
    });

    socket.on('close', () => {
      this.buffer.delete(socket);
      // Remove from connections if stored
      for (const [nodeId, conn] of this.connections.entries()) {
        if (conn === socket) {
          this.connections.delete(nodeId);
          break;
        }
      }
    });
  }

  /**
   * Process buffer for complete messages
   */
  private processBuffer(socket: net.Socket): void {
    let buf = this.buffer.get(socket)!;

    while (buf.length >= 4) {
      const length = buf.readUInt32BE(0);

      if (buf.length >= 4 + length) {
        const messageData = buf.slice(4, 4 + length);
        buf = buf.slice(4 + length);
        this.buffer.set(socket, buf);

        try {
          const message: NodeMessage = JSON.parse(messageData.toString('utf-8'));
          if (this.messageHandler) {
            this.messageHandler(message.payload, {
              from: message.from,
              to: message.to,
              timestamp: message.timestamp
            });
          }
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      } else {
        break;
      }
    }
  }

  /**
   * Send message to a node
   */
  async send(host: string, port: number, fromNodeId: string, toNodeId: string, payload: any): Promise<void> {
    const socket = await this.getConnection(host, port);

    const message: NodeMessage = {
      from: fromNodeId,
      to: toNodeId,
      payload,
      timestamp: Date.now()
    };

    const json = JSON.stringify(message);
    const data = Buffer.from(json, 'utf-8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    socket.write(Buffer.concat([length, data]));
  }

  /**
   * Get or create connection to host:port
   */
  private async getConnection(host: string, port: number): Promise<net.Socket> {
    const key = `${host}:${port}`;
    
    let socket = this.connections.get(key);
    
    if (!socket || socket.destroyed) {
      socket = await this.connect(host, port);
      this.connections.set(key, socket);
      
      socket.on('close', () => {
        this.connections.delete(key);
      });
    }

    return socket;
  }

  /**
   * Connect to remote host
   */
  private async connect(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port }, () => {
        this.buffer.set(socket, Buffer.alloc(0));
        
        socket.on('data', (data) => {
          let buf = this.buffer.get(socket)!;
          buf = Buffer.concat([buf, data]);
          this.buffer.set(socket, buf);
          this.processBuffer(socket);
        });

        resolve(socket);
      });

      socket.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Register message handler
   */
  onMessage(handler: (message: any, meta: MessageMetadata) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Stop transport
   */
  async stop(): Promise<void> {
    // Close all connections
    for (const socket of this.connections.values()) {
      socket.end();
    }
    this.connections.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          resolve();
        });
      });
    }
  }

  /**
   * Get server port
   */
  getPort(): number | undefined {
    return this.port;
  }
}
