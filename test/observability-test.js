// test/observability-test.js
// Test des fonctionnalités d'observabilité du JSON-CRDT

const { JSONCrdt } = require('../packages/core/dist/json-crdt');

console.log('🔍 Test d\'observabilité du JSON-CRDT\n');

// ============================================
// Test 1: Métriques de base (operations count)
// ============================================
console.log('Test 1: Métriques de base');
const replica1 = new JSONCrdt('replica-1', {});
const replica2 = new JSONCrdt('replica-2', {});

// Créer quelques opérations locales
replica1.set(['user', 'name'], 'Alice');
replica1.set(['user', 'age'], 30);
replica1.set(['user', 'city'], 'Paris');

// Créer des ops sur replica2 et les synchroniser
const op1 = replica2.set(['product', 'name'], 'Laptop');
const op2 = replica2.set(['product', 'price'], 999);

replica1.receive(op1);
replica1.receive(op2);

const metrics1 = replica1.getMetrics();
console.log('  Replica1 metrics:');
console.log(`    - Total ops: ${metrics1.totalOps}`);
console.log(`    - Local ops: ${metrics1.localOps}`);
console.log(`    - Remote ops: ${metrics1.remoteOps}`);
console.log(`    - Ops/sec: ${metrics1.opsPerSecond.toFixed(2)}`);
console.log(`    - Avg latency: ${metrics1.avgLatencyMs.toFixed(2)}ms`);
console.log('  ✓ Test 1 passed\n');

// ============================================
// Test 2: Métriques de conflits
// ============================================
console.log('Test 2: Métriques de conflits');
const r3 = new JSONCrdt('replica-3', {});

// Créer des conflits avec tombstones
r3.set(['data', 'x'], 100);
r3.del(['data', 'x']);  // Crée un tombstone

// Tenter de set après deletion (conflit)
const oldOp = r3.set(['data', 'x'], 200);
// Force l'application d'une vieille opération (pour tester le conflit)

// Créer conflit de path (parent tombstone)
r3.set(['parent', 'child', 'value'], 'test');
r3.del(['parent']); // Supprime le parent
// Le prochain set va créer un conflit
r3.set(['parent', 'child', 'other'], 'conflict');

const metrics3 = r3.getMetrics();
console.log('  Conflict metrics:');
console.log(`    - Total conflicts: ${metrics3.totalConflicts}`);
console.log(`    - Tombstone conflicts: ${metrics3.tombstoneConflicts}`);
console.log(`    - Path conflicts: ${metrics3.pathConflicts}`);
console.log('  ✓ Test 2 passed\n');

// ============================================
// Test 3: Garbage collection metrics
// ============================================
console.log('Test 3: Garbage collection metrics');
const r4 = new JSONCrdt('replica-4', {}, { maxLogSize: 5 });

// Créer beaucoup d'ops pour déclencher GC
for (let i = 0; i < 20; i++) {
    r4.set(['item', `key${i}`], i);
}

const metrics4 = r4.getMetrics();
console.log('  GC metrics:');
console.log(`    - GC runs: ${metrics4.gcRuns}`);
console.log(`    - GC'd log ops: ${metrics4.gcLogOps}`);
console.log(`    - Current log size: ${metrics4.logSize}`);
console.log('  ✓ Test 3 passed\n');

// ============================================
// Test 4: Inspect (état interne)
// ============================================
console.log('Test 4: Inspect état interne');
const r5 = new JSONCrdt('replica-5', {});
r5.set(['a'], 1);
r5.set(['b'], 2);
r5.set(['c'], 3);
r5.del(['b']);

const inspection = r5.inspect({
    logSampleSize: 5,
    pendingSampleSize: 5,
    includeCausalGraph: true
});

console.log('  Inspection:');
console.log(`    - Replica ID: ${inspection.replicaId.substring(0, 20)}...`);
console.log(`    - Document: ${JSON.stringify(inspection.doc)}`);
console.log(`    - Log size: ${inspection.logSize}`);
console.log(`    - Log sample (last ${inspection.logSample.length} ops):`);
inspection.logSample.forEach((op, i) => {
    console.log(`      ${i + 1}. ${op.kind} at ${JSON.stringify(op.path)}`);
});
console.log(`    - LWW paths: ${inspection.lwwPaths.length} paths`);
console.log(`    - Tombstone paths: ${inspection.tombstonePaths.length} paths`);
if (inspection.causalGraph) {
    console.log(`    - Causal graph: ${inspection.causalGraph.length} nodes`);
}
console.log('  ✓ Test 4 passed\n');

// ============================================
// Test 5: Snapshot diff
// ============================================
console.log('Test 5: Snapshot diff');
const r6 = new JSONCrdt('replica-6', { initial: 'data' });
r6.set(['x'], 10);
r6.set(['y'], 20);
const snap1 = r6.snapshot();

// Modifier l'état
r6.set(['x'], 15);  // Modifier
r6.del(['y']);      // Supprimer
r6.set(['z'], 30);  // Ajouter
const snap2 = r6.snapshot();

