# Architecture Asynchrone Request/Response

## Problème Initial

Dans l'implémentation initiale, certaines méthodes (comme `get()` et `stabilize()`) attendaient incorrectement une réponse directe de `node.send()`:

```typescript
// ❌ INCORRECT - send() est "fire and forget", ne retourne pas de réponse
const response = await this.node.send(successor.alias, {
  type: 'DHT_GET',
  key
});
```

Cette approche violait la philosophie **"fire and forget"** du système de messagerie, où `send()` ne retourne jamais le résultat de l'action du node distant.

## Solution: Pattern Asynchrone Request/Response

### Architecture

L'architecture implémentée respecte le pattern "fire and forget" tout en permettant des opérations asynchrones avec réponses via:

1. **Génération d'identifiants uniques de requête** (`requestId`)
2. **Map des Promises en attente** (`pendingRequests`)
3. **Handlers de réponse** qui résolvent les Promises correspondantes
4. **Timeouts** pour éviter les blocages infinis

### Structure de Données

```typescript
protected pendingRequests: Map<string, {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}> = new Map();

protected requestIdCounter = 0;
```

### Mécanisme de Fonctionnement

#### 1. Création d'une Requête (Exemple: `get()`)

```typescript
public async get(key: string): Promise<any> {
  // ... validation ...
  
  return new Promise((resolve, reject) => {
    const requestId = this.generateRequestId();
    
    // Configuration du timeout (5s)
    const timeout = setTimeout(() => {
      this.pendingRequests.delete(requestId);
      reject(new Error(`DHT GET timeout for key ${key}`));
    }, 5000);
    
    // Enregistrement de la Promise
    this.pendingRequests.set(requestId, { resolve, reject, timeout });
    
    // Envoi du message (fire and forget)
    this.node!.send(responsible.alias, {
      type: 'DHT_GET',
      key,
      requestId,  // ← Identifiant pour corréler la réponse
      from: this.alias
    }).catch((err) => {
      // En cas d'erreur d'envoi, cleanup
      this.pendingRequests.delete(requestId);
      clearTimeout(timeout);
      reject(err);
    });
  });
}
```

#### 2. Traitement de la Requête (Node Distant)

```typescript
protected handleDhtGet(message: any, meta: MessageMetadata): void {
  const { key, requestId } = message;
  const value = this.storage.get(key);
  
  // Envoi de la réponse avec le même requestId (fire and forget)
  if (this.node) {
    this.node.send(meta.from, {
      type: 'DHT_GET_RESPONSE',
      requestId,  // ← Même identifiant pour corrélation
      key,
      value,
      found: value !== undefined
    }).catch(() => { });
  }
}
```

#### 3. Réception de la Réponse (Node Original)

```typescript
protected handleDhtGetResponse(message: any, _meta: MessageMetadata): void {
  const { requestId, value } = message;
  
  // Récupération de la Promise en attente
  const pending = this.pendingRequests.get(requestId);
  if (pending) {
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(requestId);
    pending.resolve(value);  // ← Résolution de la Promise
  }
}
```

### Diagramme de Séquence

```
Node A (appelant)              Node B (responsable)
     │                              │
     │ 1. get("key")               │
     ├──────────────────────────►  │
     │ { type: 'DHT_GET',          │
     │   requestId: 'A-1-...',     │
     │   key: 'key' }              │
     │                              │
     │ [Promise créée et           │
     │  stockée dans map]          │
     │                              │
     │                         2. handleDhtGet()
     │                              │
     │                         [Récupère storage]
     │                              │
     │  ◄──────────────────────────┤
     │ 3. { type: 'DHT_GET_RESPONSE',
     │      requestId: 'A-1-...',  │
     │      value: ... }            │
     │                              │
     │ 4. handleDhtGetResponse()   │
     │ [Résout la Promise]         │
     │                              │
     ▼                              ▼
```

## Avantages

### ✅ Respecte "Fire and Forget"

- `send()` ne retourne jamais de valeur métier
- Chaque `send()` est une opération unidirectionnelle
- Pas de couplage synchrone entre émetteur et récepteur

### ✅ Support des Opérations Asynchrones

- Pattern Promise/async-await naturel pour le code appelant
- Corrélation request/response via `requestId` unique
- Timeout automatique pour éviter les blocages

### ✅ Gestion d'Erreurs Robuste

- Timeout configurable (5 secondes par défaut)
- Cleanup automatique en cas d'erreur
- Nettoyage lors du shutdown du node

### ✅ Scalabilité

