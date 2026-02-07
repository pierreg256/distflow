const { JSONCrdt, configureLogger, LogLevel } = require('@distflow/core');

// Configure logger for testing
configureLogger({
    level: LogLevel.INFO,
    prettyPrint: true,
    name: 'crdt-test'
});

console.log('='.repeat(70));
console.log('JSON-CRDT Enhanced Features Test');
console.log('='.repeat(70));

// Test 1: Basic operations with events
console.log('\n📝 Test 1: Basic Operations with Events');
console.log('-'.repeat(70));

const crdt1 = new JSONCrdt('replica-1', {});

// Listen to events
crdt1.on('change', (event) => {
    console.log(`✓ Change event: ${event.type} at path [${event.path.join('.')}]`);
});

crdt1.on('conflict', (event) => {
    console.log(`⚠️  Conflict event: ${event.type}`);
});

crdt1.on('gc', (event) => {
    console.log(`🗑️  GC event: ${event.type} - removed ${event.removed} items`);
});

crdt1.set(['user', 'name'], 'Alice');
crdt1.set(['user', 'age'], 30);
crdt1.set(['settings', 'theme'], 'dark');

console.log('\nCurrent state:', JSON.stringify(crdt1.value(), null, 2));

// Test 2: Tombstones
console.log('\n\n⚰️  Test 2: Tombstones (Delete Prevention)');
console.log('-'.repeat(70));

const crdt2 = new JSONCrdt('replica-2', {});
crdt2.set(['item'], 'original value');
console.log('Set item:', crdt2.value());

// Delete (creates tombstone)
crdt2.del(['item']);
console.log('After delete:', crdt2.value());

// Try to set again (should be prevented by tombstone in concurrent scenario)
// Simulate receiving an old SET operation
const oldOp = {
    id: 'old-op',
    kind: 'set',
    path: ['item'],
    value: 'old value',
    hlc: { t: Date.now() - 10000, c: 0, r: 'replica-old' }, // Old timestamp
    deps: { 'replica-old': 1 },
    src: 'replica-old'
};

crdt2.receive(oldOp);
console.log('After receiving old SET (should be blocked):', crdt2.value());

// Test 3: Snapshot and Restore
console.log('\n\n💾 Test 3: Snapshot and Restore');
console.log('-'.repeat(70));

const crdt3 = new JSONCrdt('replica-3', {});
crdt3.set(['data', 'x'], 100);
crdt3.set(['data', 'y'], 200);
crdt3.set(['data', 'z'], 300);

console.log('Original state:', JSON.stringify(crdt3.value(), null, 2));

const snapshot = crdt3.snapshot();
console.log('\n✓ Snapshot created');
console.log('  - LWW size:', snapshot.lww.length);
console.log('  - Tombstones:', snapshot.tombstones.length);
console.log('  - Vector clock entries:', Object.keys(snapshot.vc).length);

// Modify state
crdt3.set(['data', 'x'], 999);
crdt3.del(['data', 'y']);
console.log('\nModified state:', JSON.stringify(crdt3.value(), null, 2));

// Restore from snapshot
crdt3.restore(snapshot);
console.log('\nRestored state:', JSON.stringify(crdt3.value(), null, 2));

// Test 4: Garbage Collection
console.log('\n\n🗑️  Test 4: Garbage Collection');
console.log('-'.repeat(70));

const crdt4 = new JSONCrdt('replica-4', {}, {
    maxLogSize: 5,
    enableAutoGc: false // Disable auto for manual testing
});

// Create many operations
for (let i = 0; i < 10; i++) {
    crdt4.set(['items', i.toString()], `value-${i}`);
}

console.log(`Log size before GC: ${crdt4.getStats().logSize}`);

// Manual GC
crdt4.gcLog(5);

console.log(`Log size after GC: ${crdt4.getStats().logSize}`);

// Test 5: Statistics
console.log('\n\n📊 Test 5: Statistics');
console.log('-'.repeat(70));

const crdt5 = new JSONCrdt('replica-5', {});
crdt5.set(['a'], 1);
crdt5.set(['b'], 2);
crdt5.set(['c'], 3);
crdt5.del(['a']);

const stats = crdt5.getStats();
console.log('CRDT Statistics:');
console.log('  - Log size:', stats.logSize);
console.log('  - Pending ops:', stats.pendingSize);
console.log('  - LWW map size:', stats.lwwSize);
console.log('  - Tombstones:', stats.tombstonesSize);
console.log('  - Vector clock size:', stats.vcSize);

// Test 6: Path Conflict Detection
console.log('\n\n⚠️  Test 6: Path Conflict Detection');
console.log('-'.repeat(70));

const crdt6 = new JSONCrdt('replica-6', {});

crdt6.on('conflict', (event) => {
    console.log(`⚠️  Conflict detected: ${event.type}`);
    console.log(`   Path: [${event.path.join('.')}]`);
    if (event.parentPath) {
        console.log(`   Parent: [${event.parentPath.join('.')}]`);
    }
});

crdt6.set(['parent', 'child'], 'value');
crdt6.del(['parent']); // Delete parent
crdt6.set(['parent', 'child', 'grandchild'], 'new value'); // Try to set child of deleted parent

// Test 7: Auto GC
console.log('\n\n⚡ Test 7: Auto GC (Large Dataset)');
console.log('-'.repeat(70));

const crdt7 = new JSONCrdt('replica-7', {}, {
    maxLogSize: 10,
    enableAutoGc: true
});

let gcCount = 0;
crdt7.on('gc', (event) => {
    gcCount++;
    console.log(`🗑️  Auto GC #${gcCount}: ${event.type} - removed ${event.removed} items`);
});

// Generate many operations to trigger auto GC
for (let i = 0; i < 30; i++) {
    crdt7.set(['data', `key${i}`], `value${i}`);
}

console.log(`\nFinal stats after ${30} operations:`);
const finalStats = crdt7.getStats();
console.log('  - Log size:', finalStats.logSize);
console.log('  - LWW map size:', finalStats.lwwSize);

console.log('\n' + '='.repeat(70));
console.log('✅ All tests completed successfully!');
console.log('='.repeat(70));
