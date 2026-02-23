# Proposition: Socket Persistant au lieu de Heartbeat

## Changements dans PMD (pmd.ts)

### 1. Tracking des sockets par nodeId

```typescript
export class PMD extends EventEmitter {
  private server: net.Server;
  private registry: Map<string, NodeInfo> = new Map();
  private aliasMap: Map<string, string> = new Map();
  private watchers: Set<net.Socket> = new Set();
  
  // NOUVEAU: Associer chaque node à son socket de connection
  private nodeSockets: Map<string, net.Socket> = new Map();
  
  private options: Required<PMDOptions>;
  private autoShutdownTimer?: NodeJS.Timeout;
  
  // PLUS BESOIN de cleanupTimer pour les nodes
  // (quand socket ferme = node part)
```

### 2. Handler de connexion modifié

```typescript
private handleConnection(socket: net.Socket): void {
  let buffer = Buffer.alloc(0);
  let associatedNodeId: string | undefined;

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      
      if (buffer.length >= 4 + length) {
        const messageData = buffer.slice(4, 4 + length);
        buffer = buffer.slice(4 + length);

        try {
          const message: Message = JSON.parse(messageData.toString('utf-8'));
          this.handleMessage(socket, message, (nodeId) => {
            // Callback pour associer le socket au nodeId lors du REGISTER
            associatedNodeId = nodeId;
          });
        } catch (err) {
          console.error('Failed to parse message:', err);
        }
      } else {
        break;
      }
    }
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err);
  });

  // CRITIQUE: Détection de déconnexion
  socket.on('close', () => {
    this.watchers.delete(socket);
    
    // Si ce socket était associé à un node, le retirer immédiatement
    if (associatedNodeId) {
      console.log(`Node ${associatedNodeId} disconnected (socket closed)`);
      this.removeNode(associatedNodeId, 'socket_closed');
    }
  });
}
```

### 3. Enregistrement avec association socket

```typescript
private handleRegister(
  socket: net.Socket, 
  message: Message,
  onAssociate?: (nodeId: string) => void
): void {
  const payload = message.payload as RegisterPayload;
  
  const nodeInfo: NodeInfo = {
    nodeId: payload.nodeId,
    alias: payload.alias,
    host: payload.host,
    port: payload.port,
    registeredAt: Date.now()  // Plus besoin de lastHeartbeat
  };

  // Check for alias conflict
  if (payload.alias && this.aliasMap.has(payload.alias)) {
    const existingNodeId = this.aliasMap.get(payload.alias)!;
    if (existingNodeId !== payload.nodeId) {
      this.sendResponse(socket, message.requestId, { 
        error: `Alias '${payload.alias}' already in use` 
      });
      return;
    }
  }

  const isNew = !this.registry.has(payload.nodeId);
  this.registry.set(payload.nodeId, nodeInfo);
  
  // NOUVEAU: Associer le socket au nodeId
  this.nodeSockets.set(payload.nodeId, socket);
  
  if (payload.alias) {
    this.aliasMap.set(payload.alias, payload.nodeId);
  }

  // Notifier le handler de connexion
  if (onAssociate) {
    onAssociate(payload.nodeId);
  }

  this.cancelAutoShutdown();
  this.sendResponse(socket, message.requestId, { success: true });

  if (isNew) {
    this.notifyWatchers({
      event: 'peer:join',
      peer: nodeInfo
    });
  }
}
```

### 4. Méthode de suppression centralisée

```typescript
private removeNode(nodeId: string, reason: string): void {
  const nodeInfo = this.registry.get(nodeId);
  
  if (nodeInfo) {
    console.log(`Removing node ${nodeId} (reason: ${reason})`);
    
    this.registry.delete(nodeId);
    this.nodeSockets.delete(nodeId);
    
    if (nodeInfo.alias) {
      this.aliasMap.delete(nodeInfo.alias);
    }

    // Notify watchers
    this.notifyWatchers({
      event: 'peer:leave',
      peer: nodeInfo
    });
    
    // Check auto-shutdown
    this.checkAutoShutdown();
  }
}
```

### 5. Heartbeat supprimé (ou optionnel keepalive)

```typescript
// PLUS BESOIN de handleHeartbeat() ni de cleanup timer basé sur TTL
// La connexion socket fait office de "liveness check"

// OPTIONNEL: Si on veut quand même un keepalive TCP
private handleRegister(...) {
  // ...
  
  // Activer TCP keepalive sur le socket
  socket.setKeepAlive(true, 1000); // 1s keepalive
  
  // ...
}
```

## Changements dans NodeRuntime (node-runtime.ts)

### 1. Connexion persistante au PMD

```typescript
export class NodeRuntime extends EventEmitter {
  private static instance?: NodeRuntime;
  private static lockFile?: string;

  private nodeId: string;
  private alias?: string;
  private mailbox: Mailbox;
  private pmdClient: PMDClient;
  private transport: Transport;
  
  // SUPPRIMÉ: private heartbeatTimer?: NodeJS.Timeout;
  
  private pmdProcess?: child_process.ChildProcess;
  private isStarted = false;
  
  // NOUVEAU: Flag pour gérer la reconnexion
  private shouldMaintainPMDConnection = true;
```

