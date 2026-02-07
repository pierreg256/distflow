# JSON-CRDT Observabilité

Guide complet de l'observabilité et du monitoring du JSON-CRDT dans distflow.

## Vue d'ensemble

Le JSON-CRDT intègre des fonctionnalités complètes d'observabilité pour:

- **Monitoring en production**: métriques de performance, détection de conflits
- **Debugging**: inspection d'état, replay d'opérations, graphe causal
- **Analyse**: diff entre snapshots, statistiques détaillées

## Métriques et Monitoring

### Interface CrdtMetrics

```typescript
interface CrdtMetrics {
  // Compteurs d'opérations
  totalOps: number;           // Total ops (local + remote)
  localOps: number;           // Ops locales créées
  remoteOps: number;          // Ops remote reçues
  
  // Performance
  opsPerSecond: number;       // Ops/sec (fenêtre glissante 60s)
  avgLatencyMs: number;       // Latence moyenne d'application
  
  // Conflits
  totalConflicts: number;     // Total conflits détectés
  tombstoneConflicts: number; // Conflits avec tombstones
  pathConflicts: number;      // Conflits parent/child
  
  // Garbage collection
  gcRuns: number;             // Nombre de GC exécutés
  gcLogOps: number;           // Ops supprimées du log
  gcTombstones: number;       // Tombstones supprimés
  gcPendingOps: number;       // Pending ops nettoyés
  
  // État actuel
  logSize: number;
  pendingSize: number;
  lwwSize: number;
  tombstonesSize: number;
  vcSize: number;
}
```

### Obtenir les métriques

```typescript
const crdt = new JSONCrdt('replica-1');

// Après quelques opérations...
crdt.set(['user', 'name'], 'Alice');
crdt.set(['user', 'age'], 30);

// Obtenir métriques complètes
const metrics = crdt.getMetrics();
console.log(`Ops/sec: ${metrics.opsPerSecond.toFixed(2)}`);
console.log(`Latence moyenne: ${metrics.avgLatencyMs.toFixed(2)}ms`);
console.log(`Conflits: ${metrics.totalConflicts}`);

// Backward compatible: getStats() retourne un sous-ensemble
const stats = crdt.getStats();
console.log(`Log size: ${stats.logSize}`);
```

### Monitoring temps réel avec Events

```typescript
const crdt = new JSONCrdt('replica-1');

// Écouter les changements
crdt.on('change', ({ type, path, value, op }) => {
  console.log(`Change: ${type} at ${JSON.stringify(path)}`);
  
  const metrics = crdt.getMetrics();
  console.log(`Current ops/sec: ${metrics.opsPerSecond}`);
});

// Détecter les conflits
crdt.on('conflict', ({ type, path, ...details }) => {
  console.error(`Conflict detected: ${type}`, details);
  
  const metrics = crdt.getMetrics();
  console.log(`Total conflicts: ${metrics.totalConflicts}`);
});

// Surveiller le GC
crdt.on('gc', ({ type, removed, currentSize }) => {
  console.log(`GC ${type}: removed ${removed}, new size ${currentSize}`);
  
  const metrics = crdt.getMetrics();
  console.log(`Total GC runs: ${metrics.gcRuns}`);
});
```

## Outils de Debug

### inspect(): État Interne Complet

Dump l'état interne pour debugging:

```typescript
const inspection = crdt.inspect({
  logSampleSize: 10,        // Dernières N ops du log
  pendingSampleSize: 5,     // Premières N ops pending
  includeCausalGraph: true  // Inclure le graphe de dépendances
});

console.log('Replica ID:', inspection.replicaId);
console.log('Document:', inspection.doc);
console.log('Vector Clock:', inspection.vc);
console.log('HLC:', inspection.hlc);

console.log('\nLog sample (last 10 ops):');
inspection.logSample.forEach((op, i) => {
  console.log(`  ${i}: ${op.kind} at ${JSON.stringify(op.path)}`);
});

console.log('\nLWW paths:', inspection.lwwPaths);
console.log('Tombstone paths:', inspection.tombstonePaths);

console.log('\nMetrics:', inspection.metrics);

if (inspection.causalGraph) {
  console.log('\nCausal graph:', inspection.causalGraph.length, 'nodes');
}
```

Interface complète:

```typescript
interface CrdtInspection {
  replicaId: ReplicaId;
  doc: JsonValue;
  vc: VectorClock;
  hlc: Hlc;
  logSize: number;
  logSample: Op[];
  pendingSize: number;
  pendingSample: Op[];
  lwwPaths: string[];
  tombstonePaths: string[];
  metrics: CrdtMetrics;
  causalGraph?: CausalGraphNode[];
}
```

### getCausalGraph(): Visualisation des Dépendances

Obtenir le graphe de dépendances causales:

