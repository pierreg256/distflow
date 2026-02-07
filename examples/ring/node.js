const { RingNode, consistentHash } = require('@distflow/core');
const http = require('http');

/**
 * Ring Node with Web UI - extends the core RingNode with web visualization
 */
class RingNodeWithWeb extends RingNode {
  constructor(alias, webPort = 0) {
    super({ alias, metricsIntervalMs: 0, displayIntervalMs: 0 }); // Disable default metrics logging
    this.httpServer = null;
    this.webPort = webPort; // Port for web server (0 = random)
    this.sseClients = []; // SSE clients for real-time updates
  }

  async start() {
    this.on('ring:topology-change', () => {
      console.log("je l'ai eu")
      this.notifyTopologyChange();
    });
    await super.start();

    // Start web server
    await this.startWebServer();
  }

  /**
   * Override topology change hook to notify web clients
   */
  // onTopologyChange() {
  //   super.onTopologyChange();
  //   this.notifyTopologyChange();
  // }

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
          console.log(`[${this.getAlias()}] 📡 SSE client connected (${this.sseClients.length} total)`);

          // Send initial ping
          res.write('data: {"type":"connected"}\n\n');

          // Remove client on disconnect
          req.on('close', () => {
            const index = this.sseClients.indexOf(res);
            if (index !== -1) {
              this.sseClients.splice(index, 1);
              console.log(`[${this.getAlias()}] 📡 SSE client disconnected (${this.sseClients.length} remaining)`);
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
        console.log(`[${this.getAlias()}] 🌐 Web interface: http://localhost:${actualPort}`);
        resolve();
      });
    });
  }

  /**
   * Generate HTML page with Mermaid diagram
   */
  generateHTML() {
    const { ring, successor, predecessor } = this.getRingNeighbors();
    const crdt = this.getCrdt();
    const node = this.getNode();

    if (!crdt || !node) {
      return '<html><body>Loading...</body></html>';
    }

    const state = crdt.value();
    const clock = crdt.clock();

    // Generate Mermaid diagram
    let mermaidDiagram = 'graph LR\n';

    if (ring.length === 0) {
      mermaidDiagram += '    A["No nodes in ring"]\n';
    } else if (ring.length < 3) {
      mermaidDiagram += `    A["Waiting for minimum 3 nodes<br/>Current: ${ring.length}"]\n`;
    } else {
      // Create nodes
      ring.forEach((n, idx) => {
        const hashStr = n.hash.toString(16).substring(0, 8);
        const label = n.nodeId === node.getNodeId()
          ? `"${n.alias}<br/>@${hashStr}<br/>(ME)"`
          : `"${n.alias}<br/>@${hashStr}"`;
        const style = n.nodeId === node.getNodeId() ? ':::current' : '';
        mermaidDiagram += `    N${idx}[${label}]${style}\n`;
      });

      // Create ring edges
      ring.forEach((n, idx) => {
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
  <title>Ring Node: ${this.getAlias()}</title>
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
        Ring Node: ${this.getAlias()}
      </h1>
      <div class="subtitle">Distributed Ring Topology with CRDT State Synchronization</div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>📊 Node Information</h2>
        <div class="info-item">
          <span class="label">Node ID</span>
          <span class="value">${node.getNodeId().substring(0, 16)}...</span>
        </div>
        <div class="info-item">
          <span class="label">Alias</span>
          <span class="value">${this.getAlias()}</span>
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

  async stop() {
    if (this.httpServer) {
      // Close all SSE connections
      this.sseClients.forEach(client => client.end());
      this.sseClients = [];
      this.httpServer.close();
    }
    await super.stop();
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

  const ringNode = new RingNodeWithWeb(alias, webPort);
  await ringNode.start();

  console.log(`[${alias}] ✅ Ring node started`);
  console.log(`[${alias}] Use Ctrl+C to stop`);
  console.log('');


  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log(`\n[${alias}] Shutting down...`);
    /*await*/ ringNode.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
