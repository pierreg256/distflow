/**
 * Test de détection de stabilité du Ring
 *
 * Démonstration de comment détecter quand le ring est stable
 */

const { RingNode } = require('../packages/core/dist/index.js');
const { configureLogger, LogLevel } = require('../packages/core/dist/logger.js');

// Configure logger
configureLogger({
    level: LogLevel.INFO,
    prettyPrint: false
});

console.log('🔄 Test de stabilité du Ring\n');

async function main() {
    const nodes = [];

    try {
        // Test 1: Créer 3 nodes et écouter les événements de stabilité
        console.log('Test 1: Événements de stabilité');
        console.log('='.repeat(50));

        // Créer le premier node
        console.log('\n📍 Création du premier node...');
        const node1 = new RingNode({ alias: 'ring-stable-1' });

        // Écouter les événements de stabilité
        node1.on('ring:stable', (info) => {
            console.log(`✅ [${node1.alias}] Ring STABLE:`, {
                memberCount: info.memberCount,
                timeSinceChange: `${info.timeSinceLastChangeMs}ms`,
                requiredTime: `${info.requiredStableTimeMs}ms`
            });
        });

        node1.on('ring:unstable', (info) => {
            console.log(`⚠️  [${node1.alias}] Ring UNSTABLE:`, {
                memberCount: info.memberCount,
                timeSinceChange: `${info.timeSinceLastChangeMs}ms`
            });
        });

        await node1.start();
        nodes.push(node1);

        // Attendre la stabilité du premier node
        console.log('⏳ Attente de stabilité du premier node...');
        const info1 = await node1.waitForStable(10000);
        console.log('✓ Node 1 est stable:', info1);

        // Ajouter un deuxième node (déclenche instabilité)
        console.log('\n📍 Ajout du deuxième node (va rendre le ring instable)...');
        const node2 = new RingNode({ alias: 'ring-stable-2' });

        node2.on('ring:stable', (info) => {
            console.log(`✅ [${node2.alias}] Ring STABLE:`, {
                memberCount: info.memberCount,
                timeSinceChange: `${info.timeSinceLastChangeMs}ms`
            });
        });

        await node2.start();
        nodes.push(node2);

        // Vérifier que le ring est instable (changement récent)
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('\n📊 État après ajout node 2:');
        console.log('  Node 1 stable?', node1.isStable());
        console.log('  Node 2 stable?', node2.isStable());

        // Attendre la re-stabilisation
        console.log('\n⏳ Attente de re-stabilisation...');
        await Promise.all([
            node1.waitForStable(15000),
            node2.waitForStable(15000)
        ]);
        console.log('✓ Les 2 nodes sont stables');

        // Ajouter un troisième node
        console.log('\n📍 Ajout du troisième node...');
        const node3 = new RingNode({ alias: 'ring-stable-3' });
        await node3.start();
        nodes.push(node3);

        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('\n📊 État après ajout node 3:');
        console.log('  Node 1 stable?', node1.isStable());
        console.log('  Node 2 stable?', node2.isStable());
        console.log('  Node 3 stable?', node3.isStable());

        // Test 2: Utilisation de getStabilityInfo()
        console.log('\n\nTest 2: Informations détaillées de stabilité');
        console.log('='.repeat(50));

        await new Promise(resolve => setTimeout(resolve, 2000));

        nodes.forEach((node, i) => {
            const info = node.getStabilityInfo();
            console.log(`\n📊 Node ${i + 1} (${node.alias}):`);
            console.log('  isStable:', info.isStable);
            console.log('  memberCount:', info.memberCount);
            console.log('  timeSinceLastChange:', `${info.timeSinceLastChangeMs}ms`);
            console.log('  required:', `${info.requiredStableTimeMs}ms`);
        });

        // Test 3: Attendre stabilité avec timeout court (devrait réussir)
        console.log('\n\nTest 3: Attente de stabilité avec timeout');
        console.log('='.repeat(50));

        try {
            const stableInfo = await node1.waitForStable(10000);
            console.log('✓ Ring stable:', stableInfo);
        } catch (err) {
            console.log('✗ Timeout atteint:', err.message);
        }

        // Test 4: Polling manuel de l'état de stabilité
        console.log('\n\nTest 4: Polling manuel');
        console.log('='.repeat(50));

        console.log('Vérification toutes les 500ms pendant 3s...');
        for (let i = 0; i < 6; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const stable = node1.isStable();
            const count = node1.getMemberCount();
            console.log(`  [${i * 500}ms] Stable: ${stable}, Members: ${count}`);
        }

        // Test 5: Tester avec suppression d'un node
        console.log('\n\nTest 5: Suppression d\'un node');
        console.log('='.repeat(50));

        console.log('\n📍 Suppression du node 3...');
        await node3.stop();
        nodes.pop();

        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('\n📊 État après suppression:');
        console.log('  Node 1 stable?', node1.isStable());
        console.log('  Node 2 stable?', node2.isStable());
        console.log('  Member count:', node1.getMemberCount());

        console.log('\n⏳ Attente de re-stabilisation après suppression...');
        await Promise.race([
            node1.waitForStable(10000),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 10000)
            )
        ]).then(
            () => console.log('✓ Ring re-stabilisé'),
            (err) => console.log('⚠️  ', err.message)
        );

    } finally {
        // Cleanup
        console.log('\n\n🧹 Cleanup...');
        for (const node of nodes) {
            await node.stop();
        }
        // Petit délai pour laisser le PMD se nettoyer
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n' + '='.repeat(50));
    console.log('✅ Tests de stabilité terminés!\n');
    console.log('Résumé des fonctionnalités testées:');
    console.log('  ✓ Événements ring:stable et ring:unstable');
    console.log('  ✓ Méthode isStable()');
    console.log('  ✓ Méthode getStabilityInfo()');
    console.log('  ✓ Méthode waitForStable()');
    console.log('  ✓ Méthode getMemberCount()');
    console.log('  ✓ React aux changements de topologie\n');

    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Erreur:', err);
    process.exit(1);
});
