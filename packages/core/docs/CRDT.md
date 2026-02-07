# JSON-CRDT Enhanced Features

Le JSON-CRDT de distflow a été amélioré avec des fonctionnalités critiques et importantes pour un usage en production.

## 🎯 Vue d'ensemble des améliorations

### ✅ Niveau Critique (Complété)

- **Garbage Collection** : Limitation de la croissance du log et des structures internes
- **Tombstones** : Prévention de la résurrection de données supprimées
- **Cleanup automatique** : Nettoyage des buffers et maps
- **Gestion de la mémoire** : Limites configurables pour toutes les structures

### ✅ Niveau Important (Complété)

- **Persistence** : Snapshots et restauration d'état
- **Event System** : Écoute réactive des changements
- **Détection de conflits** : Gestion des conflits path hiérarchiques
- **Statistiques** : Métriques sur l'état interne du CRDT

## 📖 Guide d'utilisation

### 1. Configuration

```typescript
import { JSONCrdt, CrdtOptions } from '@distflow/core';

const options: CrdtOptions = {
  maxLogSize: 1000,              // Taille max du log avant GC (default: 1000)
  maxPendingSize: 10000,         // Taille max du buffer pending (default: 10000)
  maxLwwSize: 100000,            // Taille max de la LWW map (default: 100000)
  pendingTimeoutMs: 60000,       // Timeout pour ops en attente (default: 60000)
  tombstoneGracePeriodMs: 3600000, // Période de rétention des tombstones (default: 1h)
  enableAutoGc: true             // Active le GC automatique (default: true)
};

const crdt = new JSONCrdt('replica-id', {}, options);
```

### 2. Tombstones - Prévention de résurrection

Les tombstones empêchent les anciennes opérations SET de ressusciter des données supprimées :

```typescript
const crdt = new JSONCrdt('replica-1', {});

// Créer une valeur
crdt.set(['user', 'name'], 'Alice');
console.log(crdt.value()); // { user: { name: 'Alice' } }

// Supprimer (crée un tombstone)
crdt.del(['user', 'name']);
console.log(crdt.value()); // { user: {} }

// Une ancienne opération SET ne peut plus ressusciter la valeur
// Le tombstone la bloque
```

### 3. Garbage Collection

#### GC automatique

```typescript
const crdt = new JSONCrdt('replica-1', {}, {
  maxLogSize: 100,
  enableAutoGc: true
});

// Le GC se déclenche automatiquement quand :
// - Le log dépasse 2x maxLogSize
// - Le pending buffer dépasse 50% de maxPendingSize
// - Des tombstones sont expirés
```

#### GC manuel

```typescript
// GC du log
crdt.gcLog(50); // Garde les 50 dernières opérations

// GC des tombstones expirés
crdt.gcTombstones();

// GC du pending buffer
crdt.cleanPendingBuffer();
```

### 4. Persistence et Snapshots

```typescript
// Créer un snapshot
const snapshot = crdt.snapshot();

// Sauvegarder dans un fichier ou DB
fs.writeFileSync('state.json', JSON.stringify(snapshot));

// Restaurer depuis un snapshot
const savedSnapshot = JSON.parse(fs.readFileSync('state.json', 'utf8'));
crdt.restore(savedSnapshot);
```

Structure du snapshot :

```typescript
interface CrdtSnapshot {
  doc: JsonValue;                    // Document actuel
  vc: VectorClock;                   // Vector clock
  hlc: Hlc;                          // Hybrid logical clock
  lww: Array<[string, Hlc]>;         // LWW map
  tombstones: Array<[string, Hlc]>;  // Tombstones
  replicaId: ReplicaId;              // ID du replica
}
```

### 5. Event System

Le CRDT émet maintenant des événements pour une intégration réactive :

```typescript
import { EventEmitter } from 'events';

const crdt = new JSONCrdt('replica-1', {});

// Écouter les changements
crdt.on('change', (event) => {
  console.log(`Type: ${event.type}`);
  console.log(`Path: [${event.path.join('.')}]`);
  console.log(`Value:`, event.value);
});

// Écouter les conflits
crdt.on('conflict', (event) => {
  console.log(`Conflict: ${event.type}`);
  console.log(`Path: [${event.path.join('.')}]`);
});

// Écouter les GC
crdt.on('gc', (event) => {
  console.log(`GC: ${event.type}`);
  console.log(`Removed: ${event.removed} items`);
});

// Écouter les restaurations
crdt.on('restore', (event) => {
  console.log('Snapshot restored');
});
```

Types d'événements :

- **change** : Émis à chaque SET ou DEL

  ```typescript
  { type: 'set' | 'del', path: Path, value?: any, op: Op }
  ```

- **conflict** : Émis lors de détection de conflit

  ```typescript
  { 
    type: 'parent-tombstone' | 'tombstone-wins',
    path: Path,
    parentPath?: Path,
    opHlc?: Hlc,
    tombstoneHlc?: Hlc
  }
  ```

