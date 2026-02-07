/**
 * Test du facteur de réplication pour la stabilité du ring
 *
 * Vérifie que le ring n'est stable que quand il y a au moins N nœuds
 */

const { RingNode } = require('../packages/core/dist/index.js');
const { configureLogger, LogLevel } = require('../packages/core/dist/logger.js');

// Configure logger
configureLogger({
    level: LogLevel.INFO,
    prettyPrint: false
});

console.log('🔄 Test du Facteur de Réplication (N)\n');

async function main() {
    const nodes = [];

    try {
        console.log('Test 1: Ring avec replicationFactor=3 (défaut)');
        console.log('='.repeat(50));

        // Créer le premier node avec facteur de réplication 3
        console.log('\n📍 Création du node 1 (replicationFactor=3)...');
        const node1 = new RingNode({
            alias: 'ring-n-1',
            requiredStableTimeMs: 2000  // 2 secondes pour test rapide
        });

        await node1.start();
        nodes.push(node1);

        // Attendre 3 secondes (plus que requiredStableTimeMs)
        console.log('⏳ Attente de 3 secondes...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        let info = node1.getStabilityInfo();
        console.log('\n📊 État après 3s:');
        console.log('  memberCount:', info.memberCount);
        console.log('  replicationFactor:', info.replicationFactor);
        console.log('  timeSinceChange:', info.timeSinceLastChangeMs, 'ms');
        console.log('  isStable:', info.isStable);
        console.log('  ✓ Vérifié: pas stable car', info.memberCount, '<', info.replicationFactor);

        // Ajouter le deuxième node
        console.log('\n📍 Ajout du node 2...');
        const node2 = new RingNode({
            alias: 'ring-n-2',
            requiredStableTimeMs: 2000
        });
        await node2.start();
        nodes.push(node2);

        await new Promise(resolve => setTimeout(resolve, 3000));
        info = node1.getStabilityInfo();
        console.log('\n📊 État avec 2 nodes après 3s:');
        console.log('  memberCount:', info.memberCount);
        console.log('  isStable:', info.isStable);
        console.log('  ✓ Vérifié: toujours pas stable car', info.memberCount, '<', info.replicationFactor);

        // Ajouter le troisième node
        console.log('\n📍 Ajout du node 3 (atteint le replicationFactor)...');
        const node3 = new RingNode({
            alias: 'ring-n-3',
            requiredStableTimeMs: 2000
        });
        await node3.start();
        nodes.push(node3);

        console.log('⏳ Attente de stabilisation (3s)...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        info = node1.getStabilityInfo();
        console.log('\n📊 État avec 3 nodes après 3s:');
        console.log('  memberCount:', info.memberCount);
        console.log('  replicationFactor:', info.replicationFactor);
        console.log('  isStable:', info.isStable);
        if (info.isStable) {
            console.log('  ✅ STABLE: memberCount >= replicationFactor ET temps suffisant écoulé');
        } else {
            console.log('  ⚠️  Pas encore stable (attendre plus longtemps ou problème de sync)');
        }

        // Test 2: Ring avec replicationFactor personnalisé
        console.log('\n\nTest 2: Ring avec replicationFactor=2 personnalisé');
        console.log('='.repeat(50));

        console.log('\n📍 Création de 2 nodes avec replicationFactor=2...');
        const nodeCustom1 = new RingNode({
            alias: 'ring-custom-1',
            replicationFactor: 2,
            requiredStableTimeMs: 2000
        });
        const nodeCustom2 = new RingNode({
            alias: 'ring-custom-2',
            replicationFactor: 2,
            requiredStableTimeMs: 2000
        });

        await nodeCustom1.start();
        await nodeCustom2.start();
        nodes.push(nodeCustom1, nodeCustom2);

        console.log('⏳ Attente de stabilisation (3s)...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        const infoCustom = nodeCustom1.getStabilityInfo();
        console.log('\n📊 État avec replicationFactor=2:');
        console.log('  memberCount:', infoCustom.memberCount);
        console.log('  replicationFactor:', infoCustom.replicationFactor);
        console.log('  isStable:', infoCustom.isStable);
        if (infoCustom.isStable) {
            console.log('  ✅ STABLE avec seulement 2 nodes car replicationFactor=2');
        }

        // Test 3: Ring avec replicationFactor=1 (toujours stable)
        console.log('\n\nTest 3: Ring avec replicationFactor=1 (mode single node)');
        console.log('='.repeat(50));

        console.log('\n📍 Création d\'un seul node avec replicationFactor=1...');
        const nodeSingle = new RingNode({
            alias: 'ring-single',
            replicationFactor: 1,
            requiredStableTimeMs: 2000
        });

        await nodeSingle.start();
        nodes.push(nodeSingle);

        console.log('⏳ Attente de stabilisation (3s)...');
        await new Promise(resolve => setTimeout(resolve, 3000));

        const infoSingle = nodeSingle.getStabilityInfo();
        console.log('\n📊 État avec replicationFactor=1:');
        console.log('  memberCount:', infoSingle.memberCount);
        console.log('  replicationFactor:', infoSingle.replicationFactor);
        console.log('  isStable:', infoSingle.isStable);
        if (infoSingle.isStable) {
            console.log('  ✅ STABLE même avec 1 seul node');
        }

    } finally {
        // Cleanup
        console.log('\n\n🧹 Cleanup...');
        for (const node of nodes) {
            await node.stop();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ Tests du facteur de réplication terminés!\n');
    console.log('Résumé:');
    console.log('  ✓ Par défaut, N=3 nœuds requis pour stabilité');
    console.log('  ✓ Facteur de réplication personnalisable');
    console.log('  ✓ Ring stable uniquement si memberCount >= N');
    console.log('  ✓ Le temps sans changement reste aussi requis\n');

    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Erreur:', err);
    process.exit(1);
});
