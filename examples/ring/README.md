# Ring Topology Example

Cet exemple démontre comment créer une topologie en anneau (ring) avec un nombre variable de nœuds (minimum 3). Chaque nœud maintient une vue cohérente du ring et se réorganise automatiquement quand des pairs rejoignent ou quittent.

## Caractéristiques

- **Ring dynamique** : Les nœuds rejoignent et quittent dynamiquement
- **Minimum 3 nœuds** : Le ring nécessite au moins 3 nœuds pour fonctionner
- **Organisation automatique** : Chaque nœud calcule son successeur et prédécesseur
- **Token passing** : Démonstration d'un jeton circulant dans le ring
- **Auto-guérison** : Le ring se réorganise automatiquement en cas de départ de nœuds

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

```bash
npm start
```

## Comportement

### Au démarrage

1. Le nœud démarre et s'enregistre auprès du PMD
2. Il découvre les autres nœuds du ring
3. Il calcule sa position dans le ring (successeur/prédécesseur)
4. Il notifie les autres nœuds de la mise à jour du ring

### Quand un nœud rejoint

1. Tous les nœuds détectent le nouvel arrivant (événement `peer:join`)
2. Chaque nœud recalcule le ring avec le nouveau membre
3. Les successeurs et prédécesseurs sont mis à jour
4. Le nouveau ring est affiché

### Quand un nœud quitte

1. Tous les nœuds détectent le départ (événement `peer:leave`)
2. Chaque nœud recalcule le ring sans le nœud parti
3. Le ring se referme automatiquement

### Token Passing

Le nœud `ring-1` initie un jeton après 10 secondes. Ce jeton circule dans le ring :

1. Chaque nœud reçoit le jeton
2. Le nœud attend 1 seconde
3. Il passe le jeton à son successeur
4. Quand le jeton fait le tour complet, un nouveau round commence

## Messages

Les nœuds échangent plusieurs types de messages :

- **RING_UPDATE** : Notification de mise à jour du ring
- **TOKEN** : Jeton circulant dans le ring
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

- **Distributed consensus** : Élection de leader
- **Load balancing** : Distribution circulaire des tâches
- **Token-based synchronization** : Mutex distribué
- **Fault tolerance** : Réorganisation automatique

## Notes

- Les nœuds doivent avoir un alias commençant par `ring-` pour être reconnus
- Le ring est trié par ordre alphabétique des alias
- Un minimum de 3 nœuds est requis pour former un ring valide