```typescript
const graph = crdt.getCausalGraph();

graph.forEach(node => {
  console.log(`Op: ${node.opId}`);
  console.log(`  Kind: ${node.kind}, Path: ${node.path}`);
  console.log(`  HLC: t=${node.hlc.t}, c=${node.hlc.c}`);
  console.log(`  Dependencies: ${node.deps.join(', ')}`);
});
```

Format:

```typescript
interface CausalGraphNode {
  opId: string;
  kind: OpKind;
  path: string;
  hlc: Hlc;
  deps: string[];  // Format: "replicaId:seq"
}
```

### replay(): Rejouer le Log

Rejouer les opérations pour debugging ou analyse:

```typescript
// Rejouer tout le log
const finalState = crdt.replay();
console.log('Final state:', finalState);

// Rejouer une portion
const partialState = crdt.replay({
  fromIndex: 0,
  toIndex: 10,  // Premières 10 ops seulement
  onOp: (op, index) => {
    console.log(`Replaying op ${index}: ${op.kind} at ${JSON.stringify(op.path)}`);
  }
});

console.log('State after 10 ops:', partialState);
```

Utile pour:

- Debugger des problèmes de convergence
- Analyser l'évolution de l'état
- Tester des scénarios de synchronisation
- Comprendre l'ordre d'application des ops

## Analyse de Snapshots

### diff(): Comparer Deux Snapshots

```typescript
const snap1 = crdt.snapshot();

// Modifier l'état...
crdt.set(['x'], 10);
crdt.del(['y']);
crdt.set(['z'], 30);

const snap2 = crdt.snapshot();

// Comparer
const diff = JSONCrdt.diffSnapshots(snap1, snap2);

console.log('Vector Clock changes:');
diff.vcChanges.forEach(({ replica, before, after }) => {
  console.log(`  ${replica}: ${before} → ${after}`);
});

console.log('\nLWW changes:');
console.log('  Added:', diff.lwwChanges.added);
console.log('  Removed:', diff.lwwChanges.removed);
console.log('  Modified:', diff.lwwChanges.modified);

console.log('\nTombstone changes:');
console.log('  Added:', diff.tombstoneChanges.added);
console.log('  Removed:', diff.tombstoneChanges.removed);

console.log('\nHLC diff:', diff.hlcDiff.before, '→', diff.hlcDiff.after);
```

Interface:

```typescript
interface SnapshotDiff {
  docChanges: Array<{
    path: Path;
    before?: JsonValue;
    after?: JsonValue;
    type: 'added' | 'removed' | 'modified';
  }>;
  vcChanges: Array<{
    replica: ReplicaId;
    before: number;
    after: number;
  }>;
  hlcDiff: {
    before: Hlc;
    after: Hlc;
  };
  lwwChanges: {
    added: string[];
    removed: string[];
    modified: string[];
  };
  tombstoneChanges: {
    added: string[];
    removed: string[];
  };
}
```

## Logging Structuré

Le CRDT utilise le logger de distflow avec contexte causal enrichi:

```typescript
import { configureLogger } from '@distflow/core';

// Activer debug logs
configureLogger({
  level: 'debug',
  transport: 'pretty'  // Dev mode
});

const crdt = new JSONCrdt('replica-1');

// Les logs incluent automatiquement:
// - replicaId (tronqué à 8 chars)
// - opId pour chaque opération
// - path affecté
// - hlc et vector clock
// - Type de conflit détecté
```

Exemples de logs:

```
2026-02-07T18:14:29.497Z DEBUG  Local SET {"component":"json-crdt"}
  {"replicaId":"replica-1","path":["user","name"],"opId":"replica-1:mlcmw...","hlc":{"t":1770488069497,"c":1,"r":"replica-1"},"vc":{"replica-1":1}}

2026-02-07T18:14:29.498Z WARN   SET rejected: newer tombstone exists {"component":"json-crdt"}
  {"path":["data","x"],"setHlc":{"t":1770488069497,"c":1,"r":"replica-1"},"tombstoneHlc":{"t":1770488069498,"c":3,"r":"replica-1"}}

2026-02-07T18:14:29.499Z DEBUG  Remote op applied {"component":"json-crdt"}
  {"replicaId":"replica-1","opId":"replica-2:mlcmy...","src":"replica-2","kind":"set","path":["product","name"]}
```

## Patterns d'Utilisation

### Dashboard de Monitoring

```typescript
class CrdtMonitor {
  constructor(crdt) {
    this.crdt = crdt;
    this.startTime = Date.now();
    
    setInterval(() => this.report(), 10000); // Toutes les 10s
  }
  
  report() {
    const metrics = this.crdt.getMetrics();
    const uptime = (Date.now() - this.startTime) / 1000;
    
    console.log('\n=== CRDT Metrics ===');
    console.log(`Uptime: ${uptime}s`);
    console.log(`Total ops: ${metrics.totalOps}`);
    console.log(`Ops/sec: ${metrics.opsPerSecond.toFixed(2)}`);
    console.log(`Latency: ${metrics.avgLatencyMs.toFixed(2)}ms`);
    console.log(`Conflicts: ${metrics.totalConflicts}`);
    console.log(`Log size: ${metrics.logSize}`);
    console.log(`Pending: ${metrics.pendingSize}`);
    console.log(`GC runs: ${metrics.gcRuns}`);
  }
}

const monitor = new CrdtMonitor(crdt);
```