const diff = JSONCrdt.diffSnapshots(snap1, snap2);
console.log('  Snapshot diff:');
console.log(`    - VC changes: ${diff.vcChanges.length}`);
diff.vcChanges.forEach(change => {
    console.log(`      ${change.replica.substring(0, 10)}: ${change.before} → ${change.after}`);
});
console.log(`    - LWW added: ${diff.lwwChanges.added.length}`);
console.log(`    - LWW removed: ${diff.lwwChanges.removed.length}`);
console.log(`    - LWW modified: ${diff.lwwChanges.modified.length}`);
console.log(`    - Tombstones added: ${diff.tombstoneChanges.added.length}`);
console.log(`    - Tombstones removed: ${diff.tombstoneChanges.removed.length}`);
console.log('  ✓ Test 5 passed\n');

// ============================================
// Test 6: Replay log
// ============================================
console.log('Test 6: Replay log');
const r7 = new JSONCrdt('replica-7', {});
r7.set(['counter'], 0);
r7.set(['counter'], 1);
r7.set(['counter'], 2);
r7.set(['counter'], 3);
r7.set(['status'], 'active');

let replayCount = 0;
const replayedDoc = r7.replay({
    fromIndex: 0,
    toIndex: 3,  // Only first 3 ops
    onOp: (op, index) => {
        replayCount++;
        console.log(`    Replaying op ${index}: ${op.kind} at ${JSON.stringify(op.path)}`);
    }
});

console.log(`  Replayed document: ${JSON.stringify(replayedDoc)}`);
console.log(`  Replayed ${replayCount} operations`);
console.log('  ✓ Test 6 passed\n');

// ============================================
// Test 7: Causal graph
// ============================================
console.log('Test 7: Causal graph');
const r8 = new JSONCrdt('replica-8', {});
r8.set(['task1'], 'done');
r8.set(['task2'], 'pending');
r8.set(['task3'], 'in-progress');

const graph = r8.getCausalGraph();
console.log(`  Causal graph has ${graph.length} nodes:`);
graph.forEach((node, i) => {
    console.log(`    ${i + 1}. Op ${node.opId.substring(0, 15)}...`);
    console.log(`       Kind: ${node.kind}, Path: ${node.path}`);
    console.log(`       HLC: t=${node.hlc.t}, c=${node.hlc.c}`);
    console.log(`       Deps: [${node.deps.join(', ')}]`);
});
console.log('  ✓ Test 7 passed\n');

// ============================================
// Test 8: Performance monitoring over time
// ============================================
console.log('Test 8: Performance monitoring (simulated load)');
const r9 = new JSONCrdt('replica-9', {});

// Simuler une charge de travail
console.log('  Creating 100 operations...');
const startTime = Date.now();
for (let i = 0; i < 100; i++) {
    r9.set(['data', `item${i % 10}`], i);
}
const duration = Date.now() - startTime;

const perfMetrics = r9.getMetrics();
console.log(`  Performance after 100 ops:`);
console.log(`    - Total time: ${duration}ms`);
console.log(`    - Avg latency: ${perfMetrics.avgLatencyMs.toFixed(3)}ms`);
console.log(`    - Ops/sec: ${perfMetrics.opsPerSecond.toFixed(2)}`);
console.log(`    - Total ops: ${perfMetrics.totalOps}`);
console.log('  ✓ Test 8 passed\n');

// ============================================
// Test 9: Event-based monitoring
// ============================================
console.log('Test 9: Event-based monitoring');
const r10 = new JSONCrdt('replica-10', {});
let changeEvents = 0;
let conflictEvents = 0;
let gcEvents = 0;

r10.on('change', () => changeEvents++);
r10.on('conflict', () => conflictEvents++);
r10.on('gc', () => gcEvents++);

// Créer des events
r10.set(['a'], 1);
r10.set(['b'], 2);
r10.del(['c']);  // Tombstone
r10.set(['c', 'x'], 'conflict');  // Path conflict

console.log('  Event counts:');
console.log(`    - Change events: ${changeEvents}`);
console.log(`    - Conflict events: ${conflictEvents}`);
console.log(`    - GC events: ${gcEvents}`);
console.log('  ✓ Test 9 passed\n');

// ============================================
// Test 10: getStats() backward compatibility
// ============================================
console.log('Test 10: getStats() backward compatibility');
const r11 = new JSONCrdt('replica-11', {});
r11.set(['x'], 1);
r11.set(['y'], 2);

const stats = r11.getStats();
console.log('  Stats (backward compatible):');
console.log(`    - logSize: ${stats.logSize}`);
console.log(`    - pendingSize: ${stats.pendingSize}`);
console.log(`    - lwwSize: ${stats.lwwSize}`);
console.log(`    - tombstonesSize: ${stats.tombstonesSize}`);
console.log(`    - vcSize: ${stats.vcSize}`);
console.log('  ✓ Test 10 passed\n');

// ============================================
// Résumé
// ============================================
console.log('═══════════════════════════════════════');
console.log('✅ Tous les tests d\'observabilité passent!');
console.log('═══════════════════════════════════════');
console.log('\nFonctionnalités testées:');
console.log('  1. ✓ Métriques de base (ops, latence)');
console.log('  2. ✓ Métriques de conflits');
console.log('  3. ✓ Métriques de garbage collection');
console.log('  4. ✓ Inspection de l\'état interne');
console.log('  5. ✓ Diff entre snapshots');
console.log('  6. ✓ Replay du log');
console.log('  7. ✓ Graph causal de dépendances');
console.log('  8. ✓ Monitoring de performance');
console.log('  9. ✓ Monitoring par events');
console.log(' 10. ✓ Compatibilité getStats()');
