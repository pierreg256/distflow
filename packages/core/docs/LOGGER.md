# Logger Module

Module de logging structuré pour distflow avec support de niveaux, contextes et transports personnalisables.

## Installation

Le logger est inclus dans `@distflow/core` :

```typescript
import { getLogger, configureLogger, LogLevel } from '@distflow/core';
```

## Utilisation basique

```typescript
const logger = getLogger('my-service');

logger.debug('Debug message', { detail: 'value' });
logger.info('Information message');
logger.warn('Warning message', { code: 'WARN_001' });
logger.error('Error message', new Error('Something failed'));
```

## Configuration

### Configuration globale

```typescript
import { configureLogger, LogLevel } from '@distflow/core';

configureLogger({
  level: LogLevel.DEBUG,        // Niveau minimum à logger
  name: 'my-app',               // Nom de l'application
  prettyPrint: true,            // Format lisible (true) ou JSON (false)
  context: {                    // Contexte global
    environment: 'production',
    version: '1.0.0'
  }
});
```

### Niveaux de log

```typescript
enum LogLevel {
  DEBUG = 0,   // Détails de développement
  INFO = 1,    // Informations générales
  WARN = 2,    // Avertissements
  ERROR = 3,   // Erreurs
  SILENT = 4   // Désactiver tous les logs
}
```

### Variables d'environnement

Le logger respecte automatiquement :

```bash
# Définir le niveau de log
export LOG_LEVEL=DEBUG

# En production, pretty print est désactivé automatiquement
export NODE_ENV=production
```

## Child Loggers et Contexte

Créez des loggers enfants avec contexte supplémentaire :

```typescript
const logger = getLogger('api');

// Logger enfant pour une requête
const requestLogger = logger.child({
  requestId: 'req-123',
  userId: 'user-456',
  method: 'POST',
  path: '/api/users'
});

requestLogger.info('Request received');
requestLogger.info('Validating input');
requestLogger.info('Saving to database');
requestLogger.info('Request completed');

// Tous les logs incluront automatiquement le contexte
```

## Transports personnalisés

Créez vos propres transports pour envoyer les logs ailleurs :

```typescript
import { createTransport, configureLogger } from '@distflow/core';

// Transport vers fichier
const fileTransport = createTransport((entry) => {
  fs.appendFileSync('app.log', JSON.stringify(entry) + '\n');
});

// Transport vers service externe
const remoteTransport = createTransport(async (entry) => {
  await fetch('https://logs.example.com/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry)
  });
});

configureLogger({ transport: fileTransport });
```

## Format de sortie

### Pretty Print (développement)

```
2026-02-07T10:30:45.123Z INFO  [my-service] User logged in {"userId":"user-123","ip":"192.168.1.1"}
2026-02-07T10:30:46.456Z WARN  [my-service] High memory usage {"usage":"85%"}
2026-02-07T10:30:47.789Z ERROR [my-service] Database connection failed {"error":"ECONNREFUSED"}
```

### JSON (production)

```json
{"timestamp":"2026-02-07T10:30:45.123Z","level":"INFO","name":"my-service","message":"User logged in","userId":"user-123","ip":"192.168.1.1"}
{"timestamp":"2026-02-07T10:30:46.456Z","level":"WARN","name":"my-service","message":"High memory usage","usage":"85%"}
{"timestamp":"2026-02-07T10:30:47.789Z","level":"ERROR","name":"my-service","message":"Database connection failed","error":"ECONNREFUSED","stack":"..."}
```

## Gestion des erreurs

Le logger gère automatiquement les objets Error :

```typescript
try {
  await riskyOperation();
} catch (err) {
  logger.error('Operation failed', err as Error);
  // Logs: message, stack, name de l'erreur
}
```

## Bonnes pratiques

### 1. Nommer vos loggers

```typescript
// ✅ Bon - identifie le composant
const logger = getLogger('user-service');

// ❌ Éviter - logger anonyme
const logger = getLogger();
```

### 2. Utiliser le contexte

```typescript
// ✅ Bon - contexte structuré
logger.info('Payment processed', {
  orderId: 'ord-123',
  amount: 99.99,
  currency: 'USD'
});

// ❌ Éviter - tout dans le message
logger.info(`Payment processed: ord-123, $99.99 USD`);
```

### 3. Child loggers pour requêtes/opérations

```typescript
function handleRequest(req, res) {
  const logger = getLogger('api').child({
    requestId: req.id,
    method: req.method,
    path: req.path
  });
  
  logger.info('Request started');
  // ... processing ...
  logger.info('Request completed', { duration: 123 });
}
```

### 4. Niveaux appropriés

- **DEBUG** : Informations détaillées pour développement
- **INFO** : Événements normaux de l'application
- **WARN** : Situations anormales mais gérables
- **ERROR** : Erreurs nécessitant attention

### 5. Données sensibles

```typescript
// ❌ Éviter - expose des données sensibles
logger.info('User login', { 
  email: 'user@example.com',
  password: 'secret123'  // DANGER!
});

// ✅ Bon - sanitize les données
logger.info('User login', { 
  userId: 'user-123',
  email: 'u***@example.com'
});
```

## Intégration dans les modules distflow

### NodeRuntime

```typescript
const logger = getLogger('node-runtime').child({ 
  nodeId: this.nodeId,
  alias: this.alias 
});

logger.info('Node started', { port: this.port });
```

### RingNode

```typescript
const logger = getLogger('ring-node').child({ 
  alias: this.alias,
  hash: this.hash 
});

logger.debug('Synchronizing with peers', { peerCount: peers.length });
```

### JSONCrdt

```typescript
const logger = getLogger('json-crdt').child({ 
  replicaId: this.replica 
});

logger.warn('Conflict detected', { 
  path: op.path,
  localHlc: this.hlc,
  remoteHlc: op.hlc 
});
```

## API Reference

### `getLogger(name?: string): Logger`

Obtient ou crée le logger global.

### `configureLogger(options: LoggerOptions): Logger`

Configure le logger global.

### `logger.child(context: Record<string, any>): Logger`

Crée un logger enfant avec contexte additionnel.

### `logger.setLevel(level: LogLevel): void`

Change le niveau de log dynamiquement.

### `logger.addContext(context: Record<string, any>): void`

Ajoute du contexte persistant au logger.

### `createTransport(writeFn: (entry: LogEntry) => void): LogTransport`

Crée un transport personnalisé.

## Exemple complet

Voir `examples/logger-example.ts` pour des exemples d'utilisation complète.
