# distflow

Framework TypeScript pour le développement distribué inspiré du modèle Erlang.

## Description

**distflow** est un framework léger pour la communication distribuée en TypeScript, proposant :

- **PMD (Port Mapper Daemon)** : registre de nœuds inspiré d'epmd d'Erlang
- **Communication fire-and-forget** : messaging asynchrone via TCP
- **Découverte automatique** : enregistrement et découverte de pairs
- **Mailbox par nœud** : système de boîte aux lettres avec stratégie configurable
- **Un nœud par processus** : architecture singleton garantie

## Caractéristiques

✅ Démarrage automatique du PMD  
✅ Enregistrement transparent des nœuds  
✅ Communication TCP avec JSON framing  
✅ Mailbox configurable (taille max + stratégie drop-newest)  
✅ Événements peer:join et peer:leave  
✅ Alias logiques pour les nœuds  
✅ CLI d'administration  

## Structure du projet

```bash
distflow/
├── packages/
│   ├── core/     # Librairie principale (@distflow/core)
│   ├── pmd/      # Port Mapper Daemon (@distflow/pmd)
│   └── cli/      # CLI d'administration (@distflow/cli)
├── examples/     # Exemples d'utilisation
└── agents/       # Règles et guides de développement
```

## Installation

```bash
# Clone le repository
git clone https://github.com/pierreg256/distflow.git
cd distflow

# Installer les dépendances
npm install

# Build tous les packages
npm run build
```

## Utilisation

### Exemple basique

```typescript
import { NodeRuntime } from "@distflow/core";

// Démarrer un nœud (PMD lancé automatiquement)
const node = await NodeRuntime.start({
  alias: "my-service",
  mailbox: {
    maxSize: 1000,
    overflow: "drop-newest"
  }
});

// Écouter les messages
node.onMessage((message, meta) => {
  console.log(`Message from ${meta.from}:`, message);
});

// Envoyer un message
await node.send("other-service", { type: "HELLO" });

// Découvrir les pairs
const peers = await node.discover();

// Écouter les événements de découverte
node.on("peer:join", (peer) => {
  console.log("New peer:", peer.alias);
});

node.on("peer:leave", (peer) => {
  console.log("Peer left:", peer.alias);
});
```

### CLI

```bash
# Vérifier le statut du PMD
distflow pmd status

# Lister les nœuds enregistrés
distflow pmd list

# Résoudre un alias
distflow pmd resolve my-service

# Arrêter le PMD
distflow pmd kill
```

## Exemples

Consultez le dossier `examples/` pour des exemples complets :

- **ping-pong** : communication simple entre deux nœuds
- **multi-node** : exemple avec plusieurs nœuds

## Architecture

### PMD (Port Mapper Daemon)

Le PMD est un daemon local qui :

- Enregistre les nœuds avec leurs ports
- Maintient un mapping alias → nodeId → host:port
- Gère le TTL et les heartbeats
- Notifie les watchers des événements peer:join/leave

### Node Runtime

Chaque processus peut démarrer **un seul nœud** qui :

- Lance automatiquement le PMD si absent
- S'enregistre automatiquement
- Maintient une connexion heartbeat
- Expose une mailbox pour recevoir des messages
- Communique via TCP avec les autres nœuds

### Communication

