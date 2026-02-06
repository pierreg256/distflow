const { NodeRuntime, JSONCrdt } = require('@distflow/core');
const crypto = require('crypto');

/**
 * Compute consistent hash for a node identifier
 * Uses SHA-256 and returns first 8 bytes as a number
 */
function consistentHash(nodeId) {
  const hash = crypto.createHash('sha256').update(nodeId).digest();
  // Use first 8 bytes as a 64-bit number (well, 53-bit safe integer in JS)
  return hash.readUInt32BE(0) * 0x100000000 + hash.readUInt32BE(4);
}

/**
 * Ring Node - maintains a ring topology with dynamic membership using CRDT
 * Nodes are ordered by consistent hash of their nodeId
 */
class RingNode {
  constructor(alias) {
    this.alias = alias;
    this.node = null;
    this.crdt = null; // CRDT for distributed ring state
    this.syncInterval = null;
  }

  async start() {
    console.log(`[${this.alias}] Starting ring node...`);

    // Start the node runtime
    this.node = await NodeRuntime.start({
      alias: this.alias,
      mailbox: {
        maxSize: 100,
        overflow: 'drop-newest'
      }
    });

    // Initialize CRDT with this node's ID
    this.crdt = new JSONCrdt(this.node.getNodeId(), {
      members: {},
      token: null
    });

    // Add self to the ring
    this.addSelfToRing();

    // Listen for peer join/leave events
    this.node.on('peer:join', async (peer) => {
      console.log(`[${this.alias}] Peer joined: ${peer.alias || peer.nodeId}`);
      // No immediate action - will be added via CRDT sync
    });

    this.node.on('peer:leave', async (peer) => {
      console.log(`[${this.alias}] Peer left: ${peer.alias || peer.nodeId}`);
      // Remove from CRDT
      this.removeMemberFromRing(peer.nodeId);
    });

    // Listen for messages
    this.node.onMessage((message, meta) => {
      this.handleMessage(message, meta);
    });

    // Start periodic CRDT sync
    this.startCrdtSync();

    // Periodically display ring structure
    setInterval(() => {
      this.displayRingStatus();
    }, 5000);
  }

  /**
   * Add self to the CRDT ring state
   */
  addSelfToRing() {
    const state = this.crdt.value();
    const members = state.members || {};

    this.crdt.set(['members', this.node.getNodeId()], {
      alias: this.alias,
      nodeId: this.node.getNodeId(),
      joinedAt: Date.now()
    });

    console.log(`[${this.alias}] 🔄 Added self to ring`);
  }

  /**
   * Remove a member from the CRDT ring state
   */
  removeMemberFromRing(nodeId) {
    const state = this.crdt.value();
    const members = state.members || {};

    if (members[nodeId]) {
      this.crdt.del(['members', nodeId]);
      console.log(`[${this.alias}] 🔄 Removed ${nodeId} from ring`);
    }
  }

  /**
   * Start periodic CRDT sync with peers
   */
  startCrdtSync() {
    this.syncInterval = setInterval(async () => {
      await this.syncCrdtWithPeers();
    }, 2000);
  }

  /**
   * Sync CRDT state with all peers
   */
  async syncCrdtWithPeers() {
    try {
      const peers = await this.node.discover();
      const ringPeers = peers.filter(p => p.alias && p.alias.startsWith('ring-'));

      if (ringPeers.length === 0) return;

      // Send our vector clock and ops to all peers
      const clock = this.crdt.clock();

      for (const peer of ringPeers) {
        try {
          await this.node.send(peer.alias, {
            type: 'CRDT_SYNC_REQUEST',
            clock: clock,
            from: this.alias,
            nodeId: this.node.getNodeId()
          });
        } catch (err) {
          // Ignore send errors
        }
      }
    } catch (err) {
      // Ignore discovery errors
    }
  }

  /**
   * Get current ring members sorted by consistent hash
   */
  getRingMembers() {
    const state = this.crdt.value();
    const members = state.members || {};

    return Object.values(members)
      .filter(m => m.alias && m.alias.startsWith('ring-'))
      .map(m => ({
        ...m,
        hash: consistentHash(m.nodeId)
      }))
      .sort((a, b) => {
        // Sort by hash value (ascending)
        if (a.hash !== b.hash) return a.hash - b.hash;
        // Tie-break on nodeId for stability
        return a.nodeId.localeCompare(b.nodeId);
      });
  }

  /**
   * Get successor and predecessor in the ring
   */
  getRingNeighbors() {
    const members = this.getRingMembers();

    if (members.length < 3) {
      return { successor: null, predecessor: null, ring: members };
    }

    const myIndex = members.findIndex(m => m.nodeId === this.node.getNodeId());

    if (myIndex === -1) {
      return { successor: null, predecessor: null, ring: members };
    }

    const successorIndex = (myIndex + 1) % members.length;
    const predecessorIndex = (myIndex - 1 + members.length) % members.length;

    return {
      successor: members[successorIndex],
      predecessor: members[predecessorIndex],
      ring: members
    };
  }

  /**
   * Handle incoming messages
   */
  handleMessage(message, meta) {
    switch (message.type) {
      case 'CRDT_SYNC_REQUEST':
        this.handleCrdtSyncRequest(message, meta);
        break;

      case 'CRDT_SYNC_RESPONSE':
        this.handleCrdtSyncResponse(message, meta);
        break;

      case 'CRDT_OP':
        this.handleCrdtOp(message, meta);
        break;

      case 'TOKEN':
        this.handleToken(message, meta);
        break;

      case 'PING':
        console.log(`[${this.alias}] 📨 PING from ${meta.from}`);
        this.node.send(meta.from, { type: 'PONG', original: message }).catch(() => { });
        break;

      default:
        console.log(`[${this.alias}] 📨 Message from ${meta.from}:`, message);
    }
  }

