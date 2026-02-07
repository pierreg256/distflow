import crypto from 'crypto';
import { NodeRuntime, NodeRuntimeOptions } from './node-runtime';
import { JSONCrdt } from './json-crdt';
import { MessageMetadata } from './mailbox';

/**
 * Compute consistent hash for a node identifier
 * Uses SHA-256 and returns first 8 bytes as a number
 */
export function consistentHash(nodeId: string): number {
  const hash = crypto.createHash('sha256').update(nodeId).digest();
  // Use first 8 bytes as a 64-bit number (well, 53-bit safe integer in JS)
  return hash.readUInt32BE(0) * 0x100000000 + hash.readUInt32BE(4);
}

/**
 * Ring member information
 */
export interface RingMember {
  alias: string;
  nodeId: string;
  joinedAt: number;
  hash: number;
}

/**
 * Ring state stored in CRDT
 */
export interface RingState {
  members: Record<string, Omit<RingMember, 'hash'>>;
  token: {
    round: number;
    completedAt: number;
    completedBy: string;
  } | null;
}

/**
 * Ring neighbors
 */
export interface RingNeighbors {
  successor: RingMember | null;
  predecessor: RingMember | null;
  ring: RingMember[];
}

/**
 * Options for RingNode
 */
export interface RingNodeOptions {
  alias: string;
  syncIntervalMs?: number;
  displayIntervalMs?: number;
  nodeRuntimeOptions?: Partial<NodeRuntimeOptions>;
}

/**
 * Ring Node - maintains a ring topology with dynamic membership using CRDT
 * Nodes are ordered by consistent hash of their nodeId
 */
export class RingNode {
  protected alias: string;
  protected node: NodeRuntime | null = null;
  protected crdt: JSONCrdt | null = null;
  protected syncInterval: NodeJS.Timeout | null = null;
  protected displayInterval: NodeJS.Timeout | null = null;
  protected syncIntervalMs: number;
  protected displayIntervalMs: number;
  protected nodeRuntimeOptions: Partial<NodeRuntimeOptions>;

  constructor(options: RingNodeOptions) {
    this.alias = options.alias;
    this.syncIntervalMs = options.syncIntervalMs ?? 2000;
    this.displayIntervalMs = options.displayIntervalMs ?? 5000;
    this.nodeRuntimeOptions = options.nodeRuntimeOptions ?? {
      mailbox: {
        maxSize: 100,
        overflow: 'drop-newest'
      }
    };
  }

  async start(): Promise<void> {
    console.log(`[${this.alias}] Starting ring node...`);

    // Start the node runtime
    this.node = await NodeRuntime.start({
      alias: this.alias,
      ...this.nodeRuntimeOptions
    });

    // Initialize CRDT with this node's ID
    this.crdt = new JSONCrdt(this.node.getNodeId(), {
      members: {},
      token: null
    });

    // Add self to the ring
    this.addSelfToRing();

    // Listen for peer join/leave events
    this.node.on('peer:join', async (peer) => {
      console.log(`[${this.alias}] Peer joined: ${peer.alias || peer.nodeId}`);
      // No immediate action - will be added via CRDT sync
    });

    this.node.on('peer:leave', async (peer) => {
      console.log(`[${this.alias}] Peer left: ${peer.alias || peer.nodeId}`);
      // Remove from CRDT
      this.removeMemberFromRing(peer.nodeId);
    });

    // Listen for messages
    this.node.onMessage((message, meta) => {
      this.handleMessage(message, meta);
    });

    // Start periodic CRDT sync
    this.startCrdtSync();

    // Periodically display ring structure
    if (this.displayIntervalMs > 0) {
      this.displayInterval = setInterval(() => {
        this.displayRingStatus();
      }, this.displayIntervalMs);
    }
  }

  /**
   * Add self to the CRDT ring state
   */
  protected addSelfToRing(): void {
    if (!this.node || !this.crdt) return;

    this.crdt.set(['members', this.node.getNodeId()], {
      alias: this.alias,
      nodeId: this.node.getNodeId(),
      joinedAt: Date.now()
    });

    console.log(`[${this.alias}] 🔄 Added self to ring`);
    this.onTopologyChange();
  }

  /**
   * Remove a member from the CRDT ring state
   */
  protected removeMemberFromRing(nodeId: string): void {
    if (!this.crdt) return;

    const state = this.crdt.value() as unknown as RingState;
    if (!state) return;

    const members = state.members || {};

    if (members[nodeId]) {
      this.crdt.del(['members', nodeId]);
      console.log(`[${this.alias}] 🔄 Removed ${nodeId} from ring`);
      this.onTopologyChange();
    }
  }