- **Transport** : TCP avec framing (4 bytes length + JSON)
- **Format** : JSON uniquement
- **Modèle** : fire-and-forget (pas d'appel synchrone)
- **Mailbox** : FIFO avec taille configurable et stratégie drop-newest

## Flux de Communication

### Démarrage d'un nœud

Le diagramme suivant illustre le processus de démarrage d'un nœud et son enregistrement auprès du PMD :

```mermaid
sequenceDiagram
    participant App as Application
    participant Node as NodeRuntime
    participant PMD as PMD Daemon
    
    App->>Node: NodeRuntime.start({alias})
    
    alt PMD non démarré
        Node->>PMD: Démarrage automatique
        PMD-->>PMD: Écoute sur port 4369
    end
    
    Node->>Node: Génère nodeId unique
    Node->>Node: Démarre serveur TCP
    Node->>PMD: REGISTER {alias, nodeId, port}
    PMD-->>PMD: Stocke mapping
    PMD-->>Node: OK {nodeId}
    
    Node->>PMD: Watch (abonnement événements)
    PMD-->>Node: Liste nœuds existants
    
    loop Heartbeat (toutes les 5s)
        Node->>PMD: HEARTBEAT {nodeId}
        PMD-->>Node: OK
    end
    
    Node-->>App: Instance NodeRuntime
```

### Communication entre nœuds

Le diagramme suivant montre comment deux nœuds communiquent via le PMD :

```mermaid
sequenceDiagram
    participant N1 as Node A
    participant PMD as PMD Daemon
    participant N2 as Node B
    
    Note over N1,N2: Les deux nœuds sont enregistrés
    
    N1->>PMD: RESOLVE "node-b"
    PMD-->>N1: {nodeId, host, port}
    
    N1->>N1: Cache la résolution
    N1->>N2: Connexion TCP (host:port)
    N1->>N2: Message JSON {"type": "HELLO"}
    
    N2->>N2: Mailbox enqueue
    N2->>N2: onMessage callback
    
    Note over N1,N2: Connexion réutilisée pour messages suivants
    
    N1->>N2: Message suivant
    N2->>N2: Mailbox enqueue
```

### Découverte de pairs et événements

Le diagramme suivant illustre le mécanisme de découverte et les événements `peer:join` / `peer:leave` :

```mermaid
sequenceDiagram
    participant N1 as Node A (watcher)
    participant PMD as PMD Daemon
    participant N2 as Node B (nouveau)
    
    Note over N1,PMD: Node A est déjà enregistré et watch
    
    N2->>PMD: REGISTER "node-b"
    PMD-->>PMD: Ajoute Node B
    PMD-->>N2: OK
    
    PMD->>N1: PEER_JOIN {alias: "node-b", nodeId, ...}
    N1->>N1: Émet événement 'peer:join'
    
    Note over N1,N2: Les nœuds peuvent maintenant communiquer
    
    alt Node B arrêt normal
        N2->>PMD: UNREGISTER
        PMD-->>PMD: Retire Node B
    else Timeout heartbeat
        PMD-->>PMD: Détecte absence heartbeat
        PMD-->>PMD: Retire Node B (TTL expiré)
    end
    
    PMD->>N1: PEER_LEAVE {alias: "node-b", nodeId}
    N1->>N1: Émet événement 'peer:leave'
```

### Architecture globale

```mermaid
graph TB
    subgraph "Process 1"
        App1[Application 1]
        Node1[NodeRuntime A]
        Mail1[Mailbox A]
        TCP1[TCP Server :PORT1]
    end
    
    subgraph "Process 2"
        App2[Application 2]
        Node2[NodeRuntime B]
        Mail2[Mailbox B]
        TCP2[TCP Server :PORT2]
    end
    
    subgraph "PMD Process"
        PMD[PMD Daemon :4369]
        Registry[(Registry<br/>alias → nodeId → port)]
        Watchers[Watchers Manager]
    end
    
    App1 --> Node1
    Node1 --> Mail1
    Node1 --> TCP1
    
    App2 --> Node2
    Node2 --> Mail2
    Node2 --> TCP2
    
    Node1 -.REGISTER/HEARTBEAT.-> PMD
    Node2 -.REGISTER/HEARTBEAT.-> PMD
    PMD --> Registry
    PMD --> Watchers
    
    Watchers -.PEER_JOIN/LEAVE.-> Node1
    Watchers -.PEER_JOIN/LEAVE.-> Node2
    
    TCP1 <-->|Messages JSON| TCP2
    
    style PMD fill:#e1f5ff
    style Registry fill:#ffe1e1
    style Watchers fill:#ffe1e1
```

## Développement

### Build

```bash
npm run build
```

### Clean

```bash
npm run clean
```

### Tests

```bash
npm test
```

## Règles de développement

Consultez les fichiers dans `agents/` pour les règles spécifiques :

- `agents/general/agents.md` : règles générales du projet
- `agents/lib/agents.md` : règles pour le développement de la lib
- `agents/examples/agents.md` : règles pour les exemples

## Packages

### @distflow/core

Librairie principale à intégrer dans vos applications.

### @distflow/pmd

Port Mapper Daemon - processus de registre local.

### @distflow/cli

Outils en ligne de commande pour administrer le PMD.

## License

MIT
