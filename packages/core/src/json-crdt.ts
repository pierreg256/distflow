// src/json-crdt.ts
import { EventEmitter } from 'events';
import { getLogger } from './logger';

const logger = getLogger('json-crdt');

export type ReplicaId = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [k: string]: JsonValue };
export type JsonArray = JsonValue[];

export type Path = Array<string | number>;

export type VectorClock = Record<ReplicaId, number>;

/**
 * Hybrid Logical Clock (simplifié) : (wallTimeMs, counter, replicaId)
 * Permet un ordre total stable pour LWW (avec tie-break sur replicaId).
 */
export interface Hlc {
  t: number;      // time in ms (monotonic best-effort)
  c: number;      // logical counter
  r: ReplicaId;   // replica id
}

export type OpKind = "set" | "del" | "tombstone";

export interface Op {
  id: string;        // unique op id (stable)
  kind: OpKind;
  path: Path;
  value?: JsonValue; // for "set"
  hlc: Hlc;          // total order for LWW
  deps: VectorClock; // causal dependencies (vector clock)
  src: ReplicaId;    // source replica
}

/**
 * Snapshot pour persistence
 */
export interface CrdtSnapshot {
  doc: JsonValue;
  vc: VectorClock;
  hlc: Hlc;
  lww: Array<[string, Hlc]>;
  tombstones: Array<[string, Hlc]>;
  replicaId: ReplicaId;
}

/**
 * Configuration options for CRDT
 */
export interface CrdtOptions {
  maxLogSize?: number;          // Max size before GC (default: 1000)
  maxPendingSize?: number;      // Max pending buffer (default: 10000)
  maxLwwSize?: number;          // Max LWW map size (default: 100000)
  pendingTimeoutMs?: number;    // Timeout for pending ops (default: 60000)
  tombstoneGracePeriodMs?: number; // Tombstone retention (default: 3600000)
  enableAutoGc?: boolean;       // Auto GC on operations (default: true)
}

export interface Op {
  id: string;        // unique op id (stable)
  kind: OpKind;
  path: Path;
  value?: JsonValue; // for "set"
  hlc: Hlc;          // total order for LWW
  deps: VectorClock; // causal dependencies (vector clock)
  src: ReplicaId;    // source replica
}

/** Small helper: compare HLC for total order */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.c !== b.c) return a.c - b.c;
  return a.r < b.r ? -1 : a.r > b.r ? 1 : 0;
}

/** Increment vector clock at replica */
export function vcTick(vc: VectorClock, r: ReplicaId): VectorClock {
  return { ...vc, [r]: (vc[r] ?? 0) + 1 };
}

/** Check causal readiness: op.deps must be <= local vc for all replicas, and for src must be exactly local+1 */
export function isCausallyReady(local: VectorClock, op: Op): boolean {
  const src = op.src;
  const want = op.deps[src] ?? 0;
  const have = local[src] ?? 0;

  // Standard causal broadcast style rule:
  // deliver if want == have + 1 for src AND deps[k] <= local[k] for all k != src
  if (want !== have + 1) return false;

  for (const [k, v] of Object.entries(op.deps)) {
    if (k === src) continue;
    if ((local[k] ?? 0) < v) return false;
  }
  return true;
}

/** Generate a stable-ish op id */
function makeOpId(src: ReplicaId, hlc: Hlc, seq: number): string {
  // Compact, deterministic, and unique for the replica (seq monotonic per instance)
  return `${src}:${hlc.t.toString(36)}:${hlc.c.toString(36)}:${seq.toString(36)}`;
}

function cloneJson<T extends JsonValue>(v: T): T {
  // For "library-safe" behavior, clone to avoid outside mutation.
  // You can replace with structuredClone when available.
  return JSON.parse(JSON.stringify(v)) as T;
}

function ensureContainer(parent: any, key: string | number): any {
  if (typeof key === "number") {
    if (!Array.isArray(parent)) throw new Error("Path expects array but found non-array");
    while (parent.length <= key) parent.push(null);
    if (parent[key] === null || parent[key] === undefined) parent[key] = {};
    return parent[key];
  } else {
    if (parent === null || typeof parent !== "object" || Array.isArray(parent)) {
      throw new Error("Path expects object but found non-object");
    }
    if (!(key in parent) || parent[key] === null || parent[key] === undefined) parent[key] = {};
    return parent[key];
  }
}