  /**
   * Hook called when topology changes (can be overridden)
   */
  protected onTopologyChange(): void {
    // Override in subclasses if needed
  }

  /**
   * Start periodic CRDT sync with peers
   */
  protected startCrdtSync(): void {
    this.syncInterval = setInterval(async () => {
      await this.syncCrdtWithPeers();
    }, this.syncIntervalMs);
  }

  /**
   * Sync CRDT state with all peers
   */
  protected async syncCrdtWithPeers(): Promise<void> {
    if (!this.node || !this.crdt) return;

    try {
      const peers = await this.node.discover();
      const ringPeers = peers.filter(p => p.alias && p.alias.startsWith('ring-'));

      if (ringPeers.length === 0) return;

      // Send our vector clock and ops to all peers
      const clock = this.crdt.clock();

      for (const peer of ringPeers) {
        try {
          if (peer.alias) {
            await this.node.send(peer.alias, {
              type: 'CRDT_SYNC_REQUEST',
              clock: clock,
              from: this.alias,
              nodeId: this.node.getNodeId()
            });
          }
        } catch (err) {
          // Ignore send errors
        }
      }
    } catch (err) {
      // Ignore discovery errors
    }
  }

  /**
   * Get current ring members sorted by consistent hash
   */
  public getRingMembers(): RingMember[] {
    if (!this.crdt) return [];

    const state = this.crdt.value() as unknown as RingState;
    const members = state.members || {};

    return Object.values(members)
      .filter((m): m is Omit<RingMember, 'hash'> => !!m.alias && m.alias.startsWith('ring-'))
      .map(m => ({
        ...m,
        hash: consistentHash(m.nodeId)
      }))
      .sort((a, b) => {
        // Sort by hash value (ascending)
        if (a.hash !== b.hash) return a.hash - b.hash;
        // Tie-break on nodeId for stability
        return a.nodeId.localeCompare(b.nodeId);
      });
  }

  /**
   * Get successor and predecessor in the ring
   */
  public getRingNeighbors(): RingNeighbors {
    if (!this.node) {
      return { successor: null, predecessor: null, ring: [] };
    }

    const members = this.getRingMembers();

    if (members.length < 3) {
      return { successor: null, predecessor: null, ring: members };
    }

    const myIndex = members.findIndex(m => m.nodeId === this.node!.getNodeId());

    if (myIndex === -1) {
      return { successor: null, predecessor: null, ring: members };
    }

    const successorIndex = (myIndex + 1) % members.length;
    const predecessorIndex = (myIndex - 1 + members.length) % members.length;

    return {
      successor: members[successorIndex],
      predecessor: members[predecessorIndex],
      ring: members
    };
  }

  /**
   * Handle incoming messages
   */
  protected handleMessage(message: any, meta: MessageMetadata): void {
    switch (message.type) {
      case 'CRDT_SYNC_REQUEST':
        this.handleCrdtSyncRequest(message, meta);
        break;

      case 'CRDT_SYNC_RESPONSE':
        this.handleCrdtSyncResponse(message, meta);
        break;

      case 'CRDT_OP':
        this.handleCrdtOp(message, meta);
        break;

      case 'TOKEN':
        this.handleToken(message, meta);
        break;

      case 'PING':
        console.log(`[${this.alias}] 📨 PING from ${meta.from}`);
        this.node?.send(meta.from, { type: 'PONG', original: message }).catch(() => { });
        break;

      default:
        console.log(`[${this.alias}] 📨 Message from ${meta.from}:`, message);
    }
  }

  /**
   * Handle CRDT sync request
   */
  protected handleCrdtSyncRequest(message: any, meta: MessageMetadata): void {
    if (!this.node || !this.crdt) return;

    const remoteClock = message.clock;
    const myOps = this.crdt.diffSince(remoteClock);

    // Send back our ops that are newer
    this.node.send(meta.from, {
      type: 'CRDT_SYNC_RESPONSE',
      ops: myOps.map((op: any) => JSONCrdt.encodeOp(op)),
      clock: this.crdt.clock()
    }).catch(() => { });

    // Also ensure the remote node is in our members if they're a ring node
    if (message.nodeId && message.from && message.from.startsWith('ring-')) {
      const state = this.crdt.value() as unknown as RingState;
      const members = state.members || {};

      if (!members[message.nodeId]) {
        this.crdt.set(['members', message.nodeId], {
          alias: message.from,
          nodeId: message.nodeId,
          joinedAt: Date.now()
        });
        this.onTopologyChange();
      }
    }
  }

