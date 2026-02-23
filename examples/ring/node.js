const { RingNode, consistentHash } = require('@distflow/core');
const http = require('http');

/**
 * RingNodeAPI — JSON API wrapper around RingNode.
 *
 * Exposes ring topology and node state via HTTP/JSON + SSE.
 * No HTML is served; the front-end consumes these endpoints.
 *
 * Endpoints:
 *   GET /api/status  → full node + ring topology snapshot
 *   GET /events      → SSE stream of topology changes
 */
class RingNodeAPI {
  constructor(ringNode, webPort = 0) {
    this.ringNode = ringNode;
    this.httpServer = null;
    this.webPort = webPort;
    this.sseClients = [];

    // Forward ring events to SSE clients
    this.ringNode.on('ring-stable', () => this.notifyTopologyChange());
    this.ringNode.on('ring-unstable', () => this.notifyTopologyChange());
    this.ringNode.on('member-joined', () => this.notifyTopologyChange());
    this.ringNode.on('member-left', () => this.notifyTopologyChange());
    this.ringNode.on('state-change', () => this.notifyTopologyChange());
  }

  static async create(alias, webPort = 0) {
    const ringNode = await RingNode.start({ alias });
    const wrapper = new RingNodeAPI(ringNode, webPort);
    await wrapper.startAPIServer();
    return wrapper;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  getAlias() {
    return this.ringNode.getAlias() || this.ringNode.getNodeId().substring(0, 8);
  }

  getNodeId() {
    return this.ringNode.getNodeId();
  }

  /**
   * Build a full status snapshot (JSON-serialisable).
   */
  getStatus() {
    const nodeId = this.getNodeId();
    const alias = this.getAlias();
    const neighbors = this.ringNode.getNeighbors();
    const members = this.ringNode.members.map((m) => ({
      nodeId: m.nodeId,
      alias: m.alias || m.nodeId.substring(0, 8),
      token: m.token,
      tokenHex: m.token.toString(16).padStart(16, '0'),
      joinedAt: m.joinedAt,
      isSelf: m.nodeId === nodeId,
    }));

    return {
      nodeId,
      alias,
      ringState: this.ringNode.ringState,
      size: this.ringNode.size,
      onlinePeers: this.ringNode.awareness.getOnlinePeers().length,
      members,
      successor: neighbors.successor
        ? { nodeId: neighbors.successor.nodeId, alias: neighbors.successor.alias || neighbors.successor.nodeId.substring(0, 8) }
        : null,
      predecessor: neighbors.predecessor
        ? { nodeId: neighbors.predecessor.nodeId, alias: neighbors.predecessor.alias || neighbors.predecessor.nodeId.substring(0, 8) }
        : null,
      timestamp: Date.now(),
    };
  }

  // ── SSE notification ──────────────────────────────────────────────────

  notifyTopologyChange() {
    if (this.sseClients.length === 0) return;
    const payload = `data: ${JSON.stringify({ type: 'topology-update', timestamp: Date.now() })}\n\n`;
    this.sseClients.forEach((client) => {
      try { client.write(payload); } catch (_) { /* ignore */ }
    });
  }

  // ── HTTP / JSON API ───────────────────────────────────────────────────

  async startAPIServer() {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        // CORS headers for cross-origin front-end requests
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.url === '/api/status') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(this.getStatus()));
          return;
        }

        if (req.url === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
          });
          this.sseClients.push(res);
          res.write('data: {"type":"connected"}\n\n');
          req.on('close', () => {
            const idx = this.sseClients.indexOf(res);
            if (idx !== -1) this.sseClients.splice(idx, 1);
          });
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });

      this.httpServer.listen(this.webPort, () => {
        const port = this.httpServer.address().port;
        // Note: front.js detects "API server:" to mark the node as running
        console.log(`[${this.getAlias()}] API server: http://localhost:${port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (this.httpServer) {
      this.sseClients.forEach((c) => c.end());
      this.sseClients = [];
      this.httpServer.close();
    }
    await this.ringNode.shutdown();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const alias = process.argv[2] || `ring-${Math.floor(Math.random() * 1000)}`;
  const webPort = process.argv[3] ? parseInt(process.argv[3], 10) : 0;

  console.log('='.repeat(60));
  console.log('Ring Node — JSON API Mode');
  console.log('='.repeat(60));
  console.log(`Node alias: ${alias}`);
  console.log('');

  const ringNode = await RingNodeAPI.create(alias, webPort);

  console.log(`[${alias}] ✅ Ring node started`);
  console.log(`[${alias}] Use Ctrl+C to stop`);
  console.log('');

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
