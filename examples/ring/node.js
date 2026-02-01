const { NodeRuntime } = require('@distflow/core');

/**
 * Ring Node - maintains a ring topology with dynamic membership
 */
class RingNode {
  constructor(alias) {
    this.alias = alias;
    this.node = null;
    this.ring = []; // Sorted list of all nodes in the ring
    this.successor = null;
    this.predecessor = null;
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

    // Listen for peer join/leave events
    this.node.on('peer:join', async (peer) => {
      console.log(`[${this.alias}] Peer joined: ${peer.alias || peer.nodeId}`);
      await this.updateRing();
    });

    this.node.on('peer:leave', async (peer) => {
      console.log(`[${this.alias}] Peer left: ${peer.alias || peer.nodeId}`);
      await this.updateRing();
    });

    // Listen for messages
    this.node.onMessage((message, meta) => {
      this.handleMessage(message, meta);
    });

    // Initial ring update
    await this.updateRing();

    // Periodically display ring structure
    setInterval(() => {
      this.displayRingStatus();
    }, 5000);
  }

  /**
   * Update the ring structure based on current peers
   */
  async updateRing() {
    try {
      const peers = await this.node.discover();
      
      // Include self in the ring
      const allNodes = [
        { alias: this.alias, nodeId: this.node.getNodeId() },
        ...peers
      ];

      // Filter out nodes without alias (keep only ring nodes)
      const ringNodes = allNodes.filter(n => n.alias && n.alias.startsWith('ring-'));

      // Check minimum size
      if (ringNodes.length < 3) {
        console.log(`[${this.alias}] ⚠️  Ring has ${ringNodes.length} nodes (minimum 3 required)`);
        this.ring = [];
        this.successor = null;
        this.predecessor = null;
        return;
      }

      // Sort nodes by alias to create a consistent ring order
      this.ring = ringNodes.sort((a, b) => a.alias.localeCompare(b.alias));

      // Find my position in the ring
      const myIndex = this.ring.findIndex(n => n.alias === this.alias);

      if (myIndex === -1) {
        console.error(`[${this.alias}] Error: Can't find myself in the ring`);
        return;
      }

      // Calculate successor and predecessor (circular)
      const successorIndex = (myIndex + 1) % this.ring.length;
      const predecessorIndex = (myIndex - 1 + this.ring.length) % this.ring.length;

      this.successor = this.ring[successorIndex];
      this.predecessor = this.ring[predecessorIndex];

      console.log(`[${this.alias}] 🔄 Ring updated: ${this.ring.length} nodes`);
      console.log(`[${this.alias}]    Predecessor: ${this.predecessor.alias}`);
      console.log(`[${this.alias}]    Successor: ${this.successor.alias}`);

      // Notify ring members of the updated structure
      await this.broadcastRingUpdate();
    } catch (err) {
      console.error(`[${this.alias}] Failed to update ring:`, err.message);
    }
  }

  /**
   * Broadcast ring update to all members
   */
  async broadcastRingUpdate() {
    const ringInfo = {
      type: 'RING_UPDATE',
      ring: this.ring.map(n => n.alias),
      from: this.alias
    };

    for (const node of this.ring) {
      if (node.alias !== this.alias) {
        try {
          await this.node.send(node.alias, ringInfo);
        } catch (err) {
          // Ignore send errors during updates
        }
      }
    }
  }

  /**
   * Handle incoming messages
   */
  handleMessage(message, meta) {
    switch (message.type) {
      case 'RING_UPDATE':
        // Acknowledge ring update from another node
        console.log(`[${this.alias}] 📨 Ring update from ${message.from}`);
        break;

      case 'TOKEN':
        this.handleToken(message, meta);
        break;

      case 'PING':
        console.log(`[${this.alias}] 📨 PING from ${meta.from}`);
        this.node.send(meta.from, { type: 'PONG', original: message }).catch(() => {});
        break;

      default:
        console.log(`[${this.alias}] 📨 Message from ${meta.from}:`, message);
    }
  }

  /**
   * Handle token passing in the ring
   */
  handleToken(message, meta) {
    console.log(`[${this.alias}] 🎫 Token received from ${meta.from} (round ${message.round}, hop ${message.hop})`);

    if (message.hop >= this.ring.length) {
      console.log(`[${this.alias}] ✅ Token completed round ${message.round}`);
      
      // Start new round
      setTimeout(() => {
        if (this.successor) {
          console.log(`[${this.alias}] 🎫 Starting new token round ${message.round + 1}`);
          this.node.send(this.successor.alias, {
            type: 'TOKEN',
            round: message.round + 1,
            hop: 1,
            initiator: this.alias
          }).catch(() => {});
        }
      }, 2000);
    } else {
      // Pass token to successor
      setTimeout(() => {
        if (this.successor) {
          console.log(`[${this.alias}] 🎫 Passing token to ${this.successor.alias}`);
          this.node.send(this.successor.alias, {
            type: 'TOKEN',
            round: message.round,
            hop: message.hop + 1,
            initiator: message.initiator
          }).catch(() => {});
        }
      }, 1000);
    }
  }

  /**
   * Display current ring status
   */
  displayRingStatus() {
    if (this.ring.length < 3) {
      console.log(`[${this.alias}] 📊 Status: Waiting for minimum 3 nodes (current: ${this.ring.length})`);
      return;
    }

    const ringOrder = this.ring.map((n, i) => {
      if (n.alias === this.alias) {
        return `[${n.alias}]`; // Mark self with brackets
      }
      return n.alias;
    }).join(' → ');

    console.log(`[${this.alias}] 📊 Ring: ${ringOrder} → (cycle)`);
  }

  /**
   * Initiate a token in the ring (only if we're the first node)
   */
  async initiateToken() {
    if (this.ring.length >= 3 && this.successor) {
      console.log(`[${this.alias}] 🎫 Initiating token in the ring`);
      await this.node.send(this.successor.alias, {
        type: 'TOKEN',
        round: 1,
        hop: 1,
        initiator: this.alias
      });
    }
  }
}

// Main
async function main() {
  const alias = process.argv[2] || `ring-${Math.floor(Math.random() * 1000)}`;
  
  console.log('='.repeat(60));
  console.log('Ring Topology Example');
  console.log('='.repeat(60));
  console.log(`Node alias: ${alias}`);
  console.log('');

  const ringNode = new RingNode(alias);
  await ringNode.start();

  console.log(`[${alias}] ✅ Ring node started`);
  console.log(`[${alias}] Use Ctrl+C to stop`);
  console.log('');

  // If this is ring-1, initiate a token after some time
  if (alias === 'ring-1') {
    setTimeout(() => {
      ringNode.initiateToken();
    }, 10000);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(`\n[${alias}] Shutting down...`);
    await ringNode.node.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
