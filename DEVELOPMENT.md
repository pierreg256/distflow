# Guide de Développement - distflow

Ce guide vous aidera à démarrer avec le développement et l'utilisation du framework distflow.

## Prérequis

- Node.js 18+ 
- npm 8+
- TypeScript 5+

## Installation pour le développement

```bash
# Cloner le repository
git clone https://github.com/pierreg256/distflow.git
cd distflow

# Installer les dépendances
npm install

# Builder tous les packages
npm run build
```

## Structure du projet

```
distflow/
├── packages/
│   ├── pmd/          # Port Mapper Daemon
│   │   ├── src/
│   │   │   ├── pmd.ts       # Implémentation du daemon
│   │   │   ├── types.ts     # Types et interfaces
│   │   │   ├── cli.ts       # CLI pour lancer le PMD
│   │   │   └── index.ts     # Exports publics
│   │   └── dist/            # Code compilé
│   │
│   ├── core/         # Librairie principale
│   │   ├── src/
│   │   │   ├── node-runtime.ts   # Runtime principal
│   │   │   ├── mailbox.ts        # Système de mailbox
│   │   │   ├── transport.ts      # Couche TCP
│   │   │   ├── pmd-client.ts     # Client PMD
│   │   │   └── index.ts          # Exports publics
│   │   └── dist/                 # Code compilé
│   │
│   └── cli/          # CLI d'administration
│       ├── src/
│       │   └── cli.ts            # Commandes CLI
│       └── dist/                 # Code compilé
│
├── examples/         # Exemples d'utilisation
│   └── ping-pong/    # Exemple ping-pong
│
├── test/             # Tests d'intégration
│   └── integration-test.js
│
└── agents/           # Règles de développement
    ├── general/agents.md    # Règles générales
    ├── lib/agents.md        # Règles pour la lib
    └── examples/agents.md   # Règles pour les exemples
```

## Workflow de développement

### 1. Build

```bash
# Builder tous les packages
npm run build

# Builder un package spécifique
cd packages/core
npm run build
```

### 2. Tests

```bash
# Lancer tous les tests
npm test

# Lancer uniquement le test d'intégration
npm run test:integration
```

### 3. Clean

```bash
# Nettoyer tous les builds
npm run clean
```

## Utilisation du framework

### Démarrage d'un nœud

```typescript
import { NodeRuntime } from "@distflow/core";

const node = await NodeRuntime.start({
  alias: "my-service",          // Alias logique (optionnel)
  pmdPort: 4369,                // Port du PMD (défaut: 4369)
  mailbox: {
    maxSize: 1000,              // Taille max de la mailbox (défaut: 1000)
    overflow: "drop-newest"     // Stratégie de débordement
  }
});
```

### Écouter des messages

```typescript
node.onMessage((message, meta) => {
  console.log("Message reçu:", message);
  console.log("De:", meta.from);
  console.log("À:", meta.to);
  console.log("Timestamp:", meta.timestamp);
});
```

### Envoyer un message (fire-and-forget)

```typescript
// Envoyer à un alias
await node.send("other-service", {
  type: "HELLO",
  data: "world"
});

// Le message est envoyé de manière asynchrone
// Aucune garantie de livraison
```

### Découverte de pairs

```typescript
// Obtenir la liste des pairs actifs
const peers = await node.discover();

peers.forEach(peer => {
  console.log(`Pair: ${peer.alias || peer.nodeId}`);
  console.log(`  Adresse: ${peer.host}:${peer.port}`);
});
```

### Événements

```typescript
// Écouter l'arrivée de nouveaux pairs
node.on("peer:join", (peer) => {
  console.log(`Nouveau pair: ${peer.alias}`);
});

// Écouter le départ de pairs
node.on("peer:leave", (peer) => {
  console.log(`Pair parti: ${peer.alias}`);
});
```

### Arrêt propre

```typescript
// Arrêter le nœud proprement
await node.shutdown();
```

## CLI

### Commandes PMD

