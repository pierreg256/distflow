# Détection de Stabilité du Ring

## Aperçu

Le RingNode fournit un système complet de détection de stabilité permettant de savoir à quel moment votre ring distribué est stable et prêt à servir des requêtes.

## Qu'est-ce qu'un Ring "Stable" ?

Un ring est considéré **stable** lorsque **toutes** les conditions suivantes sont remplies :

1. **Nombre de nœuds suffisant** : Le ring contient au moins `replicationFactor` nœuds (défaut: 3)
2. **Pas de changements de topologie récents** : Aucun membre n'a rejoint ou quitté le ring pendant `requiredStableTimeMs`
3. **Nombre de membres constant** : Le compte de membres n'a pas varié
4. **Temps de stabilité atteint** : Le délai configuré sans changement est écoulé (défaut: 5 secondes)

> ⚠️ **Important** : Un ring avec moins de `replicationFactor` nœuds ne sera **jamais** considéré stable, même après un long délai sans changement.

> 💡 **Note** : La stabilité est basée sur les changements de **membres**, pas sur les synchronisations CRDT. Les syncs CRDT internes ne déclenchent pas de transition vers l'état "instable".

## Configuration

```typescript
const ring = new RingNode({
  alias: 'my-ring-node',
  replicationFactor: 3,             // Nombre minimum de nœuds requis pour stabilité (défaut: 3)
  requiredStableTimeMs: 5000,       // Temps sans changement pour être stable (défaut: 5s)
  stabilityCheckIntervalMs: 1000    // Fréquence de vérification (défaut: 1s)
});
```

### Options de Stabilité

| Option | Type | Défaut | Description |
|--------|------|--------|-------------|
| `replicationFactor` | number | 3 | Nombre minimum de nœuds requis dans le ring pour être considéré stable |
| `requiredStableTimeMs` | number | 5000 | Délai minimum (ms) sans changement pour considérer le ring stable |
| `stabilityCheckIntervalMs` | number | 1000 | Fréquence (ms) de vérification de la stabilité |

> 💡 **Astuce** : Pour un environnement de développement ou test avec un seul nœud, configurez `replicationFactor: 1`

## Méthodes Publiques

### `isStable(): boolean`

Vérifie si le ring est actuellement stable.

```typescript
const ring = new RingNode({ alias: 'node-1' });
await ring.start();

// Plus tard...
if (ring.isStable()) {
  console.log('Ring est prêt !');
}
```

**Retourne** : `true` si le ring est stable, `false` sinon

### `getStabilityInfo(): RingStabilityInfo`

Obtient des informations détaillées sur l'état de stabilité.

```typescript
const info = ring.getStabilityInfo();

console.log('Stable?', info.isStable);
console.log('Membres:', info.memberCount);
console.log('Facteur de réplication:', info.replicationFactor);
console.log('Temps depuis dernier changement:', info.timeSinceLastChangeMs, 'ms');
console.log('Temps requis:', info.requiredStableTimeMs, 'ms');
```

**Retourne** : Un objet `RingStabilityInfo` :

```typescript
interface RingStabilityInfo {
  isStable: boolean;                // Si le ring est stable
  memberCount: number;              // Nombre de membres dans le ring
  replicationFactor: number;        // Nombre minimum de nœuds requis pour stabilité
  lastTopologyChangeMs: number;     // Timestamp du dernier changement
  timeSinceLastChangeMs: number;    // Temps écoulé depuis le dernier changement
  requiredStableTimeMs: number;     // Temps requis pour être considéré stable
}
```

### `getMemberCount(): number`

Retourne le nombre actuel de membres dans le ring.

```typescript
const count = ring.getMemberCount();
console.log(`Le ring a ${count} membres`);
```

### `waitForStable(timeoutMs?: number): Promise<RingStabilityInfo>`

Attend que le ring devienne stable (méthode asynchrone).

```typescript
try {
  // Attendre max 30 secondes (défaut)
  const info = await ring.waitForStable();
  console.log('Ring stable avec', info.memberCount, 'membres');
} catch (err) {
  console.error('Le ring n\'est pas devenu stable:', err.message);
}

// Avec timeout personnalisé (10 secondes)
try {
  await ring.waitForStable(10000);
  console.log('Ring stable en moins de 10 secondes');
} catch (err) {
  console.error('Timeout après 10 secondes');
}
```

**Paramètres** :

- `timeoutMs` (optionnel) : Timeout en millisecondes (défaut: 30000)

**Retourne** : Une Promise qui se résout avec `RingStabilityInfo` quand le ring devient stable

**Rejette** : Si le timeout est atteint avant que le ring ne devienne stable

## Événements

Le RingNode émet des événements lors des transitions de stabilité.

### Événement `ring:stable`

