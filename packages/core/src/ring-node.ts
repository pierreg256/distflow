import crypto from 'crypto';
import { EventEmitter } from 'events';
import { NodeRuntime, NodeRuntimeOptions } from './node-runtime';
import { JSONCrdt, CrdtOptions } from './json-crdt';
import { MessageMetadata } from './mailbox';
import { configureLogger, getLogger, LogLevel,  } from './logger';

const logger = configureLogger({ name: 'ring-node', level: LogLevel.INFO });

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
  successorList: RingMember[]; // List of R successors for fault tolerance
  ring: RingMember[];
}

/**
 * Stability information
 */
export interface RingStabilityInfo {
  isStable: boolean;
  memberCount: number;
  replicationFactor: number;
  lastTopologyChangeMs: number;
  timeSinceLastChangeMs: number;
  requiredStableTimeMs: number;
}

/**
 * Options for RingNode
 */
export interface RingNodeOptions {
  alias: string;
  syncIntervalMs?: number;
  displayIntervalMs?: number;
  metricsIntervalMs?: number;
  stabilizeIntervalMs?: number;
  successorListSize?: number; // Number of successors to maintain (default: 3)
  replicationFactor?: number; // Number of replicas/minimum nodes for stability (default: 3)
  stabilityCheckIntervalMs?: number; // How often to check for stability (default: 1000)
  requiredStableTimeMs?: number; // Time without changes to be considered stable (default: 5000)
  nodeRuntimeOptions?: Partial<NodeRuntimeOptions>;
  crdtOptions?: CrdtOptions;
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
  protected metricsInterval: NodeJS.Timeout | null = null;
  protected stabilizeInterval: NodeJS.Timeout | null = null;
  protected stabilityCheckInterval: NodeJS.Timeout | null = null;
  protected syncIntervalMs: number;
  protected displayIntervalMs: number;
  protected metricsIntervalMs: number;
  protected stabilizeIntervalMs: number;
  protected stabilityCheckIntervalMs: number;
  protected requiredStableTimeMs: number;
  protected successorListSize: number;
  protected replicationFactor: number;

  // Stability tracking
  protected events: EventEmitter = new EventEmitter();
  protected lastTopologyChange: number = Date.now();
  protected previousMemberCount: number = 0;
  protected currentlyStable: boolean = false;
  protected nodeRuntimeOptions: Partial<NodeRuntimeOptions>;
  protected crdtOptions: CrdtOptions;

  // DHT storage: key -> value
  protected storage: Map<string, any> = new Map();

  // Pending requests for async request/response pattern
  protected pendingRequests: Map<string, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  protected requestIdCounter = 0;

  constructor(options: RingNodeOptions) {
    this.alias = options.alias;
    this.syncIntervalMs = options.syncIntervalMs ?? 2000;
    this.displayIntervalMs = options.displayIntervalMs ?? 5000;
    this.metricsIntervalMs = options.metricsIntervalMs ?? 10000;
    this.stabilizeIntervalMs = options.stabilizeIntervalMs ?? 10000;
    this.stabilityCheckIntervalMs = options.stabilityCheckIntervalMs ?? 1000;
    this.requiredStableTimeMs = options.requiredStableTimeMs ?? 5000;
    this.successorListSize = options.successorListSize ?? 3;
    this.replicationFactor = options.replicationFactor ?? 3;
    this.nodeRuntimeOptions = options.nodeRuntimeOptions ?? {
      mailbox: {
        maxSize: 100,
        overflow: 'drop-newest'
      }
    };
    this.crdtOptions = options.crdtOptions ?? {
      maxLogSize: 500,
      maxPendingSize: 1000,
      enableAutoGc: true,
      tombstoneGracePeriodMs: 3600000
    };
  }