### 2. Initialisation avec connexion persistante

```typescript
private async initialize(pmdPort: number): Promise<void> {
  // Ensure PMD is running
  await this.ensurePMDRunning(pmdPort);

  // Connect to PMD (connexion persistante)
  await this.connectToPMD();
  
  // Setup reconnection handler
  this.setupPMDReconnection();

  // Register with PMD
  const nodeInfo = await this.pmdClient.register(
    this.nodeId,
    this.alias,
    'localhost',
    this.transport.getPort()
  );

  logger.info('Node registered', {
    nodeId: this.nodeId.substring(0, 8),
    alias: this.alias,
    port: this.transport.getPort()
  });

  // Watch for peer events
  await this.pmdClient.watch();

  // Setup peer event handlers
  this.setupPeerHandlers();

  // SUPPRIMÉ: this.startHeartbeat();

  this.isStarted = true;
}
```

### 3. Gestion de la reconnexion automatique

```typescript
private setupPMDReconnection(): void {
  this.pmdClient.on('disconnect', async () => {
    if (!this.shouldMaintainPMDConnection) {
      return; // Shutdown intentionnel
    }
    
    logger.warn('PMD connection lost, attempting reconnect...');
    
    // Attendre un peu avant de reconnecter
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    try {
      await this.connectToPMD(10); // Plus de retries
      
      // Re-register après reconnexion
      await this.pmdClient.register(
        this.nodeId,
        this.alias,
        'localhost',
        this.transport.getPort()
      );
      
      await this.pmdClient.watch();
      
      logger.info('Reconnected to PMD');
    } catch (err) {
      logger.error('Failed to reconnect to PMD', err);
      
      // Retry après un délai plus long
      setTimeout(() => this.setupPMDReconnection(), 5000);
    }
  });
}
```

### 4. Shutdown propre

```typescript
async shutdown(): Promise<void> {
  if (!this.isStarted) {
    return;
  }

  logger.info('Shutting down node', { nodeId: this.nodeId.substring(0, 8) });

  // Indiquer qu'on ne veut plus reconnecter
  this.shouldMaintainPMDConnection = false;

  // Unregister from PMD
  try {
    await this.pmdClient.unregister(this.nodeId);
  } catch (err) {
    // Graceful: si PMD fermé ou node déjà retiré, c'est OK
    if (err instanceof Error) {
      const errMsg = err.message;
      if (errMsg.includes('Node not found') || errMsg.includes('Not connected')) {
        logger.warn('Unregister: ' + errMsg);
      } else {
        logger.error('Failed to unregister', err);
      }
    }
  }

  // SUPPRIMÉ: clearInterval(this.heartbeatTimer)
  
  // Fermer la connexion PMD (ce qui déclenche peer:leave côté PMD)
  await this.pmdClient.disconnect();
  
  // Stop transport
  await this.transport.close();

  this.isStarted = false;
  NodeRuntime.instance = undefined;
}
```

## Changements dans PMDClient (pmd-client.ts)

### 1. Émission d'événement disconnect

```typescript
export class PMDClient extends EventEmitter {
  private socket?: net.Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingRequests: Map<string, (response: any) => void> = new Map();
  private eventHandlers: Map<string, Array<(data: any) => void>> = new Map();
  private requestCounter = 0;
  private readonly host: string;
  private readonly port: number;
  
  // ...
  
  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });

    this.socket.on('error', (err) => {
      logger.error('PMD socket error', err);
      this.emit('error', err);
    });

    this.socket.on('close', () => {
      logger.info('PMD connection closed');
      this.socket = undefined;
      
      // NOUVEAU: Émettre événement disconnect
      this.emit('disconnect');
    });
  }
  
  /**
   * Disconnect from PMD
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
  }
}
```

## Migration

### Phase 1: Rétro-compatible

- Garder le heartbeat en option (défaut: désactivé)
- Activer socket persistant par défaut
- Option `useHeartbeat: boolean` dans NodeRuntimeOptions

### Phase 2: Cleanup

- Supprimer complètement le code de heartbeat après validation
- Simplifier le code PMD

## Tests à Ajouter

1. **Test de déconnexion brutale**

   ```javascript
   // Tuer un node et vérifier que peer:leave est émis immédiatement
   ```

2. **Test de reconnexion**

   ```javascript
   // Redémarrer le PMD et vérifier que les nodes se reconnectent
   ```

3. **Test de charge**

   ```javascript
   // 100+ nodes connectés simultanément
   ```

## Métriques

**Avant (Heartbeat)** :

- Overhead réseau: ~60 msg/min par node (1/s)
- Détection panne: 1-3 secondes
- Complexité: Heartbeat + Cleanup timer + TTL tracking

**Après (Socket Persistant)** :

- Overhead réseau: 0 (juste la connexion TCP)
- Détection panne: < 100ms (immédiate)
- Complexité: Juste le handler socket.on('close')

## Conclusion

Cette approche est **plus simple, plus rapide, et plus fiable**. Elle exploite la sémantique native de TCP au lieu de réinventer un mécanisme de liveness check.