Émis quand le ring **devient stable** (transition d'instable à stable).

```typescript
ring.on('ring:stable', (info: RingStabilityInfo) => {
  console.log('✅ Ring devenu stable !');
  console.log('  Membres:', info.memberCount);
  console.log('  Temps depuis changement:', info.timeSinceLastChangeMs, 'ms');
});
```

### Événement `ring:unstable`

Émis quand le ring **devient instable** (un membre rejoint ou quitte).

```typescript
ring.on('ring:unstable', (info: RingStabilityInfo) => {
  console.log('⚠️  Ring devenu instable');
  console.log('  Membres:', info.memberCount);
});
```

### Méthodes d'Événements

```typescript
// S'abonner à un événement
ring.on('ring:stable', handler);

// S'abonner une seule fois
ring.once('ring:stable', handler);

// Se désabonner
ring.off('ring:stable', handler);
```

## Patterns d'Utilisation

### Pattern 1: Attendre Stabilité au Démarrage

```typescript
async function startService() {
  const ring = new RingNode({ 
    alias: 'service-1',
    requiredStableTimeMs: 3000  // 3 secondes pour démarrage rapide
  });
  
  await ring.start();
  
  console.log('Attente de stabilité du ring...');
  await ring.waitForStable(15000);
  
  console.log('Ring stable, démarrage des services applicatifs...');
  // Démarrer ici vos services qui dépendent du ring
}
```

### Pattern 2: Réagir aux Changements de Stabilité

```typescript
const ring = new RingNode({ alias: 'adaptive-service' });

ring.on('ring:stable', () => {
  console.log('Ring stable - activation du mode normal');
  // Augmenter la charge de travail
  // Activer la réplication
});

ring.on('ring:unstable', () => {
  console.log('Ring instable - passage en mode dégradé');
  // Réduire la charge
  // Mettre en pause les opérations non-critiques
});

await ring.start();
```

### Pattern 3: Polling avec Retry

```typescript
async function waitForMinimumNodes(ring: RingNode, minNodes: number, maxWaitMs: number) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitMs) {
    const count = ring.getMemberCount();
    
    if (count >= minNodes && ring.isStable()) {
      console.log(`Ring stable avec ${count} membres`);
      return true;
    }
    
    console.log(`En attente... ${count}/${minNodes} membres, stable: ${ring.isStable()}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`Timeout: seulement ${ring.getMemberCount()} membres après ${maxWaitMs}ms`);
}

// Usage
const ring = new RingNode({ alias: 'distributed-db' });
await ring.start();
await waitForMinimumNodes(ring, 3, 30000);
console.log('Cluster ready!');
```

### Pattern 4: Health Check pour Load Balancer

```typescript
import express from 'express';

const app = express();
const ring = new RingNode({ alias: 'web-service' });

// Health check endpoint
app.get('/health', (req, res) => {
  const info = ring.getStabilityInfo();
  
  if (info.isStable && info.memberCount >= 2) {
    res.status(200).json({
      status: 'healthy',
      members: info.memberCount,
      stableFor: info.timeSinceLastChangeMs
    });
  } else {
    res.status(503).json({
      status: 'unstable',
      members: info.memberCount,
      stableFor: info.timeSinceLastChangeMs,
      required: info.requiredStableTimeMs
    });
  }
});

// Readiness check (pour Kubernetes)
app.get('/ready', (req, res) => {
  if (ring.isStable()) {
    res.status(200).send('OK');
  } else {
    res.status(503).send('Not Ready');
  }
});

