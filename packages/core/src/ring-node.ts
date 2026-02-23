import crypto from 'crypto';
import * as Y from 'yjs';
import { NodeRuntime, NodeRuntimeOptions, PeerInfo } from './node-runtime';
import { configureLogger, LogLevel } from './logger';

const logger = configureLogger({ name: 'ring-node', level: LogLevel.INFO });

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute consistent hash for a node identifier.
 * Uses SHA-256, returns first 8 bytes as a JS safe integer.
 */
export function consistentHash(nodeId: string): number {
  const hash = crypto.createHash('sha256').update(nodeId).digest();
  return hash.readUInt32BE(0) * 0x100000000 + hash.readUInt32BE(4);
}

/** Encode Uint8Array to base64 string (transport-safe) */
function encodeUpdate(update: Uint8Array): string {
  return Buffer.from(update).toString('base64');
}

/** Decode base64 string to Uint8Array */
function decodeUpdate(encoded: string): Uint8Array {
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * Ring state machine states.
 *
 *   BOOTSTRAPPING  → join → UNSTABLE
 *   UNSTABLE       → (quiescence + quorum convergence) → STABLE
 *   STABLE         → (awareness change | doc update)   → UNSTABLE
 */
export enum RingState {
  /** Startup phase – no reliable view of the ring yet */
  BOOTSTRAPPING = 'BOOTSTRAPPING',
  /** Topology is changing (join / leave / rebalance) */
  UNSTABLE = 'UNSTABLE',
  /** Topology is frozen – routing is authorised */
  STABLE = 'STABLE',
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Volatile awareness payload (heartbeat) */
export interface AwarenessEntry {
  nodeId: string;
  heartbeatTs: number;
}

/** Persisted ring member inside the Yjs document */
export interface RingMember {
  nodeId: string;
  alias?: string;
  token: number; // consistentHash(nodeId)
  joinedAt: number;
}

/** Neighbours on the ring (predecessor / successor) */
export interface RingNeighbors {
  predecessor: RingMember | null;
  successor: RingMember | null;
}

/** Ring-specific protocol messages exchanged between RingNodes */
export type RingMessage =
  | { type: 'ring:update'; update: string }
  | { type: 'ring:awareness'; nodeId: string; entry: AwarenessEntry | null }
  | { type: 'ring:sync-step1'; sv: string }
  | { type: 'ring:sync-step2'; sv: string; update: string };

/** Configuration options for a RingNode */
export interface RingNodeOptions extends NodeRuntimeOptions {
  /** Heartbeat broadcast interval (ms) – default 5 000 */
  heartbeatInterval?: number;
  /** Awareness timeout before a peer is considered offline (ms) – default 30 000 */
  awarenessTimeout?: number;
  /** Duration of quiescence required before considering the ring stable (ms) – default 15 000 */
  stabilityWindow?: number;
  /** Fraction of online peers that must have converged – default 0.6 */
  quorumRatio?: number;
  /** Stability-detection tick interval (ms) – default 1 000 */
  stabilityCheckInterval?: number;
}

// ─── Default constants ──────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 5_000;
const AWARENESS_TIMEOUT = 30_000;
const STABILITY_WINDOW = 15_000;
const QUORUM_RATIO = 0.6;
const STABILITY_CHECK_INTERVAL = 1_000;

// ─── Lightweight Awareness implementation ───────────────────────────────────

import { EventEmitter } from 'events';

/**
 * Minimal Awareness layer (mirrors the Yjs awareness protocol concepts).
 * Each node publishes its local state; remote states are set externally
 * (e.g. via long-polling sync or transport messages).
 */
export class Awareness extends EventEmitter {
  private states: Map<string, AwarenessEntry | null> = new Map();
  private timeoutMs: number;

  constructor(timeoutMs: number = AWARENESS_TIMEOUT) {
    super();
    this.timeoutMs = timeoutMs;
  }

  /** Set the local awareness state (null = offline / leaving) */
  setLocalState(nodeId: string, state: AwarenessEntry | null): void {
    this.states.set(nodeId, state);
    this.emit('change', {
      added: [],
      updated: [nodeId],
      removed: state === null ? [nodeId] : [],
    });
    if (state === null) {
      this.states.delete(nodeId);
    }
  }

  /** Apply a remote awareness state (received from the network) */
  setRemoteState(nodeId: string, state: AwarenessEntry | null): void {
    if (state === null) {
      if (this.states.has(nodeId)) {
        this.states.delete(nodeId);
        this.emit('change', { added: [], updated: [], removed: [nodeId] });
      }
      return;
    }
    const isNew = !this.states.has(nodeId);
    this.states.set(nodeId, state);
    this.emit('change', {
      added: isNew ? [nodeId] : [],
      updated: isNew ? [] : [nodeId],
      removed: [],
    });
  }

  /** Get awareness state for a single node */
  getState(nodeId: string): AwarenessEntry | null {
    return this.states.get(nodeId) ?? null;
  }

  /** Return all online peers (those whose heartbeat is still fresh) */
  getOnlinePeers(now: number = Date.now()): AwarenessEntry[] {
    const online: AwarenessEntry[] = [];
    for (const [, entry] of this.states) {
      if (entry && now - entry.heartbeatTs < this.timeoutMs) {
        online.push(entry);
      }
    }
    return online;
  }

  /** Return peers whose heartbeat has expired */
  getOfflinePeers(now: number = Date.now()): string[] {
    const offline: string[] = [];
    for (const [id, entry] of this.states) {
      if (entry && now - entry.heartbeatTs >= this.timeoutMs) {
        offline.push(id);
      }
    }
    return offline;
  }

  /** Cleanup expired awareness entries and emit removals */
  cleanup(now: number = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, entry] of this.states) {
      if (entry && now - entry.heartbeatTs >= this.timeoutMs) {
        this.states.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) {
      this.emit('change', { added: [], updated: [], removed });
    }
    return removed;
  }

  destroy(): void {
    this.states.clear();
    this.removeAllListeners();
  }
}

// ─── RingNode ───────────────────────────────────────────────────────────────

/**
 * RingNode – Consistent-hash ring built on top of NodeRuntime.
 *
 * Inherits from NodeRuntime for:
 *  - PMD-based peer discovery (peer:join / peer:leave events)
 *  - TCP transport (send / broadcast to peers)
 *  - Mailbox-based message handling
 *
 * Adds:
 *  - Yjs CRDT document as the persistent ring topology
 *  - Awareness heartbeats for online/offline detection
 *  - A three-state machine (BOOTSTRAPPING → UNSTABLE → STABLE)
 *  - Leaderless quorum convergence based on quiescence + CRDT diff
 *
 * Events emitted (in addition to NodeRuntime events):
 *  - `state-change`       (newState, oldState)
 *  - `ring-stable`        (sortedMembers[])
 *  - `ring-unstable`      ()
 *  - `member-joined`      (RingMember)
 *  - `member-left`        (nodeId)
 *  - `awareness-change`   ({ added, updated, removed })
 */
export class RingNode extends NodeRuntime {
  // ── ring configuration ─────────────────────────────────────────────────
  private readonly heartbeatInterval: number;
  private readonly awarenessTimeout: number;
  private readonly stabilityWindow: number;
  private readonly quorumRatio: number;
  private readonly stabilityCheckInterval: number;

  // ── state machine ─────────────────────────────────────────────────────
  private _ringState: RingState = RingState.BOOTSTRAPPING;
  private lastTopologyChangeTs: number = Date.now();
  private lastAwarenessChangeTs: number = Date.now();

  // ── CRDT (Yjs) ────────────────────────────────────────────────────────
  readonly ydoc: Y.Doc;
  private ringArray: Y.Array<RingMember>;

  // ── Awareness ─────────────────────────────────────────────────────────
  readonly awareness: Awareness;

  // ── timers ────────────────────────────────────────────────────────────
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private stabilityTimer?: ReturnType<typeof setInterval>;

  // ── known peers (cache updated via PMD events) ────────────────────────
  private knownPeers: Map<string, PeerInfo> = new Map();

  // ── lifecycle ─────────────────────────────────────────────────────────
  private ringDestroyed = false;

  // ────────────────────────────────────────────────────────────────────────

  protected constructor(options: RingNodeOptions = {}) {
    super(options);

    this.heartbeatInterval = options.heartbeatInterval ?? HEARTBEAT_INTERVAL;
    this.awarenessTimeout = options.awarenessTimeout ?? AWARENESS_TIMEOUT;
    this.stabilityWindow = options.stabilityWindow ?? STABILITY_WINDOW;
    this.quorumRatio = options.quorumRatio ?? QUORUM_RATIO;
    this.stabilityCheckInterval =
      options.stabilityCheckInterval ?? STABILITY_CHECK_INTERVAL;

    // ── Yjs doc ─────────────────────────────────────────────────────────
    this.ydoc = new Y.Doc();
    this.ringArray = this.ydoc.getArray<RingMember>('ring');

    // ── Awareness ───────────────────────────────────────────────────────
    this.awareness = new Awareness(this.awarenessTimeout);

    // ── Wire doc & awareness to the state machine ───────────────────────
    this.ydoc.on('update', this.onDocUpdate);
    this.awareness.on('change', this.onAwarenessChange);
  }

  // ─── Factory ──────────────────────────────────────────────────────────

  /**
   * Create a RingNode, initialise the NodeRuntime (PMD + transport),
   * then join the ring.
   */
  static async start(options: RingNodeOptions = {}): Promise<RingNode> {
    // Honour singleton constraint from NodeRuntime
    if (NodeRuntime['instance']) {
      throw new Error(
        'A NodeRuntime (or RingNode) is already running in this process',
      );
    }

    const node = new RingNode(options);

    // NodeRuntime initialisation: PMD, transport, register, watch
    await (node as any).initialize(options.pmdPort ?? 4369);

    // Mark singleton
    (NodeRuntime as any).instance = node;

    // Wire PMD peer events → ring
    node.wirePeerDiscovery();

    // Wire incoming transport messages → ring protocol
    node.wireIncomingMessages();

    // Discover existing peers FIRST (populate knownPeers before joinRing
    // so that the Yjs update broadcast in onDocUpdate reaches them)
    await node.discoverExistingPeers();

    // Join the ring (insert into CRDT, start heartbeat + stability loop)
    // The onDocUpdate handler will broadcast the insert to knownPeers.
    node.joinRing();

    // Kick off a full bidirectional sync with every known peer
    await node.syncWithExistingPeers();

    return node;
  }

  // ─── Public getters ───────────────────────────────────────────────────

  /** Current state-machine state */
  get ringState(): RingState {
    return this._ringState;
  }

  /** Sorted snapshot of current ring members */
  get members(): RingMember[] {
    return this.getSortedMembers();
  }

  /** Number of members in the ring */
  get size(): number {
    return this.ringArray.length;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Insert local node into the CRDT, start heartbeat and stability loops.
   */
  private joinRing(): void {
    logger.info('Joining ring', { nodeId: this.nodeId });

    // Insert self into the CRDT if not already present
    this.ydoc.transact(() => {
      if (!this.ringContains(this.nodeId)) {
        this.ringArray.push([
          {
            nodeId: this.nodeId,
            alias: this.alias || undefined,
            token: consistentHash(this.nodeId),
            joinedAt: Date.now(),
          },
        ]);
      }
    });

    // Publish initial awareness
    this.awareness.setLocalState(this.nodeId, {
      nodeId: this.nodeId,
      heartbeatTs: Date.now(),
    });

    // Start heartbeat loop (+ broadcast awareness to peers)
    this.heartbeatTimer = setInterval(() => {
      const entry: AwarenessEntry = {
        nodeId: this.nodeId,
        heartbeatTs: Date.now(),
      };
      this.awareness.setLocalState(this.nodeId, entry);
      this.broadcastRingMessage({ type: 'ring:awareness', nodeId: this.nodeId, entry });
    }, this.heartbeatInterval);

    // Start stability detection loop
    this.stabilityTimer = setInterval(
      () => this.stabilityCheck(),
      this.stabilityCheckInterval,
    );

    // Transition BOOTSTRAPPING → UNSTABLE
    this.setRingState(RingState.UNSTABLE);
  }

  /**
   * Gracefully leave the ring (announce offline, remove from CRDT).
   */
  leaveRing(): void {
    logger.info('Leaving ring', { nodeId: this.nodeId });

    // Signal offline to local awareness + broadcast
    this.awareness.setLocalState(this.nodeId, null);
    this.broadcastRingMessage({
      type: 'ring:awareness',
      nodeId: this.nodeId,
      entry: null,
    });

    // Remove self from CRDT
    this.ydoc.transact(() => {
      this.removeNodeFromRing(this.nodeId);
    });

    this.stopRingTimers();
  }

  /**
   * Full teardown: leave the ring, then shut down the underlying NodeRuntime.
   */
  async shutdown(): Promise<void> {
    if (this.ringDestroyed) return;
    this.ringDestroyed = true;

    // Ring-level cleanup
    this.leaveRing();

    this.ydoc.off('update', this.onDocUpdate);
    this.awareness.off('change', this.onAwarenessChange);
    this.awareness.destroy();
    this.ydoc.destroy();

    logger.info('RingNode destroyed', { nodeId: this.nodeId });

    // NodeRuntime-level shutdown (PMD unregister, transport stop, etc.)
    await super.shutdown();
  }

  // ─── Ring operations ──────────────────────────────────────────────────

  /** Check whether the ring contains a given node. */
  ringContains(nodeId: string): boolean {
    for (let i = 0; i < this.ringArray.length; i++) {
      if (this.ringArray.get(i).nodeId === nodeId) return true;
    }
    return false;
  }

  /**
   * Remove a node from the Yjs ring array.
   * Must be called inside a `ydoc.transact()` block.
   */
  private removeNodeFromRing(nodeId: string): void {
    for (let i = this.ringArray.length - 1; i >= 0; i--) {
      if (this.ringArray.get(i).nodeId === nodeId) {
        this.ringArray.delete(i, 1);
        return;
      }
    }
  }

  /** Return ring members sorted by token (ascending). */
  getSortedMembers(): RingMember[] {
    const members: RingMember[] = [];
    for (let i = 0; i < this.ringArray.length; i++) {
      members.push(this.ringArray.get(i));
    }
    return members.sort((a, b) => a.token - b.token);
  }

  /**
   * Find the successor node for a given key (consistent-hash lookup).
   * Throws if the ring is not STABLE.
   */
  findSuccessor(key: string): RingMember {
    if (this._ringState !== RingState.STABLE) {
      throw new Error('Ring not stable – routing is not allowed');
    }

    const sorted = this.getSortedMembers();
    if (sorted.length === 0) throw new Error('Ring is empty');

    const keyHash = consistentHash(key);

    for (const member of sorted) {
      if (member.token >= keyHash) return member;
    }
    // Wrap around
    return sorted[0];
  }

  /**
   * Route a request to the responsible node for `key`.
   * Returns the target RingMember.
   */
  routeRequest(key: string): RingMember {
    return this.findSuccessor(key);
  }

  /** Return the predecessor and successor of the local node on the ring. */
  getNeighbors(): RingNeighbors {
    const sorted = this.getSortedMembers();
    const idx = sorted.findIndex((m) => m.nodeId === this.nodeId);
    if (idx === -1) return { predecessor: null, successor: null };

    const pred = idx > 0 ? sorted[idx - 1] : sorted[sorted.length - 1];
    const succ = idx < sorted.length - 1 ? sorted[idx + 1] : sorted[0];

    return {
      predecessor: pred.nodeId !== this.nodeId ? pred : null,
      successor: succ.nodeId !== this.nodeId ? succ : null,
    };
  }

  // ─── Crash handling (garbage collection of stale nodes) ───────────────

  /**
   * Remove nodes from the Yjs doc whose awareness has expired.
   */
  cleanupOfflineNodes(): string[] {
    const removed = this.awareness.cleanup();

    if (removed.length > 0) {
      this.ydoc.transact(() => {
        for (const id of removed) {
          this.removeNodeFromRing(id);
          logger.info('Cleaned up offline node', { nodeId: id });
          this.emit('member-left', id);
        }
      });
    }

    return removed;
  }

  // ─── Yjs sync helpers ─────────────────────────────────────────────────

  /** Encode the local state vector (for sending to peers). */
  encodeStateVector(): Uint8Array {
    return Y.encodeStateVector(this.ydoc);
  }

  /** Compute the diff needed to bring a peer up to date. */
  encodeDiff(remoteStateVector: Uint8Array): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc, remoteStateVector);
  }

  /** Apply a remote Yjs update to the local document. */
  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, 'remote');
  }

  /**
   * Check whether a remote state vector is already covered by the local
   * document (i.e. the diff would be empty). Used for quorum convergence.
   */
  isConvergedWith(remoteStateVector: Uint8Array): boolean {
    const diff = Y.encodeStateAsUpdate(this.ydoc, remoteStateVector);
    // A Yjs update with only the header (length ≤ 2) means "nothing to sync"
    return diff.length <= 2;
  }

  // ─── Peer discovery wiring ────────────────────────────────────────────

  /**
   * Wire PMD peer events into the ring awareness and known-peers cache.
   */
  private wirePeerDiscovery(): void {
    this.on('peer:join', (peer: PeerInfo) => {
      logger.info('Peer discovered via PMD', { peerId: peer.nodeId });
      this.knownPeers.set(peer.nodeId, peer);

      // Start a bidirectional sync with the new peer:
      // Send our state vector (step 1) so they can compute & send
      // what we are missing, and also push our full state so they
      // learn about us immediately (even if they haven't joined yet).
      this.pushFullStateTo(peer);
      this.sendRingMessageTo(peer, {
        type: 'ring:sync-step1',
        sv: encodeUpdate(this.encodeStateVector()),
      });
    });

    this.on('peer:leave', (peer: PeerInfo) => {
      logger.info('Peer left via PMD', { peerId: peer.nodeId });
      this.knownPeers.delete(peer.nodeId);

      // Mark peer offline in awareness
      this.awareness.setRemoteState(peer.nodeId, null);
    });
  }

  /**
   * Wire incoming transport messages to the ring protocol handler.
   */
  private wireIncomingMessages(): void {
    this.on('message', (message: any, meta: any) => {
      if (message && typeof message.type === 'string' && message.type.startsWith('ring:')) {
        this.handleRingMessage(message as RingMessage, meta);
      }
    });
  }

  // ─── Ring protocol ────────────────────────────────────────────────────

  /**
   * Handle an incoming ring protocol message.
   */
  private handleRingMessage(msg: RingMessage, meta: any): void {
    switch (msg.type) {
      case 'ring:update': {
        const update = decodeUpdate(msg.update);
        this.applyRemoteUpdate(update);
        break;
      }

      case 'ring:awareness': {
        this.awareness.setRemoteState(msg.nodeId, msg.entry);
        break;
      }

      case 'ring:sync-step1': {
        // Peer sent us its state vector → reply with what it's missing
        // (our diff) AND our own state vector so it can reply with
        // what we're missing (true 2-way Yjs sync).
        const remoteSV = decodeUpdate(msg.sv);
        const diff = this.encodeDiff(remoteSV);
        const fromId = meta?.from as string | undefined;
        const peer = fromId ? this.knownPeers.get(fromId) : undefined;
        if (peer) {
          this.sendRingMessageTo(peer, {
            type: 'ring:sync-step2',
            sv: encodeUpdate(this.encodeStateVector()),
            update: encodeUpdate(diff),
          });
        }
        break;
      }

      case 'ring:sync-step2': {
        // Peer replied with its diff + its own state vector.
        // Apply the diff, then send back anything it still needs.
        const update = decodeUpdate(msg.update);
        if (update.length > 2) {
          this.applyRemoteUpdate(update);
        }
        const remoteSV = decodeUpdate(msg.sv);
        const ourDiff = this.encodeDiff(remoteSV);
        if (ourDiff.length > 2) {
          const fromId = meta?.from as string | undefined;
          const peer = fromId ? this.knownPeers.get(fromId) : undefined;
          if (peer) {
            this.sendRingMessageTo(peer, {
              type: 'ring:update',
              update: encodeUpdate(ourDiff),
            });
          }
        }
        break;
      }
    }
  }

  /**
   * Broadcast a ring message to all known peers via the transport layer.
   */
  private broadcastRingMessage(msg: RingMessage): void {
    for (const [, peer] of this.knownPeers) {
      this.sendRingMessageTo(peer, msg).catch((err) => {
        logger.warn('Broadcast to peer failed', {
          peerId: peer.nodeId,
          error: (err as Error).message,
        });
      });
    }
  }

  /**
   * Send a ring message to a specific peer via the transport layer.
   */
  private async sendRingMessageTo(
    peer: PeerInfo,
    msg: RingMessage,
  ): Promise<void> {
    await this.transport.send(
      peer.host,
      peer.port,
      this.nodeId,
      peer.nodeId,
      msg,
    );
  }

  /**
   * Discover existing peers from PMD and populate knownPeers.
   * Called BEFORE joinRing so that the Yjs update broadcast reaches them.
   */
  private async discoverExistingPeers(): Promise<void> {
    try {
      const peers = await this.discover();
      for (const peer of peers) {
        this.knownPeers.set(peer.nodeId, peer);
        logger.info('Pre-discovered peer', { peerId: peer.nodeId });
      }
    } catch (err) {
      logger.warn('Failed to discover existing peers', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Full bidirectional sync with every known peer:
   * 1. Push our full Yjs state (so they learn about us immediately)
   * 2. Send sync-step1 (our SV) so they reply with what we're missing
   */
  private async syncWithExistingPeers(): Promise<void> {
    for (const [, peer] of this.knownPeers) {
      try {
        // Push our full state
        await this.pushFullStateTo(peer);

        // Pull: send our state vector → peer replies with its diff
        await this.sendRingMessageTo(peer, {
          type: 'ring:sync-step1',
          sv: encodeUpdate(this.encodeStateVector()),
        });
      } catch (err) {
        logger.warn('Initial sync with peer failed', {
          peerId: peer.nodeId,
          error: (err as Error).message,
        });
      }
    }
  }

  /**
   * Push our full Yjs document state to a single peer as a ring:update.
   */
  private async pushFullStateTo(peer: PeerInfo): Promise<void> {
    const fullState = Y.encodeStateAsUpdate(this.ydoc);
    if (fullState.length > 2) {
      await this.sendRingMessageTo(peer, {
        type: 'ring:update',
        update: encodeUpdate(fullState),
      });
    }
  }

  // ─── State machine internals ──────────────────────────────────────────

  /** Handler for Yjs document updates → mark topology change + broadcast */
  private onDocUpdate = (update: Uint8Array, origin: any): void => {
    this.lastTopologyChangeTs = Date.now();

    if (this._ringState === RingState.STABLE) {
      this.setRingState(RingState.UNSTABLE);
    }

    // Broadcast to peers (but NOT if this update came from the network)
    if (origin !== 'remote') {
      this.broadcastRingMessage({
        type: 'ring:update',
        update: encodeUpdate(update),
      });
    }

    logger.debug('Doc updated', { origin, members: this.ringArray.length });
  };

  /**
   * Handler for awareness changes → mark awareness change.
   *
   * Only `added` or `removed` entries represent real topology changes
   * (a new peer appearing or an existing peer going offline).  Plain
   * `updated` entries are heartbeat refreshes (local *or* remote) and
   * must NOT reset the stability timer – otherwise the 15 s quiescence
   * window can never be reached because every node broadcasts a
   * heartbeat every 5 s.
   */
  private onAwarenessChange = (change: {
    added: string[];
    updated: string[];
    removed: string[];
  }): void => {
    const isTopologyChange =
      change.added.length > 0 || change.removed.length > 0;

    if (isTopologyChange) {
      this.lastAwarenessChangeTs = Date.now();

      if (this._ringState === RingState.STABLE) {
        this.setRingState(RingState.UNSTABLE);
      }
    }

    this.emit('awareness-change', change);

    logger.debug('Awareness changed', { ...change, isTopologyChange });
  };

  /**
   * Stability-detection tick.
   * Transitions UNSTABLE → STABLE when:
   *  1. No awareness change for `stabilityWindow` ms
   *  2. No doc update for `stabilityWindow` ms
   *  3. Quorum of online peers have converged (CRDT-safe)
   */
  private stabilityCheck(): void {
    if (this._ringState === RingState.STABLE) return;

    const now = Date.now();

    const awarenessQuiet =
      now - this.lastAwarenessChangeTs > this.stabilityWindow;
    const topologyQuiet =
      now - this.lastTopologyChangeTs > this.stabilityWindow;

    if (!awarenessQuiet || !topologyQuiet) return;

    if (!this.hasQuorumConverged()) return;

    this.setRingState(RingState.STABLE);
    this.onRingStable();
  }

  /**
   * Check whether a quorum of online peers share the same Yjs state.
   *
   * Default implementation: we consider quorum reached when at least
   * `quorumRatio` of ring members are visible in awareness.  In a
   * multi-process deployment this can be overridden to perform actual
   * state-vector diffing over the network.
   */
  hasQuorumConverged(): boolean {
    const members = this.getSortedMembers();
    if (members.length === 0) return false;

    const onlinePeers = this.awareness.getOnlinePeers();
    const quorumSize = Math.ceil(members.length * this.quorumRatio);

    return onlinePeers.length >= quorumSize;
  }

  /** Called once when the ring transitions to STABLE */
  private onRingStable(): void {
    const sorted = this.getSortedMembers();
    logger.info('Ring is stable', {
      members: sorted.length,
      nodes: sorted.map((m) => m.nodeId),
    });
    this.emit('ring-stable', sorted);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private setRingState(next: RingState): void {
    const prev = this._ringState;
    if (prev === next) return;

    this._ringState = next;
    logger.info(`State: ${prev} → ${next}`, { nodeId: this.nodeId });
    this.emit('state-change', next, prev);

    if (next === RingState.UNSTABLE) {
      this.emit('ring-unstable');
    }
  }

  private stopRingTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.stabilityTimer) {
      clearInterval(this.stabilityTimer);
      this.stabilityTimer = undefined;
    }
  }
}