function setAtPath(doc: JsonValue, path: Path, value: JsonValue): JsonValue {
  if (path.length === 0) return cloneJson(value);
  const root = cloneJson(doc);
  let cur: any = root;

  for (let i = 0; i < path.length - 1; i++) {
    cur = ensureContainer(cur, path[i]!);
  }

  const last = path[path.length - 1]!;
  if (typeof last === "number") {
    if (!Array.isArray(cur)) throw new Error("Cannot set numeric index on non-array");
    while (cur.length <= last) cur.push(null);
    cur[last] = cloneJson(value);
  } else {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      throw new Error("Cannot set string key on non-object");
    }
    cur[last] = cloneJson(value);
  }
  return root;
}

function delAtPath(doc: JsonValue, path: Path): JsonValue {
  if (path.length === 0) return null;
  const root = cloneJson(doc);
  let cur: any = root;

  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (cur == null) return root;
    cur = (typeof k === "number") ? cur[k] : cur[k];
  }

  const last = path[path.length - 1]!;
  if (typeof last === "number") {
    if (Array.isArray(cur) && last < cur.length) cur.splice(last, 1);
  } else {
    if (cur && typeof cur === "object") delete cur[last];
  }
  return root;
}

/**
 * JSON CRDT (LWW per-path) + causal delivery using vector clock.
 * Enhanced with: GC, tombstones, snapshots, events
 */
export class JSONCrdt extends EventEmitter {
  private readonly replica: ReplicaId;
  private readonly options: Required<CrdtOptions>;

  private doc: JsonValue;
  private vc: VectorClock;
  private hlc: Hlc;
  private seq: number;

  // LWW index: pathKey -> winning HLC
  private lww: Map<string, Hlc>;

  // Tombstones: pathKey -> deletion HLC
  private tombstones: Map<string, Hlc>;

  // log for delta sync
  private log: Op[];

  // pending ops (not causally ready)
  private pending: Array<{ op: Op; receivedAt: number }>;

  constructor(replica: ReplicaId, initial: JsonValue = {}, options: CrdtOptions = {}) {
    super();
    this.replica = replica;
    this.options = {
      maxLogSize: options.maxLogSize ?? 1000,
      maxPendingSize: options.maxPendingSize ?? 10000,
      maxLwwSize: options.maxLwwSize ?? 100000,
      pendingTimeoutMs: options.pendingTimeoutMs ?? 60000,
      tombstoneGracePeriodMs: options.tombstoneGracePeriodMs ?? 3600000,
      enableAutoGc: options.enableAutoGc ?? true
    };

    this.doc = cloneJson(initial);
    this.vc = {};
    this.hlc = { t: Date.now(), c: 0, r: replica };
    this.seq = 0;
    this.lww = new Map();
    this.tombstones = new Map();
    this.log = [];
    this.pending = [];

    logger.debug('CRDT initialized', {
      replicaId: this.replica.substring(0, 8),
      options: this.options
    });
  }

  /** Read current document snapshot */
  value(): JsonValue {
    return cloneJson(this.doc);
  }

  /** Get local vector clock */
  clock(): VectorClock {
    return { ...this.vc };
  }

  /** Get replica ID */
  getReplicaId(): ReplicaId {
    return this.replica;
  }

  /** Create and apply local SET */
  set(path: Path, value: JsonValue): Op {
    // Check for parent/child conflicts
    this.checkPathConflicts(path, 'set');

    const op = this.makeLocalOp("set", path, value);
    this.applyOp(op);

    if (this.options.enableAutoGc) {
      this.autoGc();
    }

    this.emit('change', {
      type: 'set',
      path,
      value,
      op
    });

    return op;
  }

  /** Create and apply local DELETE */
  del(path: Path): Op {
    const op = this.makeLocalOp("tombstone", path);
    this.applyOp(op);

    if (this.options.enableAutoGc) {
      this.autoGc();
    }

    this.emit('change', {
      type: 'del',
      path,
      op
    });

    return op;
  }

  /** Receive remote op (buffers if not causally ready) */
  receive(op: Op): boolean {
    if (this.seen(op)) return false;

    // Check pending buffer size
    if (this.pending.length >= this.options.maxPendingSize) {
      logger.warn('Pending buffer full, dropping old ops', {
        pendingSize: this.pending.length,
        maxSize: this.options.maxPendingSize
      });
      this.cleanPendingBuffer();
    }

    if (!isCausallyReady(this.vc, op)) {
      this.pending.push({ op, receivedAt: Date.now() });
      return false;
    }

    this.applyOp(op);

    // try drain pending
    this.drainPending();
    return true;
  }