  /**
   * Handle CRDT sync response
   */
  protected handleCrdtSyncResponse(message: any, meta: MessageMetadata): void {
    if (!this.crdt) return;

    // Apply received ops to our CRDT
    const ops = message.ops.map((opStr: string) => JSONCrdt.decodeOp(opStr));

    let applied = 0;
    for (const op of ops) {
      if (this.crdt.receive(op)) {
        applied++;
      }
    }

    if (applied > 0) {
      console.log(`[${this.alias}] 🔄 Applied ${applied} CRDT ops from ${meta.from}`);
      this.onTopologyChange();
    }
  }

  /**
   * Handle individual CRDT op
   */
  protected handleCrdtOp(message: any, meta: MessageMetadata): void {
    if (!this.crdt) return;

    const op = JSONCrdt.decodeOp(message.op);
    const applied = this.crdt.receive(op);

    if (applied) {
      this.onTopologyChange();
      console.log(`[${this.alias}] 🔄 Applied CRDT op from ${meta.from}`);
    }
  }

  /**
   * Handle token passing in the ring
   */
  protected handleToken(message: any, meta: MessageMetadata): void {
    if (!this.node || !this.crdt) return;

    console.log(`[${this.alias}] 🎫 Token received from ${meta.from} (round ${message.round}, hop ${message.hop})`);

    const { ring } = this.getRingNeighbors();

    if (message.hop >= ring.length) {
      console.log(`[${this.alias}] ✅ Token completed round ${message.round}`);

      // Update token state in CRDT
      this.crdt.set(['token'], {
        round: message.round,
        completedAt: Date.now(),
        completedBy: this.alias
      });

      // Start new round
      setTimeout(() => {
        const { successor } = this.getRingNeighbors();
        if (successor && this.node) {
          console.log(`[${this.alias}] 🎫 Starting new token round ${message.round + 1}`);
          this.node.send(successor.alias, {
            type: 'TOKEN',
            round: message.round + 1,
            hop: 1,
            initiator: this.alias
          }).catch(() => { });
        }
      }, 2000);
    } else {
      // Pass token to successor
      setTimeout(() => {
        const { successor } = this.getRingNeighbors();
        if (successor && this.node) {
          console.log(`[${this.alias}] 🎫 Passing token to ${successor.alias}`);
          this.node.send(successor.alias, {
            type: 'TOKEN',
            round: message.round,
            hop: message.hop + 1,
            initiator: message.initiator
          }).catch(() => { });
        }
      }, 1000);
    }
  }

  /**
   * Display current ring status
   */
  public displayRingStatus(): void {
    if (!this.node || !this.crdt) return;

    const { ring } = this.getRingNeighbors();

    if (ring.length < 3) {
      console.log(`[${this.alias}] 📊 Status: Waiting for minimum 3 nodes (current: ${ring.length})`);
      return;
    }

    const ringOrder = ring.map((n) => {
      const hashStr = n.hash.toString(16).substring(0, 8);
      if (n.nodeId === this.node!.getNodeId()) {
        return `[${n.alias}@${hashStr}]`; // Mark self with brackets
      }
      return `${n.alias}@${hashStr}`;
    }).join(' → ');

    console.log(`[${this.alias}] 📊 Ring: ${ringOrder} → (cycle)`);

    // Display CRDT info
    const state = this.crdt.value() as unknown as RingState;
    const clock = this.crdt.clock();
    const clockStr = Object.entries(clock)
      .map(([id, v]) => `${id.slice(0, 8)}:${v}`)
      .join(', ');

    if (clockStr) {
      console.log(`[${this.alias}] 🕐 Vector Clock: {${clockStr}}`);
    }

    if (state.token) {
      console.log(`[${this.alias}] 🎫 Last token: round ${state.token.round} by ${state.token.completedBy}`);
    }
  }

  /**
   * Initiate a token in the ring (only if we're the first node)
   */
  public async initiateToken(): Promise<void> {
    if (!this.node) return;

    const { ring, successor } = this.getRingNeighbors();

    if (ring.length >= 3 && successor) {
      console.log(`[${this.alias}] 🎫 Initiating token in the ring`);
      await this.node.send(successor.alias, {
        type: 'TOKEN',
        round: 1,
        hop: 1,
        initiator: this.alias
      });
    }
  }

  /**
   * Get the underlying NodeRuntime instance
   */
  public getNode(): NodeRuntime | null {
    return this.node;
  }

  /**
   * Get the CRDT instance
   */
  public getCrdt(): JSONCrdt | null {
    return this.crdt;
  }

  /**
   * Get the alias of this node
   */
  public getAlias(): string {
    return this.alias;
  }

  /**
   * Stop the ring node
   */
  async stop(): Promise<void> {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.displayInterval) {
      clearInterval(this.displayInterval);
      this.displayInterval = null;
    }
    if (this.node) {
      await this.node.shutdown();
      this.node = null;
    }
  }
}