- Multiples requêtes en parallèle possibles
- Pas de blocage du thread
- Identifiants uniques garantissent pas de collision

## Opérations Implémentées

### DHT GET

- **Requête**: `DHT_GET` avec `key` et `requestId`
- **Réponse**: `DHT_GET_RESPONSE` avec `requestId`, `value`, `found`
- **Timeout**: 5 secondes
- **Usage**: `const value = await ringNode.get('my-key')`

### Stabilization (Chord Protocol)

- **Requête**: `STABILIZE_REQUEST` avec `requestId`, `nodeId`
- **Réponse**: `STABILIZE_RESPONSE` avec `requestId`, `predecessor`
- **Timeout**: 5 secondes
- **Usage**: Appelé automatiquement par l'interval de stabilisation

## Lifecycle des Requêtes

### Création

```typescript
protected generateRequestId(): string {
  return `${this.alias}-${this.requestIdCounter++}-${Date.now()}`;
}
```

Format: `{alias}-{counter}-{timestamp}`

- Garantit l'unicité globale
- Permet le debugging (alias identifiable)
- Monotone croissant pour traçabilité

### Timeout

```typescript
const timeout = setTimeout(() => {
  this.pendingRequests.delete(requestId);
  reject(new Error('timeout'));
}, 5000);
```

- 5 secondes par défaut
- Cleanup automatique de la Map
- Rejection explicite de la Promise

### Cleanup (Shutdown)

```typescript
async stop(): Promise<void> {
  // ... autres cleanups ...
  
  for (const pending of this.pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Node stopped'));
  }
  this.pendingRequests.clear();
}
```

Toutes les requêtes en attente sont rejetées proprement lors de l'arrêt du node.

## Bonnes Pratiques

### ✅ DO

- Toujours générer un `requestId` unique
- Inclure le `requestId` dans la requête ET la réponse
- Configurer un timeout raisonnable (5-10s)
- Cleanup timeout lors de la résolution/rejection
- Gérer le cas où `pending` est `undefined` (réponse tardive)

### ❌ DON'T

- Ne jamais attendre une valeur de retour de `send()`
- Ne pas oublier le timeout (risque de fuite mémoire)
- Ne pas réutiliser les `requestId`
- Ne pas stocker indéfiniment dans `pendingRequests`

## Extensibilité

Pour ajouter une nouvelle opération request/response:

1. **Créer la méthode publique**:

   ```typescript
   public async myOperation(param: string): Promise<Result> {
     return new Promise((resolve, reject) => {
       const requestId = this.generateRequestId();
       const timeout = setTimeout(() => {
         this.pendingRequests.delete(requestId);
         reject(new Error('timeout'));
       }, 5000);
       
       this.pendingRequests.set(requestId, { resolve, reject, timeout });
       
       this.node!.send(targetAlias, {
         type: 'MY_OPERATION_REQUEST',
         requestId,
         param
       }).catch((err) => {
         this.pendingRequests.delete(requestId);
         clearTimeout(timeout);
         reject(err);
       });
     });
   }
   ```

2. **Ajouter le handler de requête**:

   ```typescript
   protected handleMyOperationRequest(message: any, meta: MessageMetadata): void {
     const { requestId, param } = message;
     const result = this.processOperation(param);
     
     if (this.node) {
       this.node.send(meta.from, {
         type: 'MY_OPERATION_RESPONSE',
         requestId,
         result
       }).catch(() => { });
     }
   }
   ```

3. **Ajouter le handler de réponse**:

   ```typescript
   protected handleMyOperationResponse(message: any, _meta: MessageMetadata): void {
     const { requestId, result } = message;
     
     const pending = this.pendingRequests.get(requestId);
     if (pending) {
       clearTimeout(pending.timeout);
       this.pendingRequests.delete(requestId);
       pending.resolve(result);
     }
   }
   ```

4. **Router dans `handleMessage()`**:

   ```typescript
   case 'MY_OPERATION_REQUEST':
     this.handleMyOperationRequest(message, meta);
     break;
   
   case 'MY_OPERATION_RESPONSE':
     this.handleMyOperationResponse(message, meta);
     break;
   ```

## Conclusion

Cette architecture permet de **concilier**:

- La philosophie **"fire and forget"** du système de messagerie
- Le besoin de **réponses asynchrones** pour certaines opérations
- Une **API ergonomique** (async/await) pour les développeurs
- Une **gestion robuste** des timeouts et erreurs

Le pattern est générique et peut être étendu à toutes les opérations nécessitant une réponse dans un système distribué basé sur la messagerie asynchrone.
