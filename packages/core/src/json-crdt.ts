// src/json-crdt.ts
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

export type OpKind = "set" | "del";

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
 * - local ops create Op with deps = current VC (after tick at src)
 * - remote ops are applied when causally ready
 */
export class JSONCrdt {
  private readonly replica: ReplicaId;

  private doc: JsonValue;
  private vc: VectorClock;
  private hlc: Hlc;
  private seq: number;

  // LWW index: pathKey -> winning HLC
  private lww: Map<string, Hlc>;

  // log for delta sync
  private log: Op[];

  // pending ops (not causally ready)
  private pending: Op[];

  constructor(replica: ReplicaId, initial: JsonValue = {}) {
    this.replica = replica;
    this.doc = cloneJson(initial);
    this.vc = {};
    this.hlc = { t: Date.now(), c: 0, r: replica };
    this.seq = 0;
    this.lww = new Map();
    this.log = [];
    this.pending = [];
  }

  /** Read current document snapshot */
  value(): JsonValue {
    return cloneJson(this.doc);
  }

  /** Get local vector clock */
  clock(): VectorClock {
    return { ...this.vc };
  }

  /** Create and apply local SET */
  set(path: Path, value: JsonValue): Op {
    const op = this.makeLocalOp("set", path, value);
    this.applyOp(op);
    return op;
  }

  /** Create and apply local DELETE */
  del(path: Path): Op {
    const op = this.makeLocalOp("del", path);
    this.applyOp(op);
    return op;
  }

  /** Receive remote op (buffers if not causally ready) */
  receive(op: Op): boolean {
    if (this.seen(op)) return false;

    if (!isCausallyReady(this.vc, op)) {
      this.pending.push(op);
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
      const v = op.deps[op.src] ?? 0; // this op's sequence on src
      return v > s;
    });
  }

  /** (Optional) manual pending drain */
  drainPending(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const rest: Op[] = [];
      for (const op of this.pending) {
        if (this.seen(op)) continue;
        if (isCausallyReady(this.vc, op)) {
          this.applyOp(op);
          progressed = true;
        } else {
          rest.push(op);
        }
      }
      this.pending = rest;
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
    // LWW per path
    const key = this.pathKey(op.path);
    const current = this.lww.get(key);

    if (!current || compareHlc(op.hlc, current) > 0) {
      this.lww.set(key, op.hlc);
      this.doc = op.kind === "set"
        ? setAtPath(this.doc, op.path, op.value!)
        : delAtPath(this.doc, op.path);
    }

    // merge VC: set local[src] = max(local[src], op.deps[src]) etc.
    for (const [k, v] of Object.entries(op.deps)) {
      this.vc[k] = Math.max(this.vc[k] ?? 0, v);
    }

    // record log (for delta sync)
    this.log.push(op);

    // merge remote HLC into local HLC (HLC receive rule simplified)
    // keep monotonic: hlc.t = max(local.t, op.t), hlc.c = ...
    const t = Math.max(this.hlc.t, op.hlc.t);
    const c =
      t === this.hlc.t && t === op.hlc.t ? Math.max(this.hlc.c, op.hlc.c) + 1
      : t === this.hlc.t ? this.hlc.c + 1
      : op.hlc.c + 1;
    this.hlc = { t, c, r: this.replica };
  }
}