  async start(): Promise<void> {
    const logger = getLogger('start');
    logger.info('Starting ring node', { alias: this.alias });

    // Start the node runtime
    this.node = await NodeRuntime.start({
      alias: this.alias,
      ...this.nodeRuntimeOptions
    });

    // Initialize CRDT with this node's ID and options
    this.crdt = new JSONCrdt(
      this.node.getNodeId(),
      { members: {}, token: null },
      this.crdtOptions
    );

    // Setup CRDT event listeners
    this.setupCrdtEventListeners();

    // Add self to the ring
    this.addSelfToRing();

    // Listen for peer join/leave events
    this.node.on('peer:join', async (peer) => {
      logger.info('Peer joined', { alias: this.alias, peer: peer.alias || peer.nodeId });
      // No immediate action - will be added via CRDT sync
    });

    this.node.on('peer:leave', async (peer) => {
      logger.info('Peer left', { alias: this.alias, peer: peer.alias || peer.nodeId });
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

    // Periodically display CRDT metrics
    if (this.metricsIntervalMs > 0) {
      this.metricsInterval = setInterval(() => {
        this.displayCrdtMetrics();
      }, this.metricsIntervalMs);
    }

    // Start periodic stabilization
    if (this.stabilizeIntervalMs > 0) {
      this.stabilizeInterval = setInterval(() => {
        this.stabilize();
      }, this.stabilizeIntervalMs);
    }

    // Start stability checking
    this.startStabilityCheck();
  }

  /**
   * Setup CRDT event listeners for observability
   */
  protected setupCrdtEventListeners(): void {
    if (!this.crdt) return;

    // Listen for state changes
    this.crdt.on('change', ({ type, path, value }) => {
      logger.debug('CRDT change', {
        alias: this.alias,
        changeType: type,
        path: JSON.stringify(path),
        hasValue: value !== undefined
      });
    });

    // Listen for conflicts
    this.crdt.on('conflict', (conflict) => {
      logger.warn('CRDT conflict detected', {
        alias: this.alias,
        conflictType: conflict.type,
        path: JSON.stringify(conflict.path)
      });
    });

    // Listen for GC events
    this.crdt.on('gc', ({ type, removed, currentSize }) => {
      logger.debug('CRDT garbage collection', {
        alias: this.alias,
        gcType: type,
        removed,
        currentSize
      });
    });

    // Listen for restore events
    this.crdt.on('restore', () => {
      logger.info('CRDT snapshot restored', { alias: this.alias });
    });
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

    logger.info('Added self to ring', { alias: this.alias, nodeId: this.node.getNodeId().substring(0, 8) });
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
      logger.info('Removed member from ring', { alias: this.alias, removedNodeId: nodeId.substring(0, 8) });
      this.onTopologyChange();
    }
  }

  /**
   * Hook called when topology changes (cannot be overridden)
   */
  private onTopologyChange(): void {
    const currentMemberCount = this.getMemberCount();
    // Only consider it a real topology change if member count changed
    if (currentMemberCount !== this.previousMemberCount) {
      this.lastTopologyChange = Date.now();
      this.previousMemberCount = currentMemberCount;
      this.events.emit('ring:topology-change', this.getStabilityInfo());

      // If was stable, mark as unstable now
      if (this.currentlyStable) {
        this.currentlyStable = false;
        this.events.emit('ring:unstable', this.getStabilityInfo());
        logger.info('Ring became unstable', {
          alias: this.alias,
          memberCount: currentMemberCount
        });
      }
    }


  }

  /**
   * Start periodic stability check
   */
  protected startStabilityCheck(): void {
    this.stabilityCheckInterval = setInterval(() => {
      this.checkStability();
    }, this.stabilityCheckIntervalMs);
  }

  /**
   * Check if ring is stable and emit events if state changes
   */
  protected checkStability(): void {
    const info = this.getStabilityInfo();

    // Transition from unstable to stable
    if (!this.currentlyStable && info.isStable) {
      this.currentlyStable = true;
      this.events.emit('ring:stable', info);
      logger.info('Ring became stable', {
        alias: this.alias,
        memberCount: info.memberCount,
        timeSinceChange: info.timeSinceLastChangeMs
      });
    }
    // Transition from stable to unstable is handled in onTopologyChange()
  }

  /**
   * Get current stability information
   */
  public getStabilityInfo(): RingStabilityInfo {
    const now = Date.now();
    const timeSinceLastChange = now - this.lastTopologyChange;
    const memberCount = this.getMemberCount();
    const hasEnoughNodes = memberCount >= this.replicationFactor;
    const hasStableTime = timeSinceLastChange >= this.requiredStableTimeMs;
    const isStable = hasEnoughNodes && hasStableTime;

    return {
      isStable,
      memberCount,
      replicationFactor: this.replicationFactor,
      lastTopologyChangeMs: this.lastTopologyChange,
      timeSinceLastChangeMs: timeSinceLastChange,
      requiredStableTimeMs: this.requiredStableTimeMs
    };
  }

  /**
   * Check if ring is currently stable
   */
  public isStable(): boolean {
    return this.getStabilityInfo().isStable;
  }

  /**
   * Get number of members in the ring
   */
  public getMemberCount(): number {
    if (!this.crdt) return 0;
    const state = this.crdt.value() as unknown as RingState;
    return Object.keys(state?.members || {}).length;
  }

  /**
   * Subscribe to ring events
   * Events: 'ring:stable', 'ring:unstable'
   */
  public on(event: string, listener: (...args: any[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  /**
   * Unsubscribe from ring events
   */
  public off(event: string, listener: (...args: any[]) => void): this {
    this.events.off(event, listener);
    return this;
  }

  /**
   * Subscribe once to ring events
   */
  public once(event: string, listener: (...args: any[]) => void): this {
    this.events.once(event, listener);
    return this;
  }

  /**
   * Wait for ring to become stable (returns a Promise)
   */
  public async waitForStable(timeoutMs: number = 30000): Promise<RingStabilityInfo> {
    // If already stable, return immediately
    if (this.isStable()) {
      return this.getStabilityInfo();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.events.off('ring:stable', onStable);
        reject(new Error(`Ring did not stabilize within ${timeoutMs}ms`));
      }, timeoutMs);

      const onStable = (info: RingStabilityInfo) => {
        clearTimeout(timeout);
        resolve(info);
      };

      this.events.once('ring:stable', onStable);
    });
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
      return { successor: null, predecessor: null, successorList: [], ring: [] };
    }

    const members = this.getRingMembers();

    if (members.length < 3) {
      return { successor: null, predecessor: null, successorList: [], ring: members };
    }

    const myIndex = members.findIndex(m => m.nodeId === this.node!.getNodeId());

    if (myIndex === -1) {
      return { successor: null, predecessor: null, successorList: [], ring: members };
    }

    const successorIndex = (myIndex + 1) % members.length;
    const predecessorIndex = (myIndex - 1 + members.length) % members.length;

    // Build successor list (R successors for fault tolerance)
    const successorList: RingMember[] = [];
    for (let i = 1; i <= this.successorListSize && i < members.length; i++) {
      const idx = (myIndex + i) % members.length;
      successorList.push(members[idx]!);
    }

    return {
      successor: members[successorIndex],
      predecessor: members[predecessorIndex],
      successorList,
      ring: members
    };
  }

