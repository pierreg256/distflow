// examples/crdt-observability-example.ts
import {
  JSONCrdt,
  getLogger,
  //CrdtMetrics,
} from '@distflow/core';

const logger = getLogger('observability-example');

/**
 * Example 1: Real-time metrics monitoring
 */
function monitoringExample() {
  logger.info('=== Example 1: Real-time Metrics Monitoring ===');

  const crdt = new JSONCrdt('monitoring-replica', {});

  // Setup event listeners
  let changeCount = 0;
  let conflictCount = 0;

  crdt.on('change', ({ type, path }) => {
    changeCount++;
    logger.debug(`Change #${changeCount}: ${type} at ${JSON.stringify(path)}`);
  });

  crdt.on('conflict', ({ type, path }) => {
    conflictCount++;
    logger.warn(`Conflict #${conflictCount}: ${type} at ${JSON.stringify(path)}`);
  });

  // Perform operations
  crdt.set(['user', 'name'], 'Alice');
  crdt.set(['user', 'age'], 30);
  crdt.set(['user', 'email'], 'alice@example.com');

  // Get metrics
  const metrics = crdt.getMetrics();
  logger.info('Metrics:', {
    totalOps: metrics.totalOps,
    opsPerSecond: metrics.opsPerSecond.toFixed(2),
    avgLatency: metrics.avgLatencyMs.toFixed(2) + 'ms',
    conflicts: metrics.totalConflicts,
  });

  logger.info('Event counts:', { changeCount, conflictCount });
  logger.info('');
}

/**
 * Example 2: Debugging with inspect()
 */
function inspectionExample() {
  logger.info('=== Example 2: State Inspection ===');

  const crdt = new JSONCrdt('inspect-replica', { initial: 'state' });

  // Create some state
  crdt.set(['tasks', 'task1'], { title: 'Learn CRDT', done: false });
  crdt.set(['tasks', 'task2'], { title: 'Build app', done: false });
  crdt.set(['tasks', 'task3'], { title: 'Deploy', done: false });
  crdt.del(['tasks', 'task1']); // Mark first task as deleted

  // Inspect internal state
  const inspection = crdt.inspect({
    logSampleSize: 5,
    includeCausalGraph: true,
  });

  logger.info('Inspection:', {
    replicaId: inspection.replicaId.substring(0, 20) + '...',
    logSize: inspection.logSize,
    lwwPaths: inspection.lwwPaths.length,
    tombstonePaths: inspection.tombstonePaths.length,
    causalGraphNodes: inspection.causalGraph?.length,
  });

  logger.debug('Last operations:', inspection.logSample.map((op) => ({
    kind: op.kind,
    path: op.path,
  })));

  logger.info('');
}

/**
 * Example 3: Snapshot comparison
 */
function snapshotDiffExample() {
  logger.info('=== Example 3: Snapshot Diff ===');

  const crdt = new JSONCrdt('diff-replica', {});

  // Initial state
  crdt.set(['version'], 1);
  crdt.set(['features', 'auth'], true);
  crdt.set(['features', 'payments'], false);
  const snap1 = crdt.snapshot();

  // Modify state
  crdt.set(['version'], 2); // Modified
  crdt.del(['features', 'payments']); // Deleted
  crdt.set(['features', 'analytics'], true); // Added
  const snap2 = crdt.snapshot();

  // Compare snapshots
  const diff = JSONCrdt.diffSnapshots(snap1, snap2);

  logger.info('Snapshot diff:', {
    vcChanges: diff.vcChanges.map((c) => ({
      replica: c.replica.substring(0, 10) + '...',
      delta: c.after - c.before,
    })),
    lwwAdded: diff.lwwChanges.added,
    lwwModified: diff.lwwChanges.modified,
    tombstonesAdded: diff.tombstoneChanges.added,
  });

  logger.info('');
}

/**
 * Example 4: Log replay for debugging
 */
function replayExample() {
  logger.info('=== Example 4: Log Replay ===');

  const crdt = new JSONCrdt('replay-replica', {});

  // Create a sequence of operations
  crdt.set(['counter'], 0);
  crdt.set(['counter'], 1);
  crdt.set(['counter'], 2);
  crdt.set(['counter'], 3);
  crdt.set(['counter'], 4);
  crdt.set(['status'], 'active');

  logger.info('Full state:', crdt.value() as any);

  // Replay only first 3 operations
  logger.info('Replaying first 3 operations:');
  let opCount = 0;
  const partialState = crdt.replay({
    fromIndex: 0,
    toIndex: 3,
    onOp: (op, index) => {
      opCount++;
      logger.debug(`  Op ${index}: ${op.kind} at ${JSON.stringify(op.path)} = ${op.value}`);
    },
  });

  logger.info('State after replay:', partialState as any);
  logger.info(`Replayed ${opCount} operations`);
  logger.info('');
}

/**
 * Example 5: Causal graph visualization
 */
