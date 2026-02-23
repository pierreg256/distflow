import * as net from 'net';
import { EventEmitter } from 'events';
import { NodeInfo, Message, MessageType, RegisterPayload, PeerEvent } from './types';

/**
 * PMD configuration options
 */
export interface PMDOptions {
  port: number;
  ttl?: number; // Time-to-live in milliseconds
  cleanupInterval?: number; // Cleanup check interval
  autoShutdownDelay?: number; // Auto-shutdown delay when no nodes (milliseconds)
}

/**
 * Port Mapper Daemon - manages node registry and discovery
 */
export class PMD extends EventEmitter {
  private server: net.Server;
  private registry: Map<string, NodeInfo> = new Map();
  private aliasMap: Map<string, string> = new Map(); // alias -> nodeId
  private watchers: Set<net.Socket> = new Set();
  private nodeSockets: Map<string, net.Socket> = new Map(); // nodeId -> socket (persistent connection)
  private options: Required<PMDOptions>;
  private autoShutdownTimer?: NodeJS.Timeout;

  constructor(options: PMDOptions) {
    super();
    this.options = {
      port: options.port,
      ttl: options.ttl ?? 3000, // 3 seconds default
      cleanupInterval: options.cleanupInterval ?? 500, // 500ms default
      autoShutdownDelay: options.autoShutdownDelay ?? 30000 // 30 seconds default
    };

    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  /**
   * Start the PMD server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.options.port, () => {
        console.log(`PMD listening on port ${this.options.port}`);
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Stop the PMD server
   */
  async stop(): Promise<void> {
    if (this.autoShutdownTimer) {
      clearTimeout(this.autoShutdownTimer);
    }

    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('PMD stopped');
        resolve();
      });
    });
  }

  /**
   * Handle incoming TCP connection
   */
  private handleConnection(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    let associatedNodeId: string | undefined;

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Process complete messages (4 bytes length + JSON payload)
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);

        if (buffer.length >= 4 + length) {
          const messageData = buffer.slice(4, 4 + length);
          buffer = buffer.slice(4 + length);

          try {
            const message: Message = JSON.parse(messageData.toString('utf-8'));
            this.handleMessage(socket, message, (nodeId) => {
              // Callback to associate socket with nodeId on REGISTER
              associatedNodeId = nodeId;
            });
          } catch (err) {
            console.error('Failed to parse message:', err);
          }
        } else {
          break;
        }
      }
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err);
    });

    socket.on('close', () => {
      this.watchers.delete(socket);

      // If this socket was associated with a node, remove it immediately
      if (associatedNodeId) {
        console.log(`Node ${associatedNodeId} disconnected (socket closed)`);
        this.removeNode(associatedNodeId, 'socket_closed');
      }
    });
  }

  /**
   * Handle incoming message
   */
  private handleMessage(
    socket: net.Socket,
    message: Message,
    onAssociate?: (nodeId: string) => void
  ): void {
    switch (message.type) {
      case MessageType.REGISTER:
        this.handleRegister(socket, message, onAssociate);
        break;
      case MessageType.UNREGISTER:
        this.handleUnregister(socket, message);
        break;
      case MessageType.RESOLVE:
        this.handleResolve(socket, message);
        break;
      case MessageType.LIST:
        this.handleList(socket, message);
        break;
      case MessageType.HEARTBEAT:
        this.handleHeartbeat(socket, message);
        break;
      case MessageType.WATCH:
        this.handleWatch(socket, message);
        break;
      case MessageType.SHUTDOWN:
        this.handleShutdown(socket, message);
        break;
      default:
        this.sendResponse(socket, message.requestId, { error: 'Unknown message type' });
    }
  }

  /**
   * Register a new node
   */
  private handleRegister(
    socket: net.Socket,
    message: Message,
    onAssociate?: (nodeId: string) => void
  ): void {
    const payload = message.payload as RegisterPayload;

    const nodeInfo: NodeInfo = {
      nodeId: payload.nodeId,
      alias: payload.alias,
      host: payload.host,
      port: payload.port,
      lastHeartbeat: Date.now()
    };

    // Check for alias conflict
    if (payload.alias && this.aliasMap.has(payload.alias)) {
      const existingNodeId = this.aliasMap.get(payload.alias)!;
      if (existingNodeId !== payload.nodeId) {
        this.sendResponse(socket, message.requestId, {
          error: `Alias '${payload.alias}' already in use`
        });
        return;
      }
    }

    const isNew = !this.registry.has(payload.nodeId);
    this.registry.set(payload.nodeId, nodeInfo);

    // Associate socket with nodeId for persistent connection
    this.nodeSockets.set(payload.nodeId, socket);

    if (payload.alias) {
      this.aliasMap.set(payload.alias, payload.nodeId);
    }

    // Notify connection handler to track this nodeId
    if (onAssociate) {
      onAssociate(payload.nodeId);
    }

    // Cancel auto-shutdown if a node registers
    this.cancelAutoShutdown();

    this.sendResponse(socket, message.requestId, { success: true });

    // Notify watchers of new peer
    if (isNew) {
      this.notifyWatchers({
        event: 'peer:join',
        peer: nodeInfo
      });
    }
  }

  /**
   * Unregister a node
   */
  private handleUnregister(socket: net.Socket, message: Message): void {
    const { nodeId } = message.payload;

    if (this.registry.has(nodeId)) {
      this.removeNode(nodeId, 'unregister');
      this.sendResponse(socket, message.requestId, { success: true });
    } else {
      this.sendResponse(socket, message.requestId, { error: 'Node not found' });
    }
  }

  /**
   * Remove a node from registry (centralized method)
   */
  private removeNode(nodeId: string, reason: string): void {
    const nodeInfo = this.registry.get(nodeId);

    if (nodeInfo) {
      console.log(`Removing node ${nodeId} (reason: ${reason})`);

      this.registry.delete(nodeId);
      this.nodeSockets.delete(nodeId);

      if (nodeInfo.alias) {
        this.aliasMap.delete(nodeInfo.alias);
      }

      // Notify watchers
      this.notifyWatchers({
        event: 'peer:leave',
        peer: nodeInfo
      });

      // Check auto-shutdown
      this.checkAutoShutdown();
    }
  }

  /**
   * Resolve an alias to node info
   */
  private handleResolve(socket: net.Socket, message: Message): void {
    const { alias } = message.payload;

    // First try to resolve as alias
    let nodeId = this.aliasMap.get(alias);

    // If not found, check if it's a nodeId directly
    if (!nodeId && this.registry.has(alias)) {
      nodeId = alias;
    }

    if (nodeId) {
      const nodeInfo = this.registry.get(nodeId);
      this.sendResponse(socket, message.requestId, { node: nodeInfo });
    } else {
      this.sendResponse(socket, message.requestId, { error: 'Node not found' });
    }
  }

  /**
   * List all registered nodes
   */
  private handleList(socket: net.Socket, message: Message): void {
    const nodes = Array.from(this.registry.values());
    this.sendResponse(socket, message.requestId, { nodes });
  }

  /**
   * Update heartbeat for a node
   */
  private handleHeartbeat(socket: net.Socket, message: Message): void {
    const { nodeId } = message.payload;
    const nodeInfo = this.registry.get(nodeId);

    if (nodeInfo) {
      nodeInfo.lastHeartbeat = Date.now();
      this.sendResponse(socket, message.requestId, { success: true });
    } else {
      this.sendResponse(socket, message.requestId, { error: 'Node not found' });
    }
  }

  /**
   * Add socket as watcher for peer events
   */
  private handleWatch(socket: net.Socket, message: Message): void {
    this.watchers.add(socket);
    this.sendResponse(socket, message.requestId, { success: true });
  }

  /**
   * Handle shutdown request
   */
  private handleShutdown(socket: net.Socket, message: Message): void {
    this.sendResponse(socket, message.requestId, { success: true });

    // Give time for response to be sent before shutting down
    setTimeout(() => {
      console.log('Shutdown requested, stopping PMD...');
      this.stop().then(() => {
        process.exit(0);
      });
    }, 100);
  }

  /**
   * Send response message
   */
  private sendResponse(socket: net.Socket, requestId: string | undefined, payload: any): void {
    const message: Message = {
      type: MessageType.RESPONSE,
      requestId,
      payload
    };

    this.sendMessage(socket, message);
  }

  /**
   * Send message with length framing
   */
  private sendMessage(socket: net.Socket, message: Message): void {
    const json = JSON.stringify(message);
    const data = Buffer.from(json, 'utf-8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);

    socket.write(Buffer.concat([length, data]));
  }

  /**
   * Notify all watchers of peer event
   */
  private notifyWatchers(event: PeerEvent): void {
    const message: Message = {
      type: MessageType.EVENT,
      payload: event
    };

    this.watchers.forEach((socket) => {
      this.sendMessage(socket, message);
    });
  }

  /**
   * Check if auto-shutdown should be triggered
   */
  private checkAutoShutdown(): void {
    if (this.registry.size === 0 && !this.autoShutdownTimer) {
      console.log(`No nodes registered. PMD will auto-shutdown in ${this.options.autoShutdownDelay / 1000} seconds...`);
      this.autoShutdownTimer = setTimeout(() => {
        console.log('Auto-shutdown triggered (no nodes for 30 seconds)');
        this.stop().then(() => {
          process.exit(0);
        });
      }, this.options.autoShutdownDelay);
    }
  }

  /**
   * Cancel auto-shutdown timer
   */
  private cancelAutoShutdown(): void {
    if (this.autoShutdownTimer) {
      console.log('Auto-shutdown cancelled (node registered)');
      clearTimeout(this.autoShutdownTimer);
      this.autoShutdownTimer = undefined;
    }
  }

  /**
   * Get current registry snapshot
   */
  getRegistry(): NodeInfo[] {
    return Array.from(this.registry.values());
  }
}