```bash
# Vérifier le statut du PMD
distflow pmd status

# Lister les nœuds enregistrés
distflow pmd list

# Résoudre un alias
distflow pmd resolve my-service

# Arrêter le PMD (non implémenté)
distflow pmd kill
```

### Options

```bash
# Spécifier un port personnalisé
distflow pmd status --port 4370
distflow pmd list --port 4370
```

## Architecture technique

### PMD (Port Mapper Daemon)

Le PMD est un daemon TCP local qui :

1. **Écoute** sur un port fixe (défaut: 4369)
2. **Enregistre** les nœuds avec leur `nodeId`, `alias`, `host:port`
3. **Maintient** un registre en mémoire
4. **Gère** les heartbeats (TTL de 60s par défaut)
5. **Notifie** les watchers des événements peer:join/leave
6. **Nettoie** automatiquement les nœuds inactifs

### NodeRuntime

Chaque processus peut créer **un seul nœud** qui :

1. **Vérifie** si le PMD tourne, sinon le lance
2. **Génère** un `nodeId` unique et opaque
3. **Démarre** un serveur TCP sur un port dynamique
4. **S'enregistre** automatiquement auprès du PMD
5. **Envoie** des heartbeats réguliers (30s)
6. **Maintient** une mailbox FIFO pour les messages entrants
7. **Communique** avec les autres nœuds via TCP

### Communication

#### Protocole de framing

Tous les messages TCP utilisent le même framing :

```
[4 bytes: length (big-endian)] [N bytes: JSON payload]
```

#### Format des messages PMD

```typescript
{
  "type": "register" | "unregister" | "resolve" | "list" | ...,
  "payload": { ... },
  "requestId": "req_123"  // Pour les requêtes
}
```

#### Format des messages entre nœuds

```typescript
{
  "from": "nodeId123",
  "to": "nodeId456", 
  "payload": { ... },      // Données utilisateur
  "timestamp": 1234567890
}
```

### Mailbox

- **Type** : Queue FIFO
- **Taille** : Configurable (défaut: 1000)
- **Overflow** : drop-newest (ignore les nouveaux messages si pleine)
- **Thread-safety** : Non garanti (usage mono-thread supposé)

### Singleton pattern

Un verrou de process garantit un seul nœud par process :

1. Création d'un fichier lock à `/tmp/distflow-node-{pid}.lock`
2. Nettoyage automatique à la sortie du process
3. `NodeRuntime.start()` retourne l'instance existante si déjà créée

## Conventions de code

Voir les fichiers dans `agents/` pour les règles détaillées :

- **TypeScript strict** obligatoire
- **Préférer** les fonctions pures
- **Documenter** toutes les APIs publiques
- **Nommer** clairement types et fonctions
- **Pas de `any`** sauf justification
- **Pas de code mort** ou TODOs injustifiés

## Dépannage

### Le PMD ne démarre pas

```bash
# Vérifier qu'aucun PMD ne tourne déjà
lsof -i :4369

# Vérifier les logs
# Le PMD affiche "PMD listening on port X" au démarrage
```

### Le nœud ne peut pas se connecter au PMD

```bash
# Vérifier que le PMD tourne
distflow pmd status

# Vérifier le port
# Par défaut 4369, configurable via pmdPort
```

### Les messages ne sont pas reçus

1. Vérifier que le destinataire a un handler `onMessage()`
2. Vérifier que la mailbox n'est pas pleine
3. Vérifier que l'alias existe (`distflow pmd list`)
4. Vérifier les logs du transport

## Limitations connues

- **Un seul nœud par process** (par design)
- **Pas de RPC** - uniquement fire-and-forget
- **Pas de persistance** - registre PMD en mémoire uniquement
- **Pas de sécurité** - pas de chiffrement ni authentification
- **Local uniquement** - conçu pour développement local/LAN

## Prochaines étapes

Pour contribuer au projet :

1. Fork le repository
2. Créer une branche feature
3. Suivre les règles dans `agents/`
4. Ajouter des tests si nécessaire
5. Ouvrir une PR

## Support

Pour toute question ou problème :

- Ouvrir une issue sur GitHub
- Consulter les exemples dans `examples/`
- Lire les règles dans `agents/`
