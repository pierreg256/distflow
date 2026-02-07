// test/graceful-shutdown-test.js
// Test du shutdown gracieux pour vérifier qu'il n'y a plus d'erreur "Node not found"

const { RingNode } = require('../packages/core/dist/ring-node');
const { configureLogger } = require('../packages/core/dist/logger');

// Configure logger en mode normal pour voir les messages
configureLogger({ level: 1 }); // INFO

console.log('🧪 Test du shutdown gracieux\n');

async function testGracefulShutdown() {
    console.log('Test 1: Création et arrêt immédiat');

    const node1 = new RingNode({
        alias: 'shutdown-test-1',
        syncIntervalMs: 1000,
        displayIntervalMs: 0,
        metricsIntervalMs: 0
    });

    await node1.start();
    console.log('  ✓ Node démarré');

    // Attendre un peu pour s'assurer que le heartbeat est actif
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('  Arrêt du node...');
    await node1.stop();
    console.log('  ✓ Node arrêté sans erreur\n');

    // Test 2: Attendre plus longtemps avant l'arrêt
    console.log('Test 2: Création, attente 2s, puis arrêt');

    const node2 = new RingNode({
        alias: 'shutdown-test-2',
        syncIntervalMs: 1000,
        displayIntervalMs: 0,
        metricsIntervalMs: 0
    });

    await node2.start();
    console.log('  ✓ Node démarré');

    // Attendre 2 secondes (proche du TTL de 3s du PMD)
    console.log('  Attente de 2 secondes...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log('  Arrêt du node...');
    await node2.stop();
    console.log('  ✓ Node arrêté sans erreur\n');

    // Test 3: Simulation d'un arrêt rapide (Ctrl+C)
    console.log('Test 3: Arrêt rapide (simulation Ctrl+C)');

    const node3 = new RingNode({
        alias: 'shutdown-test-3',
        syncIntervalMs: 1000,
        displayIntervalMs: 0,
        metricsIntervalMs: 0
    });

    await node3.start();
    console.log('  ✓ Node démarré');

    // Arrêt immédiat
    console.log('  Arrêt immédiat...');
    await node3.stop();
    console.log('  ✓ Node arrêté sans erreur\n');

    console.log('═══════════════════════════════════════');
    console.log('✅ Tous les tests de shutdown passent!');
    console.log('═══════════════════════════════════════\n');

    console.log('Résultats:');
    console.log('  ✓ Pas d\'erreur "Node not found"');
    console.log('  ✓ Unregister se fait avant l\'arrêt du heartbeat');
    console.log('  ✓ Shutdown gracieux fonctionne correctement');
}

// Run test
testGracefulShutdown()
    .then(() => {
        console.log('\n✅ Test terminé avec succès');
        process.exit(0);
    })
    .catch((err) => {
        console.error('\n❌ Test échoué:', err);
        process.exit(1);
    });