  /** Return ops not included in 'since' clock */
  diffSince(since: VectorClock): Op[] {
    return this.log.filter(op => {
      const s = since[op.src] ?? 0;
      const v = op.deps[op.src] ?? 0;
      return v > s;
    });
  }

  /** Manual pending drain */
  drainPending(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const rest: Array<{ op: Op; receivedAt: number }> = [];
      for (const item of this.pending) {
        if (this.seen(item.op)) continue;
        if (isCausallyReady(this.vc, item.op)) {
          this.applyOp(item.op);
          progressed = true;
        } else {
          rest.push(item);
        }
      }
      this.pending = rest;
    }
  }

  /** Garbage collect log */
  gcLog(keepLastN?: number): void {
    const keep = keepLastN ?? this.options.maxLogSize;
    if (this.log.length <= keep) return;

    const removed = this.log.length - keep;
    this.log = this.log.slice(-keep);

    logger.debug('Log GC performed', {
      removedOps: removed,
      logSize: this.log.length
    });

    this.emit('gc', {
      type: 'log',
      removed,
      currentSize: this.log.length
    });
  }

  /** Clean pending buffer of old/impossible ops */
  cleanPendingBuffer(): void {
    const now = Date.now();
    const timeout = this.options.pendingTimeoutMs;

    const before = this.pending.length;
    this.pending = this.pending.filter(item => {
      return now - item.receivedAt < timeout;
    });

    const removed = before - this.pending.length;
    if (removed > 0) {
      logger.warn('Cleaned pending buffer', {
        removedOps: removed,
        pendingSize: this.pending.length
      });

      this.emit('gc', {
        type: 'pending',
        removed,
        currentSize: this.pending.length
      });
    }
  }

  /** Clean old tombstones */
  gcTombstones(): void {
    const now = Date.now();
    const gracePeriod = this.options.tombstoneGracePeriodMs;

    const toDelete: string[] = [];

    for (const [key, hlc] of this.tombstones.entries()) {
      if (now - hlc.t > gracePeriod) {
        toDelete.push(key);
      }
    }

    toDelete.forEach(key => this.tombstones.delete(key));

    if (toDelete.length > 0) {
      logger.debug('Tombstone GC performed', {
        removedTombstones: toDelete.length,
        tombstonesSize: this.tombstones.size
      });

      this.emit('gc', {
        type: 'tombstones',
        removed: toDelete.length,
        currentSize: this.tombstones.size
      });
    }
  }

  /** Auto GC triggered after operations */
  private autoGc(): void {
    // GC log if too large
    if (this.log.length > this.options.maxLogSize * 2) {
      this.gcLog();
    }

    // Check LWW map size
    if (this.lww.size > this.options.maxLwwSize) {
      logger.warn('LWW map size exceeded limit', {
        lwwSize: this.lww.size,
        maxSize: this.options.maxLwwSize
      });
    }

    // Clean pending periodically
    if (this.pending.length > this.options.maxPendingSize / 2) {
      this.cleanPendingBuffer();
    }

    // GC old tombstones
    this.gcTombstones();
  }

  /** Create snapshot for persistence */
  snapshot(): CrdtSnapshot {
    return {
      doc: cloneJson(this.doc),
      vc: { ...this.vc },
      hlc: { ...this.hlc },
      lww: Array.from(this.lww.entries()),
      tombstones: Array.from(this.tombstones.entries()),
      replicaId: this.replica
    };
  }

  /** Restore from snapshot */
  restore(snap: CrdtSnapshot): void {
    if (snap.replicaId !== this.replica) {
      logger.warn('Restoring snapshot from different replica', {
        currentReplica: this.replica.substring(0, 8),
        snapshotReplica: snap.replicaId.substring(0, 8)
      });
    }

    this.doc = cloneJson(snap.doc);
    this.vc = { ...snap.vc };
    this.hlc = { ...snap.hlc };
    this.lww = new Map(snap.lww);
    this.tombstones = new Map(snap.tombstones);
    this.log = []; // Clear log after restore
    this.pending = [];

    logger.info('Snapshot restored', {
      vcSize: Object.keys(this.vc).length,
      lwwSize: this.lww.size,
      tombstonesSize: this.tombstones.size
    });

    this.emit('restore', { snapshot: snap });
  }

  /** Check for path conflicts (parent/child) */
  private checkPathConflicts(path: Path, operation: 'set' | 'del'): void {
    // Check if any parent is a tombstone
    for (let i = 0; i < path.length; i++) {
      const parentPath = path.slice(0, i + 1);
      const parentKey = this.pathKey(parentPath);

      if (this.tombstones.has(parentKey)) {
        logger.warn('Path conflict detected: parent is tombstone', {
          path,
          parentPath,
          operation
        });

        this.emit('conflict', {
          type: 'parent-tombstone',
          path,
          parentPath,
          operation
        });
      }
    }
  }

  /** Serialize op as JSON string */
  static encodeOp(op: Op): string {
    return JSON.stringify(op);
  }

  /** Deserialize op */
  static decodeOp(s: string): Op {
    return JSON.parse(s) as Op;
  }

  /** Get statistics */
  getStats(): {
    logSize: number;
    pendingSize: number;
    lwwSize: number;
    tombstonesSize: number;
    vcSize: number;
  } {
    return {
      logSize: this.log.length,
      pendingSize: this.pending.length,
      lwwSize: this.lww.size,
      tombstonesSize: this.tombstones.size,
      vcSize: Object.keys(this.vc).length
    };
  }

  // ---- internals ----

  private makeLocalOp(kind: OpKind, path: Path, value?: JsonValue): Op {
    // advance HLC (monotonic best-effort)
    const now = Date.now();
    if (now > this.hlc.t) {
      this.hlc = { t: now, c: 0, r: this.replica };
    } else {
      this.hlc = { t: this.hlc.t, c: this.hlc.c + 1, r: this.replica };
    }

    // tick VC
    this.vc = vcTick(this.vc, this.replica);

    const deps = { ...this.vc };
    const id = makeOpId(this.replica, this.hlc, ++this.seq);

    const op: Op = {
      id,
      kind,
      path: [...path],
      value: kind === "set" ? cloneJson(value!) : undefined,
      hlc: { ...this.hlc },
      deps,
      src: this.replica,
    };
    return op;
  }

  private pathKey(path: Path): string {
    // stable key for map (escape / delimiter safe)
    return path.map(p => (typeof p === "number" ? `#${p}` : `.${p}`)).join("");
  }

  private seen(op: Op): boolean {
    // Seen if VC already includes op.src >= op.deps[src]
    const src = op.src;
    const want = op.deps[src] ?? 0;
    const have = this.vc[src] ?? 0;
    return have >= want;
  }

  private applyOp(op: Op): void {
    const key = this.pathKey(op.path);

    // Handle tombstones
    if (op.kind === "tombstone") {
      const currentTombstone = this.tombstones.get(key);

      if (!currentTombstone || compareHlc(op.hlc, currentTombstone) > 0) {
        this.tombstones.set(key, op.hlc);
        this.doc = delAtPath(this.doc, op.path);

        logger.debug('Tombstone applied', {
          path: op.path,
          hlc: op.hlc
        });
      }
    } else {
      // Check if there's a tombstone that's newer
      const tombstone = this.tombstones.get(key);
      if (tombstone && compareHlc(tombstone, op.hlc) > 0) {
        logger.warn('SET rejected: newer tombstone exists', {
          path: op.path,
          setHlc: op.hlc,
          tombstoneHlc: tombstone
        });

        this.emit('conflict', {
          type: 'tombstone-wins',
          path: op.path,
          opHlc: op.hlc,
          tombstoneHlc: tombstone
        });

        // Still record in log but don't apply
      } else {
        // LWW per path
        const current = this.lww.get(key);

        if (!current || compareHlc(op.hlc, current) > 0) {
          this.lww.set(key, op.hlc);
          this.doc = op.kind === "set"
            ? setAtPath(this.doc, op.path, op.value!)
            : delAtPath(this.doc, op.path);
        }
      }
    }

    // merge VC: set local[src] = max(local[src], op.deps[src]) etc.
    for (const [k, v] of Object.entries(op.deps)) {
      this.vc[k] = Math.max(this.vc[k] ?? 0, v);
    }

    // record log (for delta sync)
    this.log.push(op);

    // merge remote HLC into local HLC (HLC receive rule simplified)
    const t = Math.max(this.hlc.t, op.hlc.t);
    const c =
      t === this.hlc.t && t === op.hlc.t ? Math.max(this.hlc.c, op.hlc.c) + 1
      : t === this.hlc.t ? this.hlc.c + 1
      : op.hlc.c + 1;
    this.hlc = { t, c, r: this.replica };
  }
}
