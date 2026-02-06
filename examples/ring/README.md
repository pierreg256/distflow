# Ring Topology Example

Cet exemple démontre comment créer une topologie en anneau (ring) avec un nombre variable de nœuds (minimum 3). Chaque nœud maintient une vue cohérente du ring grâce à un CRDT et se réorganise automatiquement quand des pairs rejoignent ou quittent.

## Caractéristiques

- **Ring dynamique** : Les nœuds rejoignent et quittent dynamiquement
- **CRDT** : Utilise un JSON CRDT pour maintenir l'état distribué du ring
- **Hachage cohérent** : Les nœuds sont ordonnés par hash SHA-256 de leur nodeId
- **Minimum 3 nœuds** : Le ring nécessite au moins 3 nœuds pour fonctionner
- **Organisation automatique** : Chaque nœud calcule son successeur et prédécesseur
- **Token passing** : Démonstration d'un jeton circulant dans le ring
- **Auto-guérison** : Le ring se réorganise automatiquement en cas de départ de nœuds
- **Interface web** : Visualisation en temps réel du ring avec Mermaid

## Structure du Ring

Le ring est organisé de manière circulaire :

```
ring-1 → ring-2 → ring-3 → ring-4 → ring-1 (cycle)
         ↑                            ↓
         |                            |
         +------- predecessor --------+
                  successor ----------→
```

Chaque nœud connaît :

- **Predecessor** : Le nœud précédent dans le ring
- **Successor** : Le nœud suivant dans le ring
- **Ring complet** : La liste ordonnée de tous les nœuds

## Utilisation

### Démarrer le premier nœud

```bash
npm start ring-1
```

Le nœud démarrera avec un port web aléatoire. L'URL de l'interface web sera affichée au démarrage.

### Démarrer avec un port web spécifique

```bash
npm start ring-1 8001
npm start ring-2 8002
npm start ring-3 8003
```

### Démarrer d'autres nœuds (dans des terminaux séparés)

```bash
npm start ring-2
```

```bash
npm start ring-3
```

```bash
npm start ring-4
```

### Ou avec un nom aléatoire

initialise un CRDT pour maintenir l'état du ring
3. Il démarre un serveur web pour la visualisation
4. Il s'ajoute au ring via le CRDT
5. Il découvre les autres nœuds et synchronise l'état CRDT
6. Il calcule sa position dans le ring (successeur/prédécesseur)

### Le nouveau nœud s'ajoute au CRDT
2. Les autres nœuds synchronisent et reçoivent la mise à jour CRDT
3. Tous les nœuds détectent le nouvel arrivant (événement `peer:join`)
4. Chaque nœud recalcule le ring avec le nouveau membre (basé sur hash cohérent)
5. Les successeurs et prédécesseurs sont mis à jour
6. L'interface web se met à jour avec le nouveau ringangées pour converger vers un état cohérent

- Le vector clock garantit l'ordre causal des opérations
- Les conflits sont résolus avec Last-Write-Wins (LWW) basé sur HLC

```

## Interface Web

Chaque nœud expose une interface web qui affiche :

- **Informations du nœud** : Node ID, alias, successeur, prédécesseur
- **État CRDT** : Vector clock et état du token
- **Diagramme Mermaid** : Visualisation interactive du ring avec :
  - Position de chaque nœud
  - Hash cohérent de chaque nœud
  - Nœud actuel mis en évidence
  - Connexions du ring

Pour accéder à l'interface web d'un nœud, ouvrez l'URL affichée au démarrage dans votre navigateur.

Exemple :
```

[ring-1] 🌐 Web interface: <http://localhost:8001>

```

## Comportement

### Au démarrage

1. Le nœud démarre et s'enregistre auprès du PMD
2. Il découvre les autres nœuds du ring
3. Il calcule sa position dans le ring (successeur/prédécesseur)
4. Il notifie les autres nœuds de la mise à jour du ring
Le nœud est supprimé du CRDT
3. Chaque nœud recalcule le ring sans le nœud parti
4. Le ring se referme automatiquement
5. L'interface web se met à jour

1. Tous les nœuds détectent le nouvel arrivant (événement `peer:join`)
2. Chaque nœud recalcule le ring avec le nouveau membre
3. Les successeurs et prédécesseurs sont mis à jour
4. Le nouveau ring est affiché

### Quand un nœud quitte

1. Tous les nœuds détectent le départ (événement `peer:leave`)
2. Chaque nœud recalcule le ring sans le nœud parti
3. Le ring se referme automatiquement

### CRDT_SYNC_REQUEST** : Demande de synchronisation CRDT avec vector clock
- **CRDT_SYNC_RESPONSE** : Réponse avec les opérations CRDT manquantes
- **CRDT_OP** : Opération CRDT individuelle

Le nœud `ring-1` initie un jeton après 10 secondes. Ce jeton circule dans le ring :

1. Chaque nœud reçoit le jeton
2. Le nœud attend 1 seconde
3. Il pas🔄 Added self to ring
[ring-1] 🌐 Web interface: http://localhost:53214
[ring-1] ✅ Ring node started
[ring-1] Use Ctrl+C to stop

[ring-1] Peer joined: ring-2
[ring-1] 🔄 Applied 1 CRDT ops from ring-2
[ring-1] 📊 Status: Waiting for minimum 3 nodes (current: 2)
[ring-1] Peer joined: ring-3
[ring-1] 🔄 Applied 1 CRDT ops from ring-3
[ring-1] 📊 Ring: [ring-1@a3f2b8c1] → ring-2@e7d4a9f3 → ring-3@12bc45de → (cycle)
[ring-1] 🕐 Vector Clock: {abc12345:3, def67890:2, ghi11213:1}
- **PING/PONG** : Messages de test

## Exemple de sortie

```

[ring-1] Starting ring node...
[ring-1] ✅ Ring node started
[ring-1] Peer joined: ring-2
[ring-1] 🔄 Ring updated: 2 nodes
[ring-1] ⚠️  Ring has 2 nodes (minimum 3 required)
[ring-1] Peer joined: ring-3
[ring-1] 🔄 Ring updated: 3 nodes
[ring-1]    Predecessor: ring-3
[ring-1]    Successor: ring-2
[ring-1] 📊 Ring: [ring-1] → ring-2 → ring-3 → (cycle)
[ring-1] 🎫 Initiating token in the ring
[ring-1] 🎫 Token received from ring-3 (round 1, hop 3)
[ring-1] ✅ Token completed round 1

```

## Cas d'usage

Cet exemple démontre des patterns utiles pour :
**hachage cohérent** (SHA-256) des nodeId, pas par ordre alphabétique
- Un minimum de 3 nœuds est requis pour former un ring valide
- L'interface web se rafraîchit manuellement (bouton "Refresh")
- Le CRDT garantit la convergence éventuelle de tous les nœuds vers le même état
- **Load balancing** : Distribution circulaire des tâches
- **Token-based synchronization** : Mutex distribué
- **Fault tolerance** : Réorganisation automatique

## Notes

- Les nœuds doivent avoir un alias commençant par `ring-` pour être reconnus
- Le ring est trié par ordre alphabétique des alias
- Un minimum de 3 nœuds est requis pour former un ring valide