await ring.start();
app.listen(3000);
```

### Pattern 5: Synchronisation Multi-Node

```typescript
async function startCluster(nodeCount: number) {
  const nodes: RingNode[] = [];
  
  // Démarrer tous les nodes
  for (let i = 0; i < nodeCount; i++) {
    const node = new RingNode({ 
      alias: `node-${i + 1}`,
      requiredStableTimeMs: 5000
    });
    await node.start();
    nodes.push(node);
    
    // Petit délai entre les démarrages
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  // Attendre que TOUS les nodes soient stables
  console.log('Attente de stabilité de tous les nodes...');
  await Promise.all(
    nodes.map(node => node.waitForStable(30000))
  );
  
  console.log('✅ Cluster completement stable');
  return nodes;
}

// Usage
const cluster = await startCluster(5);
console.log('Tous les 5 nodes sont stables et prêts');
```

### Pattern 6: Graceful Degradation

```typescript
class SmartService {
  private ring: RingNode;
  private operationMode: 'full' | 'degraded' | 'minimal' = 'minimal';
  
  constructor() {
    this.ring = new RingNode({ alias: 'smart-service' });
    this.setupStabilityHandlers();
  }
  
  private setupStabilityHandlers() {
    this.ring.on('ring:stable', (info) => {
      if (info.memberCount >= 5) {
        this.operationMode = 'full';
        console.log('Mode: FULL (tous les services actifs)');
      } else if (info.memberCount >= 3) {
        this.operationMode = 'degraded';
        console.log('Mode: DEGRADED (services essentiels seulement)');
      } else {
        this.operationMode = 'minimal';
        console.log('Mode: MINIMAL (mode survie)');
      }
    });
    
    this.ring.on('ring:unstable', () => {
      console.log('Mode: MINIMAL (instabilité détectée)');
      this.operationMode = 'minimal';
    });
  }
  
  async processRequest(request: any) {
    if (this.operationMode === 'minimal') {
      throw new Error('Service in minimal mode, try again later');
    }
    
    const useCache = this.operationMode === 'degraded';
    // ... traiter la requête selon le mode
  }
}
```

## Mécanisme Interne

### Détection des Changements

Le système suit les changements de topologie via :

1. **Compteur de membres** : Chaque fois qu'un membre rejoint/quitte, le compteur change
2. **Timestamp** : `lastTopologyChange` est mis à jour uniquement si le nombre de membres change
3. **Vérification périodique** : Toutes les `stabilityCheckIntervalMs`, le système vérifie si `timeSinceLastChange >= requiredStableTimeMs`

### Transitions d'État

```
                  Member joins/leaves
   STABLE  ─────────────────────────────►  UNSTABLE
     ▲                                         │
     │          timeSince >= required          │
     └─────────────────────────────────────────┘
```

### Événements Émis

- **Stable → Unstable** : Événement `ring:unstable` immédiatement lors du changement de membre
- **Unstable → Stable** : Événement `ring:stable` après `requiredStableTimeMs` sans changement

## Bonnes Pratiques

### ✅ À Faire

- **Configurer un `requiredStableTimeMs` adapté** à votre cas d'usage (plus court pour dev, plus long pour prod)
- **Utiliser `waitForStable()` au démarrage** avant d'accepter du trafic
- **Monitorer les événements** pour adapter le comportement de votre application
- **Implémenter des health checks** basés sur la stabilité
- **Considérer un nombre minimum de nodes** avant d'activer certaines fonctionnalités

### ❌ À Éviter

- **Ne pas bloquer indéfiniment** sur `waitForStable()` sans timeout
- **Ne pas supposer qu'un ring reste stable** - toujours écouter les événements
- **Ne pas confondre** stabilité et nombre de membres (un ring peut être stable avec 1 seul membre)
- **Ne pas mettre un `requiredStableTimeMs` trop court** (< 1 seconde) - risque de faux positifs
- **Ne pas oublier de cleanup** les event listeners quand vous n'en avez plus besoin

## Debugging

### Activer les Logs de Stabilité

Les logs de stabilité sont déjà inclus au niveau INFO :

```typescript
import { configureLogger, LogLevel } from '@distflow/core';

configureLogger({
  level: LogLevel.DEBUG,  // Pour voir tous les détails
  prettyPrint: true
});
```

Vous verrez alors :

```
INFO Ring became stable {"memberCount":3,"timeSinceChange":5001}
DEBUG Ring became unstable {"memberCount":2}
```

### Monitoring en Production

```typescript
// Exposer métriques Prometheus
app.get('/metrics', (req, res) => {
  const info = ring.getStabilityInfo();
  
  res.type('text/plain').send(`
# HELP ring_stable Whether the ring is currently stable
# TYPE ring_stable gauge
ring_stable ${info.isStable ? 1 : 0}

# HELP ring_members Number of members in the ring
# TYPE ring_members gauge
ring_members ${info.memberCount}

# HELP ring_time_since_change_ms Time since last topology change
# TYPE ring_time_since_change_ms gauge
ring_time_since_change_ms ${info.timeSinceLastChangeMs}
  `.trim());
});
```

## Exemples Complets

Voir le fichier de test complet : [test/ring-stability-test.js](../../test/ring-stability-test.js)

## FAQ

**Q: Pourquoi le ring prend 5 secondes à devenir stable ?**  
A: Par défaut, `requiredStableTimeMs` est à 5000ms. Vous pouvez le réduire en configuration.

**Q: Pourquoi mon ring ne devient jamais stable même après un long délai ?**  
A: Le ring nécessite au moins `replicationFactor` nœuds (défaut: 3) pour être stable. Vérifiez que vous avez assez de nœuds, ou réduisez `replicationFactor` pour le développement.

**Q: Un ring avec 1 seul membre peut-il être stable ?**  
A: Seulement si vous configurez `replicationFactor: 1`. Par défaut (replicationFactor=3), il faut au moins 3 nœuds.

**Q: Quel est le bon replicationFactor pour mon cas d'usage ?**  
A: Pour production: 3 (permet tolérance de panne de 1 nœud). Pour développement/test: 1. Pour haute disponibilité: 5+.

**Q: Les synchronisations CRDT rendent-elles le ring instable ?**  
A: Non. Seuls les changements de membres (join/leave) affectent la stabilité.

**Q: Que se passe-t-il si un node crash ?**  
A: Les autres nodes détectent le départ (via peer:leave) et le ring devient instable jusqu'à ce que la topologie se stabilise.

**Q: Comment avoir une stabilité plus rapide en développement ?**  
A: Configurez `requiredStableTimeMs: 1000` ou moins (mais pas en production).

**Q: Les événements sont-ils émis pour tous les nodes ?**  
A: Chaque node émet ses propres événements localement basés sur sa vue du ring.
