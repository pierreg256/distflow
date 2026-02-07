/**
 * Exemple simple de détection de stabilité du Ring
 */

const { RingNode } = require('../packages/core/dist/index.js');
const { configureLogger, LogLevel } = require('../packages/core/dist/logger.js');

// Configuration minimale des logs
configureLogger({ level: LogLevel.INFO, prettyPrint: false });

async function main() {
    console.log('🔄 Exemple: Détection de Stabilité du Ring\n');
    console.log('ℹ️  Note: replicationFactor=1 pour simplifier l\'exemple\n');

    const nodes = [];

    try {
        // Créer le premier node
        console.log('📍 Création du node 1...');
        const node1 = new RingNode({
            alias: 'node-1',
            replicationFactor: 1,        // Minimum 1 nœud pour être stable
            requiredStableTimeMs: 3000   // 3 secondes pour l'exemple
        });

        // Écouter les événements
        node1.on('ring:stable', (info) => {
            console.log(`✅ [${node1.alias}] Ring STABLE - ${info.memberCount}/${info.replicationFactor} membres`);
        });

        node1.on('ring:unstable', (info) => {
            console.log(`⚠️  [${node1.alias}] Ring UNSTABLE - ${info.memberCount}/${info.replicationFactor} membres`);
        });

        await node1.start();
        nodes.push(node1);

        // Attendre la stabilité
        console.log('⏳ Attente de stabilité du premier node...');
        await node1.waitForStable(10000);
        console.log('');

        // Ajouter un deuxième node
        console.log('📍 Ajout du node 2 (déclenchera instabilité)...');
        const node2 = new RingNode({
            alias: 'node-2',
            replicationFactor: 1,
            requiredStableTimeMs: 3000
        });

        node2.on('ring:stable', (info) => {
            console.log(`✅ [${node2.alias}] Ring STABLE - ${info.memberCount}/${info.replicationFactor} membres`);
        });

        await node2.start();
        nodes.push(node2);

        // Attendre re-stabilisation
        console.log('⏳ Attente de re-stabilisation...');
        await Promise.all([
            node1.waitForStable(10000),
            node2.waitForStable(10000)
        ]);
        console.log('');

        // Afficher l'état final
        console.log('📊 État final:');
        nodes.forEach((node, i) => {
            const info = node.getStabilityInfo();
            console.log(`  Node ${i + 1}:`);
            console.log(`    Stable: ${info.isStable}`);
            console.log(`    Membres: ${info.memberCount}`);
            console.log(`    Temps stable: ${info.timeSinceLastChangeMs}ms`);
        });

        console.log('\n✅ Exemple terminé avec succès!\n');

    } finally {
        // Cleanup
        for (const node of nodes) {
            await node.stop();
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    process.exit(0);
}

main().catch((err) => {
    console.error('❌ Erreur:', err);
    process.exit(1);
});