  /**
   * Handle CRDT sync request
   */
  handleCrdtSyncRequest(message, meta) {
    const remoteClock = message.clock;
    const myOps = this.crdt.diffSince(remoteClock);

    // Send back our ops that are newer
    this.node.send(meta.from, {
      type: 'CRDT_SYNC_RESPONSE',
      ops: myOps.map(op => JSONCrdt.encodeOp(op)),
      clock: this.crdt.clock()
    }).catch(() => { });

    // Also ensure the remote node is in our members if they're a ring node
    if (message.nodeId && message.from && message.from.startsWith('ring-')) {
      const state = this.crdt.value();
      const members = state.members || {};

      if (!members[message.nodeId]) {
        this.crdt.set(['members', message.nodeId], {
          alias: message.from,
          nodeId: message.nodeId,
          joinedAt: Date.now()
        });
      }
    }
  }

  /**
   * Handle CRDT sync response
   */
  handleCrdtSyncResponse(message, meta) {
    // Apply received ops to our CRDT
    const ops = message.ops.map(opStr => JSONCrdt.decodeOp(opStr));

    let applied = 0;
    for (const op of ops) {
      if (this.crdt.receive(op)) {
        applied++;
      }
    }

    if (applied > 0) {
      console.log(`[${this.alias}] 🔄 Applied ${applied} CRDT ops from ${meta.from}`);
    }
  }

  /**
   * Handle individual CRDT op
   */
  handleCrdtOp(message, meta) {
    const op = JSONCrdt.decodeOp(message.op);
    const applied = this.crdt.receive(op);

    if (applied) {
      console.log(`[${this.alias}] 🔄 Applied CRDT op from ${meta.from}`);
    }
  }

  /**
   * Handle token passing in the ring
   */
  handleToken(message, meta) {
    console.log(`[${this.alias}] 🎫 Token received from ${meta.from} (round ${message.round}, hop ${message.hop})`);

    const { ring } = this.getRingNeighbors();

    if (message.hop >= ring.length) {
      console.log(`[${this.alias}] ✅ Token completed round ${message.round}`);

      // Update token state in CRDT
      this.crdt.set(['token'], {
        round: message.round,
        completedAt: Date.now(),
        completedBy: this.alias
      });

      // Start new round
      setTimeout(() => {
        const { successor } = this.getRingNeighbors();
        if (successor) {
          console.log(`[${this.alias}] 🎫 Starting new token round ${message.round + 1}`);
          this.node.send(successor.alias, {
            type: 'TOKEN',
            round: message.round + 1,
            hop: 1,
            initiator: this.alias
          }).catch(() => { });
        }
      }, 2000);
    } else {
      // Pass token to successor
      setTimeout(() => {
        const { successor } = this.getRingNeighbors();
        if (successor) {
          console.log(`[${this.alias}] 🎫 Passing token to ${successor.alias}`);
          this.node.send(successor.alias, {
            type: 'TOKEN',
            round: message.round,
            hop: message.hop + 1,
            initiator: message.initiator
          }).catch(() => { });
        }
      }, 1000);
    }
  }

  /**
   * Display current ring status
   */
  displayRingStatus() {
    const { ring, successor, predecessor } = this.getRingNeighbors();

    if (ring.length < 3) {
      console.log(`[${this.alias}] 📊 Status: Waiting for minimum 3 nodes (current: ${ring.length})`);
      return;
    }

    const ringOrder = ring.map((n) => {
      const hashStr = n.hash.toString(16).substring(0, 8);
      if (n.nodeId === this.node.getNodeId()) {
        return `[${n.alias}@${hashStr}]`; // Mark self with brackets
      }
      return `${n.alias}@${hashStr}`;
    }).join(' → ');

    console.log(`[${this.alias}] 📊 Ring: ${ringOrder} → (cycle)`);

    // Display CRDT info
    const state = this.crdt.value();
    const clock = this.crdt.clock();
    const clockStr = Object.entries(clock)
      .map(([id, v]) => `${id.slice(0, 8)}:${v}`)
      .join(', ');

    if (clockStr) {
      console.log(`[${this.alias}] 🕐 Vector Clock: {${clockStr}}`);
    }

    if (state.token) {
      console.log(`[${this.alias}] 🎫 Last token: round ${state.token.round} by ${state.token.completedBy}`);
    }
  }

  /**
   * Initiate a token in the ring (only if we're the first node)
   */
  async initiateToken() {
    const { ring, successor } = this.getRingNeighbors();

    if (ring.length >= 3 && successor) {
      console.log(`[${this.alias}] 🎫 Initiating token in the ring`);
      await this.node.send(successor.alias, {
        type: 'TOKEN',
        round: 1,
        hop: 1,
        initiator: this.alias
      });
    }
  }

  async stop() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    if (this.node) {
      await this.node.stop();
    }
  }
}

// Main
async function main() {
  const alias = process.argv[2] || `ring-${Math.floor(Math.random() * 1000)}`;

  console.log('='.repeat(60));
  console.log('Ring Topology Example (with CRDT state)');
  console.log('='.repeat(60));
  console.log(`Node alias: ${alias}`);
  console.log('');

  const ringNode = new RingNode(alias);
  await ringNode.start();

  console.log(`[${alias}] ✅ Ring node started`);
  console.log(`[${alias}] Use Ctrl+C to stop`);
  console.log('');


  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(`\n[${alias}] Shutting down...`);
    await ringNode.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