  /**
   * Find the node responsible for a given key
   */
  public findResponsibleNode(key: string): RingMember | null {
    const keyHash = consistentHash(key);
    const members = this.getRingMembers();

    if (members.length === 0) return null;

    // Find the first node whose hash is >= keyHash
    // If none found, wrap around to the first node
    for (const member of members) {
      if (member.hash >= keyHash) {
        return member;
      }
    }

    // Wrap around to the first node
    return members[0] || null;
  }

  /**
   * Store a key-value pair in the DHT
   */
  public async put(key: string, value: any): Promise<void> {
    const responsible = this.findResponsibleNode(key);

    if (!responsible || !this.node) {
      throw new Error('Ring not ready or no responsible node found');
    }

    // If we're responsible, store locally
    if (responsible.nodeId === this.node.getNodeId()) {
      this.storage.set(key, value);
      logger.debug('Stored key locally', {
        alias: this.alias,
        key,
        valueType: typeof value
      });
      return;
    }

    // Otherwise, forward to responsible node
    try {
      await this.node.send(responsible.alias, {
        type: 'DHT_PUT',
        key,
        value,
        from: this.alias
      });

      logger.debug('Forwarded PUT to responsible node', {
        alias: this.alias,
        key,
        responsibleNode: responsible.alias
      });
    } catch (err) {
      logger.error('Failed to forward PUT', {
        alias: this.alias,
        key,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }

  /**
   * Retrieve a value from the DHT
   */
  public async get(key: string): Promise<any> {
    const responsible = this.findResponsibleNode(key);

    if (!responsible || !this.node) {
      throw new Error('Ring not ready or no responsible node found');
    }

    // If we're responsible, return local value
    if (responsible.nodeId === this.node.getNodeId()) {
      const value = this.storage.get(key);
      logger.debug('Retrieved key locally', {
        alias: this.alias,
        key,
        found: value !== undefined
      });
      return value;
    }

    // Otherwise, ask responsible node (async request/response pattern)
    return new Promise((resolve, reject) => {
      const requestId = this.generateRequestId();

      // Set up timeout
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`DHT GET timeout for key ${key}`));
      }, 5000);

      // Store pending request
      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request (fire and forget)
      this.node!.send(responsible.alias, {
        type: 'DHT_GET',
        key,
        requestId,
        from: this.alias
      }).catch((err) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(err);
      });

      logger.debug('Sent DHT GET request', {
        alias: this.alias,
        key,
        requestId,
        responsibleNode: responsible.alias
      });
    });
  }

  /**
   * Verify and correct successor pointers (Chord stabilization)
   */
  protected async stabilize(): Promise<void> {
    if (!this.node) return;

    const { successor } = this.getRingNeighbors();

    if (!successor) {
      logger.debug('No successor to stabilize', { alias: this.alias });
      return;
    }

    // Create promise for stabilization response
    const requestId = this.generateRequestId();

    const stabilizePromise = new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Stabilization request timeout'));
      }, 5000);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send stabilization request (fire and forget)
      this.node!.send(successor.alias, {
        type: 'STABILIZE_REQUEST',
        requestId,
        from: this.alias,
        nodeId: this.node!.getNodeId()
      }).catch((err) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(err);
      });
    });

    try {
      const response = await stabilizePromise;

      // If successor has a predecessor between us and it, that should be our successor
      if (response?.predecessor) {
        const pred = response.predecessor as RingMember;
        const myHash = consistentHash(this.node.getNodeId());
        const succHash = successor.hash;
        const predHash = pred.hash;

        // Check if pred is between us and successor in the ring
        const isBetween = (myHash < succHash && predHash > myHash && predHash < succHash) ||
          (myHash > succHash && (predHash > myHash || predHash < succHash));

        if (isBetween) {
          logger.debug('Found better successor during stabilization', {
            alias: this.alias,
            oldSuccessor: successor.alias,
            newSuccessor: pred.alias
          });
        }
      }

      // Notify successor that we think we are its predecessor
      await this.notify(successor);

    } catch (err) {
      logger.warn('Stabilization failed', {
        alias: this.alias,
        successor: successor.alias,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Notify a node that we think we are its predecessor
   */
  protected async notify(node: RingMember): Promise<void> {
    if (!this.node) return;

    try {
      await this.node.send(node.alias, {
        type: 'NOTIFY',
        from: this.alias,
        nodeId: this.node.getNodeId(),
        hash: consistentHash(this.node.getNodeId())
      });

      logger.debug('Sent notify to node', {
        alias: this.alias,
        target: node.alias
      });
    } catch (err) {
      // Ignore notify errors - not critical
    }
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

      case 'DHT_PUT':
        this.handleDhtPut(message, meta);
        break;

      case 'DHT_GET':
        this.handleDhtGet(message, meta);
        break;

      case 'STABILIZE_REQUEST':
        this.handleStabilizeRequest(message, meta);
        break;

      case 'NOTIFY':
        this.handleNotify(message, meta);
        break;

      case 'DHT_GET_RESPONSE':
        this.handleDhtGetResponse(message, meta);
        break;

      case 'STABILIZE_RESPONSE':
        this.handleStabilizeResponse(message, meta);
        break;

      case 'PING':
        logger.debug('PING received', { alias: this.alias, from: meta.from });
        this.node?.send(meta.from, { type: 'PONG', original: message }).catch(() => { });
        break;

      default:
        logger.debug('Message received', { alias: this.alias, from: meta.from, type: message.type });
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
      logger.debug('Applied CRDT ops', { alias: this.alias, from: meta.from, count: applied });
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
      logger.debug('Applied single CRDT op', { alias: this.alias, from: meta.from });
    }
  }

  /**
   * Handle token passing in the ring
   */
  protected handleToken(message: any, meta: MessageMetadata): void {
    if (!this.node || !this.crdt) return;

    logger.info('Token received', {
      alias: this.alias,
      from: meta.from,
      round: message.round,
      hop: message.hop
    });

    const { ring } = this.getRingNeighbors();

    if (message.hop >= ring.length) {
      logger.info('Token completed round', { alias: this.alias, round: message.round });

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
          logger.info('Starting new token round', { alias: this.alias, round: message.round + 1 });
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
          logger.debug('Passing token', { alias: this.alias, to: successor.alias });
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
   * Handle DHT PUT request
   */
  protected handleDhtPut(message: any, meta: MessageMetadata): void {
    const { key, value } = message;

    this.storage.set(key, value);

    logger.debug('Stored key from remote node', {
      alias: this.alias,
      key,
      from: meta.from
    });

    // Send acknowledgment
    if (this.node) {
      this.node.send(meta.from, {
        type: 'DHT_PUT_ACK',
        key,
        success: true
      }).catch(() => { });
    }
  }

  /**
   * Handle DHT GET request
   */
  protected handleDhtGet(message: any, meta: MessageMetadata): void {
    const { key, requestId } = message;
    const value = this.storage.get(key);

    logger.debug('Retrieved key for remote node', {
      alias: this.alias,
      key,
      requestId,
      from: meta.from,
      found: value !== undefined
    });

    // Send response with requestId
    if (this.node) {
      this.node.send(meta.from, {
        type: 'DHT_GET_RESPONSE',
        requestId,
        key,
        value,
        found: value !== undefined
      }).catch(() => { });
    }
  }

  /**
   * Handle DHT GET response
   */
  protected handleDhtGetResponse(message: any, _meta: MessageMetadata): void {
    const { requestId, value } = message;

    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      pending.resolve(value);

      logger.debug('DHT GET response received', {
        alias: this.alias,
        requestId,
        found: value !== undefined
      });
    }
  }

  /**
   * Handle stabilization request
   */
  protected handleStabilizeRequest(message: any, meta: MessageMetadata): void {
    const { requestId } = message;
    const { predecessor } = this.getRingNeighbors();

    if (this.node) {
      this.node.send(meta.from, {
        type: 'STABILIZE_RESPONSE',
        requestId,
        predecessor: predecessor || null
      }).catch(() => { });
    }
  }

  /**
   * Handle stabilization response
   */
  protected handleStabilizeResponse(message: any, _meta: MessageMetadata): void {
    const { requestId, predecessor } = message;

    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(requestId);
      pending.resolve({ predecessor });

      logger.debug('Stabilization response received', {
        alias: this.alias,
        requestId,
        hasPredecessor: predecessor !== null
      });
    }
  }

  /**
   * Handle notify from potential predecessor
   */
  protected handleNotify(message: any, meta: MessageMetadata): void {
    if (!this.node) return;

    const { hash } = message;
    const { predecessor } = this.getRingNeighbors();

    // If we don't have a predecessor, or the notifying node is between
    // our current predecessor and us, update our predecessor
    if (!predecessor) {
      logger.debug('Accepted new predecessor (no previous)', {
        alias: this.alias,
        newPredecessor: meta.from
      });
      return;
    }

    const myHash = consistentHash(this.node.getNodeId());
    const predHash = predecessor.hash;

    // Check if notifying node is between predecessor and us
    const isBetween = (predHash < myHash && hash > predHash && hash < myHash) ||
      (predHash > myHash && (hash > predHash || hash < myHash));

    if (isBetween) {
      logger.debug('Updated predecessor via notify', {
        alias: this.alias,
        oldPredecessor: predecessor.alias,
        newPredecessor: meta.from
      });
    }
  }

  /**
   * Display current ring status
   */
  public displayRingStatus(): void {
    if (!this.node || !this.crdt) return;

    const { ring } = this.getRingNeighbors();

    if (ring.length < this.replicationFactor) {
      logger.info('Ring status: waiting for minimum nodes', {
        alias: this.alias,
        current: ring.length,
        minimum: this.replicationFactor
      });
      return;
    }

    const ringOrder = ring.map((n) => {
      const hashStr = n.hash.toString(16).substring(0, 8);
      if (n.nodeId === this.node!.getNodeId()) {
        return `[${n.alias}@${hashStr}]`; // Mark self with brackets
      }
      return `${n.alias}@${hashStr}`;
    }).join(' → ');

    logger.info('Ring topology', {
      alias: this.alias,
      ring: ringOrder + ' → (cycle)'
    });

    // Display CRDT info
    const state = this.crdt.value() as unknown as RingState;
    const clock = this.crdt.clock();
    const clockStr = Object.entries(clock)
      .map(([id, v]) => `${id.slice(0, 8)}:${v}`)
      .join(', ');

    if (clockStr) {
      logger.info('Vector clock', {
        alias: this.alias,
        clock: clockStr
      });
    }

    if (state.token) {
      logger.info('Token state', {
        alias: this.alias,
        round: state.token.round,
        completedBy: state.token.completedBy
      });
    }
  }

  /**
   * Display CRDT metrics for observability
   */
  protected displayCrdtMetrics(): void {
    if (!this.crdt) return;

    const metrics = this.crdt.getMetrics();

    logger.info('CRDT metrics', {
      alias: this.alias,
      totalOps: metrics.totalOps,
      localOps: metrics.localOps,
      remoteOps: metrics.remoteOps,
      opsPerSec: metrics.opsPerSecond.toFixed(2),
      avgLatency: metrics.avgLatencyMs.toFixed(2) + 'ms',
      conflicts: metrics.totalConflicts,
      logSize: metrics.logSize,
      pendingSize: metrics.pendingSize,
      gcRuns: metrics.gcRuns
    });
  }

  /**
   * Get CRDT inspection data for debugging
   */
  public inspectCrdt(): any {
    if (!this.crdt) return null;

    return this.crdt.inspect({
      logSampleSize: 10,
      pendingSampleSize: 5,
      includeCausalGraph: true
    });
  }

  /**
   * Manually trigger CRDT garbage collection
   */
  public gcCrdt(): void {
    if (!this.crdt) return;

    logger.info('Manual CRDT GC triggered', { alias: this.alias });
    this.crdt.gcLog();
    this.crdt.gcTombstones();
    this.crdt.cleanPendingBuffer();
  }

  /**
   * Initiate a token in the ring (only if we're the first node)
   */
  public async initiateToken(): Promise<void> {
    if (!this.node) return;

    const { ring, successor } = this.getRingNeighbors();

    if (ring.length >= 3 && successor) {
      logger.info('Initiating token in ring', { alias: this.alias, ringSize: ring.length });
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
    logger.info('Stopping ring node', { alias: this.alias });

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.displayInterval) {
      clearInterval(this.displayInterval);
      this.displayInterval = null;
    }
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
    if (this.stabilizeInterval) {
      clearInterval(this.stabilizeInterval);
      this.stabilizeInterval = null;
    }
    if (this.stabilityCheckInterval) {
      clearInterval(this.stabilityCheckInterval);
      this.stabilityCheckInterval = null;
    }

    // Clean up pending requests
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Node stopped'));
    }
    this.pendingRequests.clear();

    if (this.node) {
      await this.node.shutdown();
      this.node = null;
    }

    logger.info('Ring node stopped', { alias: this.alias });
  }

  /**
   * Generate a unique request ID
   */
  protected generateRequestId(): string {
    return `${this.alias}-${this.requestIdCounter++}-${Date.now()}`;
  }
}
