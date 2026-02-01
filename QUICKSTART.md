# Quick Start Guide - distflow

Guide de démarrage rapide pour utiliser le framework distflow.

## Installation

```bash
git clone https://github.com/pierreg256/distflow.git
cd distflow
npm install
npm run build
```

## Premier exemple en 5 minutes

### 1. Créer un fichier `node1.js`

```javascript
const { NodeRuntime } = require('@distflow/core');

async function main() {
  const node = await NodeRuntime.start({
    alias: 'service-a',
    pmdPort: 4369
  });

  console.log(`Node démarré: ${node.getAlias()}`);

  // Écouter les messages
  node.onMessage((message, meta) => {
    console.log('Message reçu:', message);
  });

  // Écouter les événements
  node.on('peer:join', (peer) => {
    console.log('Nouveau pair:', peer.alias);
  });
}

main();
```

### 2. Créer un fichier `node2.js`

```javascript
const { NodeRuntime } = require('@distflow/core');

async function main() {
  const node = await NodeRuntime.start({
    alias: 'service-b',
    pmdPort: 4369
  });

  console.log(`Node démarré: ${node.getAlias()}`);

  // Attendre que service-a soit prêt
  await new Promise(r => setTimeout(r, 2000));

  // Envoyer un message
  await node.send('service-a', {
    type: 'HELLO',
    message: 'Bonjour depuis service-b'
  });

  console.log('Message envoyé à service-a');
}

main();
```

### 3. Lancer les deux nœuds

```bash
# Terminal 1
node node1.js

# Terminal 2
node node2.js
```

### 4. Observer les résultats

Terminal 1 affichera :
```
Node démarré: service-a
Nouveau pair: service-b
Message reçu: { type: 'HELLO', message: 'Bonjour depuis service-b' }
```

Terminal 2 affichera :
```
Node démarré: service-b
Message envoyé à service-a
```

## Utiliser la CLI

```bash
# Voir le statut du PMD
npx distflow pmd status

# Lister les nœuds actifs
npx distflow pmd list

# Résoudre un alias
npx distflow pmd resolve service-a
```

## Configuration avancée

### Mailbox personnalisée

```javascript
const node = await NodeRuntime.start({
  alias: 'my-service',
  mailbox: {
    maxSize: 5000,           // Plus grande capacité
    overflow: 'drop-newest'   // Stratégie
  }
});
```

### Port PMD personnalisé

```javascript
const node = await NodeRuntime.start({
  alias: 'my-service',
  pmdPort: 9999,  // Port personnalisé
  pmdHost: 'localhost'
});
```

### Découverte de pairs

```javascript
// Obtenir tous les pairs actifs
const peers = await node.discover();

console.log('Pairs actifs:');
peers.forEach(peer => {
  console.log(`- ${peer.alias || peer.nodeId} @ ${peer.host}:${peer.port}`);
});
```

### Gestion des événements

```javascript
// Nouveau pair
node.on('peer:join', (peer) => {
  console.log(`${peer.alias} a rejoint le réseau`);
});

// Pair déconnecté
node.on('peer:leave', (peer) => {
  console.log(`${peer.alias} a quitté le réseau`);
});

// Message reçu
node.onMessage((message, meta) => {
  console.log(`Message de ${meta.from}:`, message);
  console.log(`Reçu à ${new Date(meta.timestamp)}`);
});
```

## Exemples inclus

### Ping-Pong

```bash
cd examples/ping-pong

# Terminal 1
npm run start:pong

# Terminal 2  
npm run start:ping
```

## Points importants

✅ **Un seul nœud par process** - C'est une limitation par design  
✅ **Fire-and-forget** - Pas de réponse synchrone  
✅ **PMD automatique** - Lancé automatiquement si absent  
✅ **Mailbox FIFO** - Messages traités dans l'ordre  
✅ **Drop-newest** - Les nouveaux messages sont ignorés si la mailbox est pleine  

## Dépannage rapide

### "Node already running in this process"
- Vous essayez de créer deux nœuds dans le même process
- Solution: Un seul `NodeRuntime.start()` par process

### "Failed to resolve target: xxx"
- L'alias n'existe pas ou le nœud n'est pas enregistré
- Vérifier avec `distflow pmd list`

### "PMD not found at ..."
- Les packages ne sont pas buildés
- Solution: `npm run build`

### Messages non reçus
- Vérifier que `onMessage()` est bien défini
- Vérifier que l'alias est correct
- Vérifier que la mailbox n'est pas pleine

## Documentation complète

Pour plus de détails, consultez :
- [README.md](./README.md) - Vue d'ensemble et architecture
- [DEVELOPMENT.md](./DEVELOPMENT.md) - Guide de développement complet
- [examples/](./examples/) - Exemples de code

## Support

Questions ou problèmes ?
- Consultez les exemples
- Ouvrez une issue sur GitHub
- Lisez DEVELOPMENT.md pour les détails techniques