- **gc** : Émis après un garbage collection

  ```typescript
  { type: 'log' | 'pending' | 'tombstones', removed: number, currentSize: number }
  ```

### 6. Détection de conflits path

Le CRDT détecte et log les conflits hiérarchiques :

```typescript
crdt.on('conflict', (event) => {
  if (event.type === 'parent-tombstone') {
    console.warn('Tentative de SET sur un enfant dont le parent est supprimé');
    console.log('Path:', event.path);
    console.log('Parent:', event.parentPath);
  }
});

crdt.set(['a', 'b', 'c'], 'value');
crdt.del(['a']); // Supprime le parent

// Cette opération génère un warning
crdt.set(['a', 'b', 'c', 'd'], 'new value');
```

### 7. Statistiques

Obtenez des métriques sur l'état du CRDT :

```typescript
const stats = crdt.getStats();

console.log('Log size:', stats.logSize);
console.log('Pending ops:', stats.pendingSize);
console.log('LWW map size:', stats.lwwSize);
console.log('Tombstones:', stats.tombstonesSize);
console.log('Vector clock size:', stats.vcSize);
```

## 🔍 Cas d'usage avancés

### Intégration avec UI réactive

```typescript
// Créer un wrapper pour état réactif
class ReactiveCrdt {
  private crdt: JSONCrdt;
  private listeners: Map<string, Function[]> = new Map();

  constructor(replicaId: string) {
    this.crdt = new JSONCrdt(replicaId, {});
    
    this.crdt.on('change', (event) => {
      const pathKey = event.path.join('.');
      const handlers = this.listeners.get(pathKey) || [];
      handlers.forEach(fn => fn(event.value));
    });
  }

  watch(path: string[], callback: (value: any) => void) {
    const key = path.join('.');
    if (!this.listeners.has(key)) {
      this.listeners.set(key, []);
    }
    this.listeners.get(key)!.push(callback);
  }

  set(path: string[], value: any) {
    this.crdt.set(path, value);
  }
}

// Utilisation
const reactive = new ReactiveCrdt('app-1');

reactive.watch(['user', 'name'], (name) => {
  console.log('Name changed:', name);
  updateUI({ userName: name });
});

reactive.set(['user', 'name'], 'Alice'); // Déclenche le callback
```

### Persistence automatique

```typescript
class PersistentCrdt {
  private crdt: JSONCrdt;
  private saveInterval: NodeJS.Timeout;

  constructor(replicaId: string, savePath: string) {
    this.crdt = new JSONCrdt(replicaId, {});

    // Sauvegarder toutes les 30 secondes
    this.saveInterval = setInterval(() => {
      const snapshot = this.crdt.snapshot();
      fs.writeFileSync(savePath, JSON.stringify(snapshot));
      console.log('Snapshot saved');
    }, 30000);

    // Sauvegarder aussi sur chaque changement important
    this.crdt.on('change', () => {
      // Debounce ou throttle ici si nécessaire
    });
  }

  async load(savePath: string) {
    if (fs.existsSync(savePath)) {
      const snapshot = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      this.crdt.restore(snapshot);
      console.log('Snapshot loaded');
    }
  }

  destroy() {
    clearInterval(this.saveInterval);
  }
}
```

### Monitoring avec métriques

```typescript
const crdt = new JSONCrdt('replica-1', {}, {
  maxLogSize: 1000,
  enableAutoGc: true
});

// Exporter des métriques périodiquement
setInterval(() => {
  const stats = crdt.getStats();
  
  // Envoyer à Prometheus, StatsD, etc.
  metrics.gauge('crdt.log.size', stats.logSize);
  metrics.gauge('crdt.pending.size', stats.pendingSize);
  metrics.gauge('crdt.lww.size', stats.lwwSize);
  metrics.gauge('crdt.tombstones.size', stats.tombstonesSize);
  
  // Alertes
  if (stats.logSize > 5000) {
    console.warn('CRDT log size is high:', stats.logSize);
  }
}, 10000);

// Compter les conflits
let conflictCount = 0;
crdt.on('conflict', () => {
  conflictCount++;
  metrics.increment('crdt.conflicts');
});
```

## 🎨 Exemple complet

Voir [test/crdt-enhanced-test.js](../test/crdt-enhanced-test.js) pour une démonstration complète de toutes les fonctionnalités.

## 🚀 Prochaines étapes

Les fonctionnalités "Nice-to-have" restent à implémenter :

- RGA pour arrays
- Anti-entropy avec merkle trees
- Support des opérations MOVE
- Stratégies de résolution de conflits personnalisables
- Schema validation
- Optimistic UI support

## 📚 Références

- [Documentation du logger](./LOGGER.md)
- [Test suite](../test/crdt-enhanced-test.js)
- [README principal](../../README.md)
