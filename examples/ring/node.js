const { NodeRuntime, JSONCrdt } = require('@distflow/core');
const crypto = require('crypto');
const http = require('http');

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
  constructor(alias, webPort = 0) {
    this.alias = alias;
    this.node = null;
    this.crdt = null; // CRDT for distributed ring state
    this.syncInterval = null;
    this.httpServer = null;
    this.webPort = webPort; // Port for web server (0 = random)
    this.sseClients = []; // SSE clients for real-time updates
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

    // Start web server
    await this.startWebServer();

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
    this.notifyTopologyChange();
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
      this.notifyTopologyChange();
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
        this.notifyTopologyChange();
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
      this.notifyTopologyChange();
    }
  }

  /**
   * Handle individual CRDT op
   */
  handleCrdtOp(message, meta) {
    const op = JSONCrdt.decodeOp(message.op);
    const applied = this.crdt.receive(op);

    if (applied) {
      this.notifyTopologyChange();
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
    if (this.httpServer) {
      // Close all SSE connections
      this.sseClients.forEach(client => client.end());
      this.sseClients = [];
      this.httpServer.close();
    }
    if (this.node) {
      await this.node.stop();
    }
  }

  /**
   * Notify all SSE clients of topology change
   */
  notifyTopologyChange() {
    if (this.sseClients.length === 0) return;

    const event = JSON.stringify({
      type: 'topology-update',
      timestamp: Date.now()
    });

    this.sseClients.forEach(client => {
      try {
        client.write(`data: ${event}\n\n`);
      } catch (err) {
        // Ignore write errors
      }
    });
  }

  /**
   * Start web server to display ring visualization
   */
  async startWebServer() {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.url === '/') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this.generateHTML());
        } else if (req.url === '/events') {
          // SSE endpoint
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
          });

          // Add client to list
          this.sseClients.push(res);
          console.log(`[${this.alias}] 📡 SSE client connected (${this.sseClients.length} total)`);

          // Send initial ping
          res.write('data: {"type":"connected"}\n\n');

          // Remove client on disconnect
          req.on('close', () => {
            const index = this.sseClients.indexOf(res);
            if (index !== -1) {
              this.sseClients.splice(index, 1);
              console.log(`[${this.alias}] 📡 SSE client disconnected (${this.sseClients.length} remaining)`);
            }
          });
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.httpServer.listen(this.webPort, () => {
        const addr = this.httpServer.address();
        const actualPort = addr.port;
        console.log(`[${this.alias}] 🌐 Web interface: http://localhost:${actualPort}`);
        resolve();
      });
    });
  }

  /**
   * Generate HTML page with Mermaid diagram
   */
  generateHTML() {
    const { ring, successor, predecessor } = this.getRingNeighbors();
    const state = this.crdt.value();
    const clock = this.crdt.clock();

    // Generate Mermaid diagram
    let mermaidDiagram = 'graph LR\n';

    if (ring.length === 0) {
      mermaidDiagram += '    A["No nodes in ring"]\n';
    } else if (ring.length < 3) {
      mermaidDiagram += `    A["Waiting for minimum 3 nodes<br/>Current: ${ring.length}"]\n`;
    } else {
      // Create nodes
      ring.forEach((node, idx) => {
        const hashStr = node.hash.toString(16).substring(0, 8);
        const label = node.nodeId === this.node.getNodeId()
          ? `"${node.alias}<br/>@${hashStr}<br/>(ME)"`
          : `"${node.alias}<br/>@${hashStr}"`;
        const style = node.nodeId === this.node.getNodeId() ? ':::current' : '';
        mermaidDiagram += `    N${idx}[${label}]${style}\n`;
      });

      // Create ring edges
      ring.forEach((node, idx) => {
        const nextIdx = (idx + 1) % ring.length;
        mermaidDiagram += `    N${idx} --> N${nextIdx}\n`;
      });

      // Close the ring visually
      mermaidDiagram += `    N${ring.length - 1} -.->|cycle| N0\n`;

      // Add styling for current node (Fluent UI Teams purple)
      mermaidDiagram += '    classDef current fill:#6264A7,stroke:#8b8cc7,stroke-width:3px,color:#fff\n';
    }

    // Vector clock info
    const clockEntries = Object.entries(clock)
      .map(([id, v]) => `${id.slice(0, 8)}:${v}`)
      .join(', ');

    // Token info
    const tokenInfo = state.token
      ? `Round ${state.token.round} completed by ${state.token.completedBy}`
      : 'No token yet';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Ring Node: ${this.alias}</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Roboto', 'Helvetica Neue', sans-serif;
      background: #1f1f1f;
      color: #ffffff;
      min-height: 100vh;
      padding: 24px;
      line-height: 1.5;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
    }

    .header {
      background: linear-gradient(135deg, #6264A7 0%, #8b8cc7 100%);
      padding: 24px 32px;
      border-radius: 8px;
      margin-bottom: 24px;
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
    }

    h1 {
      font-size: 28px;
      font-weight: 600;
      color: #ffffff;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .subtitle {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.85);
      margin-top: 8px;
      font-weight: 400;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 24px;
      margin-bottom: 24px;
    }

    .card {
      background: #2d2c2c;
      border: 1px solid #3b3a39;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .card h2 {
      font-size: 18px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 2px solid #6264A7;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .info-item {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid #3b3a39;
      font-size: 14px;
    }

    .info-item:last-child {
      border-bottom: none;
    }

    .label {
      color: #a19f9d;
      font-weight: 500;
    }

    .value {
      color: #ffffff;
      font-weight: 400;
      font-family: 'Consolas', 'Courier New', monospace;
      font-size: 13px;
    }

    .diagram-card {
      background: #2d2c2c;
      border: 1px solid #3b3a39;
      border-radius: 8px;
      padding: 32px;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
      margin-bottom: 24px;
    }

    .diagram-card h2 {
      font-size: 20px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 24px;
      text-align: center;
    }

    .diagram-container {
      background: #1f1f1f;
      padding: 24px;
      border-radius: 8px;
      border: 1px solid #3b3a39;
    }

    .actions {
      display: flex;
      gap: 16px;
      align-items: center;
      flex-wrap: wrap;
    }

    .btn {
      background: #6264A7;
      color: #ffffff;
      border: none;
      padding: 12px 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Segoe UI', sans-serif;
      transition: background 0.2s ease;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }

    .btn:hover {
      background: #7577bd;
    }

    .btn:active {
      background: #545699;
    }

    .status-indicator {
      flex: 1;
      background: #2d2c2c;
      border: 1px solid #3b3a39;
      padding: 12px 20px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      font-weight: 500;
    }

    .status-indicator.connected {
      border-color: #92c353;
    }

    .status-indicator.disconnected {
      border-color: #c4314b;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }

    .status-dot.online {
      background: #92c353;
      box-shadow: 0 0 8px #92c353;
    }

    .status-dot.offline {
      background: #c4314b;
      box-shadow: 0 0 8px #c4314b;
    }

    .badge {
      display: inline-block;
      padding: 4px 12px;
      background: #6264A7;
      color: #ffffff;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
    }

    .mermaid {
      background: transparent;
    }

    /* Scrollbar styling for dark mode */
    ::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }

    ::-webkit-scrollbar-track {
      background: #1f1f1f;
    }

    ::-webkit-scrollbar-thumb {
      background: #3b3a39;
      border-radius: 6px;
    }

    ::-webkit-scrollbar-thumb:hover {
      background: #484644;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="white" stroke-width="2"/>
          <path d="M12 2C12 2 17 7 17 12C17 17 12 22 12 22" stroke="white" stroke-width="2"/>
          <path d="M12 2C12 2 7 7 7 12C7 17 12 22 12 22" stroke="white" stroke-width="2"/>
          <circle cx="12" cy="12" r="2" fill="white"/>
        </svg>
        Ring Node: ${this.alias}
      </h1>
      <div class="subtitle">Distributed Ring Topology with CRDT State Synchronization</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>📊 Node Information</h2>
        <div class="info-item">
          <span class="label">Node ID</span>
          <span class="value">${this.node.getNodeId().substring(0, 16)}...</span>
        </div>
        <div class="info-item">
          <span class="label">Alias</span>
          <span class="value">${this.alias}</span>
        </div>
        <div class="info-item">
          <span class="label">Ring Members</span>
          <span class="value"><span class="badge">${ring.length}</span></span>
        </div>
        ${successor ? `<div class="info-item">
          <span class="label">Successor</span>
          <span class="value">${successor.alias}</span>
        </div>` : ''}
        ${predecessor ? `<div class="info-item">
          <span class="label">Predecessor</span>
          <span class="value">${predecessor.alias}</span>
        </div>` : ''}
      </div>

      <div class="card">
        <h2>🕐 CRDT State</h2>
        <div class="info-item">
          <span class="label">Vector Clock</span>
          <span class="value">${clockEntries || 'empty'}</span>
        </div>
        <div class="info-item">
          <span class="label">Token Status</span>
          <span class="value">${tokenInfo}</span>
        </div>
        <div class="info-item">
          <span class="label">Sync Interval</span>
          <span class="value">2000ms</span>
        </div>
      </div>
    </div>

    <div class="diagram-card">
      <h2>Ring Topology</h2>
      <div class="diagram-container">
        <div class="mermaid">
${mermaidDiagram}
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="btn" onclick="location.reload()">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M13.65 2.35C12.2 0.9 10.21 0 8 0 3.58 0 0 3.58 0 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L9 7h7V0l-2.35 2.35z"/>
        </svg>
        Refresh
      </button>
      <div id="status" class="status-indicator connected">
        <span class="status-dot online"></span>
        <span>Live updates active</span>
      </div>
    </div>
  </div>

  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'dark',
      themeVariables: {
        darkMode: true,
        background: '#1f1f1f',
        primaryColor: '#6264A7',
        primaryTextColor: '#fff',
        primaryBorderColor: '#8b8cc7',
        lineColor: '#a19f9d',
        secondaryColor: '#2d2c2c',
        tertiaryColor: '#3b3a39',
        noteTextColor: '#fff',
        noteBkgColor: '#2d2c2c',
        noteBorderColor: '#6264A7'
      },
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis'
      }
    });

    // Connect to SSE for real-time updates
    const eventSource = new EventSource('/events');
    let updateTimeout = null;

    eventSource.onmessage = function(event) {
      const data = JSON.parse(event.data);

      if (data.type === 'topology-update') {
        // Debounce updates to avoid too many reloads
        if (updateTimeout) clearTimeout(updateTimeout);

        updateTimeout = setTimeout(() => {
          console.log('Ring topology updated, refreshing page...');
          location.reload();
        }, 500); // Wait 500ms before reload
      }
    };

    eventSource.onerror = function(err) {
      console.error('SSE connection error:', err);
      const status = document.getElementById('status');
      if (status) {
        status.className = 'status-indicator disconnected';
        status.innerHTML = '<span class="status-dot offline"></span><span>Live updates disconnected</span>';
      }
    };

    eventSource.onopen = function() {
      console.log('SSE connection established');
      const status = document.getElementById('status');
      if (status) {
        status.className = 'status-indicator connected';
        status.innerHTML = '<span class="status-dot online"></span><span>Live updates active</span>';
      }
    };
  </script>
</body>
</html>`;
  }
}

// Main
async function main() {
  const alias = process.argv[2] || `ring-${Math.floor(Math.random() * 1000)}`;
  const webPort = process.argv[3] ? parseInt(process.argv[3], 10) : 0; // 0 = random port

  console.log('='.repeat(60));
  console.log('Ring Topology Example (with CRDT state)');
  console.log('='.repeat(60));
  console.log(`Node alias: ${alias}`);
  console.log('');

  const ringNode = new RingNode(alias, webPort);
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