function causalGraphExample() {
  logger.info('=== Example 5: Causal Graph ===');

  const crdt = new JSONCrdt('graph-replica', {});

  // Create operations with dependencies
  crdt.set(['step1'], 'initialize');
  crdt.set(['step2'], 'process');
  crdt.set(['step3'], 'finalize');

  const graph = crdt.getCausalGraph();

  logger.info('Causal graph:', {
    nodes: graph.length,
  });

  graph.forEach((node, i) => {
    logger.debug(`Node ${i}:`, {
      opId: node.opId.substring(0, 20) + '...',
      kind: node.kind,
      path: node.path,
      hlc: `t=${node.hlc.t}, c=${node.hlc.c}`,
      deps: node.deps,
    });
  });

  logger.info('');
}

/**
 * Example 6: Conflict detection and monitoring
 */
function conflictExample() {
  logger.info('=== Example 6: Conflict Detection ===');

  const crdt = new JSONCrdt('conflict-replica', {});

  let conflicts: any[] = [];
  crdt.on('conflict', (conflict) => {
    conflicts.push(conflict);
  });

  // Create path conflict (parent becomes tombstone)
  crdt.set(['parent', 'child', 'value'], 'data');
  crdt.del(['parent']); // Delete parent
  crdt.set(['parent', 'child', 'other'], 'conflict'); // Try to set child

  const metrics = crdt.getMetrics();
  logger.info('Conflict metrics:', {
    total: metrics.totalConflicts,
    tombstone: metrics.tombstoneConflicts,
    path: metrics.pathConflicts,
  });

  logger.info('Detected conflicts:', conflicts.map((c) => ({
    type: c.type,
    path: c.path,
  })));

  logger.info('');
}

/**
 * Example 7: Performance monitoring
 */
function performanceExample() {
  logger.info('=== Example 7: Performance Monitoring ===');

  const crdt = new JSONCrdt('perf-replica', {});

  // Simulate load
  const startTime = Date.now();
  const opCount = 1000;

  logger.info(`Performing ${opCount} operations...`);
  for (let i = 0; i < opCount; i++) {
    crdt.set(['data', `key${i % 100}`], i);
  }

  const duration = Date.now() - startTime;
  const metrics = crdt.getMetrics();

  logger.info('Performance results:', {
    totalOps: metrics.totalOps,
    duration: duration + 'ms',
    throughput: (opCount / (duration / 1000)).toFixed(2) + ' ops/sec',
    avgLatency: metrics.avgLatencyMs.toFixed(3) + 'ms',
    logSize: metrics.logSize,
    gcRuns: metrics.gcRuns,
  });

  logger.info('');
}

/**
 * Example 8: Custom monitoring dashboard
 */
class CrdtDashboard {
  private crdt: JSONCrdt;
  private startTime: number;
  private interval: NodeJS.Timeout;

  constructor(crdt: JSONCrdt, reportIntervalMs = 5000) {
    this.crdt = crdt;
    this.startTime = Date.now();

    this.interval = setInterval(() => this.report(), reportIntervalMs);
  }

  private report() {
    const metrics = this.crdt.getMetrics();
    const uptime = ((Date.now() - this.startTime) / 1000).toFixed(1);

    const dashboard = {
      uptime: uptime + 's',
      operations: {
        total: metrics.totalOps,
        local: metrics.localOps,
        remote: metrics.remoteOps,
        perSecond: metrics.opsPerSecond.toFixed(2),
      },
      performance: {
        avgLatency: metrics.avgLatencyMs.toFixed(2) + 'ms',
      },
      conflicts: {
        total: metrics.totalConflicts,
        rate: ((metrics.totalConflicts / metrics.totalOps) * 100).toFixed(1) + '%',
      },
      state: {
        logSize: metrics.logSize,
        pendingSize: metrics.pendingSize,
        lwwSize: metrics.lwwSize,
        tombstones: metrics.tombstonesSize,
      },
      gc: {
        runs: metrics.gcRuns,
        removedFromLog: metrics.gcLogOps,
        removedTombstones: metrics.gcTombstones,
      },
    };

    logger.info('=== CRDT Dashboard ===', dashboard);
  }

  stop() {
    clearInterval(this.interval);
  }
}

function dashboardExample() {
  logger.info('=== Example 8: Monitoring Dashboard ===');

  const crdt = new JSONCrdt('dashboard-replica', {}, { maxLogSize: 50 });
  const dashboard = new CrdtDashboard(crdt, 3000);

  // Simulate activity
  let counter = 0;
  const activity = setInterval(() => {
    crdt.set(['counter'], counter++);
    crdt.set(['timestamp'], Date.now());

    if (counter >= 20) {
      clearInterval(activity);
      setTimeout(() => {
        dashboard.stop();
        logger.info('Dashboard stopped.');
        logger.info('');
      }, 3000);
    }
  }, 200);
}

// Run all examples
async function main() {
  monitoringExample();
  inspectionExample();
  snapshotDiffExample();
  replayExample();
  causalGraphExample();
  conflictExample();
  performanceExample();
  dashboardExample();
}

main().catch(console.error);