### Détection d'Anomalies

```typescript
function detectAnomalies(crdt) {
  const metrics = crdt.getMetrics();
  
  // Latence trop élevée
  if (metrics.avgLatencyMs > 100) {
    console.warn(`High latency detected: ${metrics.avgLatencyMs}ms`);
  }
  
  // Trop de conflits
  const conflictRate = metrics.totalConflicts / metrics.totalOps;
  if (conflictRate > 0.1) {  // Plus de 10%
    console.warn(`High conflict rate: ${(conflictRate * 100).toFixed(1)}%`);
  }
  
  // Pending buffer qui grossit
  if (metrics.pendingSize > 100) {
    console.warn(`Large pending buffer: ${metrics.pendingSize}`);
    
    const inspection = crdt.inspect({ pendingSampleSize: 5 });
    console.log('Sample of pending ops:', inspection.pendingSample);
  }
  
  // Log qui grossit trop
  if (metrics.logSize > 10000) {
    console.warn(`Large log detected: ${metrics.logSize}`);
    console.log('Consider running manual GC or adjusting thresholds');
  }
}

// Vérifier périodiquement
setInterval(() => detectAnomalies(crdt), 5000);
```

### Debug de Convergence

```typescript
function debugConvergence(crdt1, crdt2) {
  const snap1 = crdt1.snapshot();
  const snap2 = crdt2.snapshot();
  
  const diff = JSONCrdt.diffSnapshots(snap1, snap2);
  
  if (diff.vcChanges.length > 0) {
    console.log('Vector clocks differ:');
    diff.vcChanges.forEach(({ replica, before, after }) => {
      console.log(`  ${replica}: ${before} vs ${after}`);
    });
  }
  
  if (diff.lwwChanges.added.length > 0 || diff.lwwChanges.removed.length > 0) {
    console.log('LWW maps differ:');
    console.log('  Paths only in crdt1:', diff.lwwChanges.removed);
    console.log('  Paths only in crdt2:', diff.lwwChanges.added);
  }
  
  if (JSON.stringify(snap1.doc) !== JSON.stringify(snap2.doc)) {
    console.log('Documents differ:');
    console.log('  Crdt1:', snap1.doc);
    console.log('  Crdt2:', snap2.doc);
  } else {
    console.log('✓ Replicas have converged');
  }
}
```

## Intégration avec Prometheus/Grafana

```typescript
// Exporter les métriques au format Prometheus
function prometheusMetrics(crdt) {
  const metrics = crdt.getMetrics();
  const replicaId = crdt.getReplicaId().substring(0, 8);
  
  return `
# HELP crdt_operations_total Total number of operations
# TYPE crdt_operations_total counter
crdt_operations_total{replica="${replicaId}",type="total"} ${metrics.totalOps}
crdt_operations_total{replica="${replicaId}",type="local"} ${metrics.localOps}
crdt_operations_total{replica="${replicaId}",type="remote"} ${metrics.remoteOps}

# HELP crdt_operations_per_second Operations per second
# TYPE crdt_operations_per_second gauge
crdt_operations_per_second{replica="${replicaId}"} ${metrics.opsPerSecond}

# HELP crdt_latency_milliseconds Average operation latency
# TYPE crdt_latency_milliseconds gauge
crdt_latency_milliseconds{replica="${replicaId}"} ${metrics.avgLatencyMs}

# HELP crdt_conflicts_total Total conflicts detected
# TYPE crdt_conflicts_total counter
crdt_conflicts_total{replica="${replicaId}",type="total"} ${metrics.totalConflicts}
crdt_conflicts_total{replica="${replicaId}",type="tombstone"} ${metrics.tombstoneConflicts}
crdt_conflicts_total{replica="${replicaId}",type="path"} ${metrics.pathConflicts}

# HELP crdt_log_size Current log size
# TYPE crdt_log_size gauge
crdt_log_size{replica="${replicaId}"} ${metrics.logSize}

# HELP crdt_pending_size Current pending buffer size
# TYPE crdt_pending_size gauge
crdt_pending_size{replica="${replicaId}"} ${metrics.pendingSize}
  `.trim();
}

// HTTP endpoint pour Prometheus scraping
app.get('/metrics', (req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(prometheusMetrics(crdt));
});
```

## Références

- [CRDT Core Documentation](./CRDT.md)
- [Logger Documentation](./LOGGER.md)
- [Tests d'observabilité](../../test/observability-test.js)
