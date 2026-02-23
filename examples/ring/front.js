const http = require('http');
const { fork } = require('child_process');
const path = require('path');

/**
 * Front-End Server for the Ring Example
 *
 * Responsibilities:
 *  1. Spawns ring nodes as child processes
 *  2. Serves a unified web dashboard with SVG ring visualisation
 *  3. Aggregates ring topology from node JSON APIs
 *  4. Load-balances proxy requests across ring nodes (round-robin)
 */

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_FRONT_PORT = 3000;
const DEFAULT_NODE_COUNT = 3;
const NODE_BASE_PORT = 9100;

// ── State ───────────────────────────────────────────────────────────────────

const nodes = [];
let roundRobinIndex = 0;
const sseClients = [];

// ── Node Management ─────────────────────────────────────────────────────────

function spawnNode(alias, webPort) {
    const nodePath = path.join(__dirname, 'node.js');
    const child = fork(nodePath, [alias, String(webPort)], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
    });

    const entry = {
        alias,
        port: webPort,
        process: child,
        status: 'starting',
        pid: child.pid || null,
        startedAt: Date.now(),
    };

    child.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line) {
            console.log(`  [${alias}] ${line}`);
            if (line.includes('API server:')) {
                entry.status = 'running';
                broadcastSSE({ type: 'node-status', alias, status: 'running' });
            }
        }
    });

    child.stderr.on('data', (data) => {
        const line = data.toString().trim();
        if (line) console.error(`  [${alias}] ERR: ${line}`);
    });

    child.on('exit', (code) => {
        console.log(`  [${alias}] Process exited (code=${code})`);
        entry.status = 'stopped';
        broadcastSSE({ type: 'node-status', alias, status: 'stopped', code });
        // Re-poll topology now that the node is truly gone
        setTimeout(() => pollTopology(), 300);
    });

    nodes.push(entry);
    return entry;
}

function spawnAllNodes(count) {
    console.log(`\nSpawning ${count} ring nodes...\n`);
    for (let i = 0; i < count; i++) {
        const alias = `ring-${i + 1}`;
        const port = NODE_BASE_PORT + i;
        spawnNode(alias, port);
        console.log(`  -> ${alias} on port ${port} (pid: ${nodes[nodes.length - 1].pid})`);
    }
    console.log('');
}

// ── Load Balancing ──────────────────────────────────────────────────────────

function getNextNode() {
    const running = nodes.filter((n) => n.status === 'running');
    if (running.length === 0) return null;
    const node = running[roundRobinIndex % running.length];
    roundRobinIndex = (roundRobinIndex + 1) % running.length;
    return node;
}

function proxyRequest(targetPort, req, res) {
    const options = {
        hostname: '127.0.0.1',
        port: targetPort,
        path: req.url.replace(/^\/proxy/, '') || '/',
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
    };
    const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });
    proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Gateway', message: err.message }));
    });
    req.pipe(proxyReq, { end: true });
}

// ── SSE ─────────────────────────────────────────────────────────────────────

function broadcastSSE(data) {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((client) => {
        try { client.write(payload); } catch (_) { /* ignore */ }
    });
}

// ── Fetch ring topology from each node's API ────────────────────────────────

function fetchJSON(port, path) {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => {
                try { resolve({ ok: true, data: JSON.parse(body) }); }
                catch (_) { resolve({ ok: false }); }
            });
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(2000, () => { req.destroy(); resolve({ ok: false }); });
    });
}

/**
 * Poll all running nodes for full ring topology and broadcast via SSE.
 */
async function pollTopology() {
    const nodesSummary = [];
    let ringMembers = null;  // use the first successful response as canonical
    let ringState = null;

    for (const node of nodes) {
        const info = { alias: node.alias, port: node.port, status: node.status, pid: node.pid, uptime: 0 };
        info.uptime = node.status !== 'stopped' ? Date.now() - node.startedAt : 0;

        if (node.status === 'running') {
            const result = await fetchJSON(node.port, '/api/status');
            if (result.ok) {
                info.ringData = result.data;
                if (!ringMembers && result.data.members && result.data.members.length > 0) {
                    ringMembers = result.data.members;
                    ringState = result.data.ringState;
                }
            }
        }
        nodesSummary.push(info);
    }

    broadcastSSE({
        type: 'topology-update',
        nodes: nodesSummary,
        ringMembers: ringMembers || [],
        ringState: ringState || 'BOOTSTRAPPING',
        timestamp: Date.now(),
    });
}

setInterval(pollTopology, 2000);

// ── HTTP Server ─────────────────────────────────────────────────────────────

function handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Dashboard
    if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(generateDashboardHTML());
        return;
    }

    // API: aggregated ring topology
    if (url.pathname === '/api/ring') {
        (async () => {
            const results = [];
            let ringMembers = null;
            let ringState = null;
            for (const node of nodes) {
                if (node.status === 'running') {
                    const r = await fetchJSON(node.port, '/api/status');
                    if (r.ok) {
                        results.push(r.data);
                        if (!ringMembers && r.data.members && r.data.members.length > 0) {
                            ringMembers = r.data.members;
                            ringState = r.data.ringState;
                        }
                    }
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ nodes: results, ringMembers: ringMembers || [], ringState: ringState || 'BOOTSTRAPPING' }));
        })();
        return;
    }

    // API: node list (process-level info)
    if (url.pathname === '/api/nodes') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(nodes.map((n) => ({
            alias: n.alias, port: n.port, status: n.status, pid: n.pid,
            uptime: n.status !== 'stopped' ? Date.now() - n.startedAt : 0,
        }))));
        return;
    }

    // API: add node
    if (url.pathname === '/api/nodes/add' && req.method === 'POST') {
        const alias = url.searchParams.get('alias') || `ring-${nodes.length + 1}`;
        const port = NODE_BASE_PORT + nodes.length;
        spawnNode(alias, port);
        console.log(`  -> Added ${alias} on port ${port}`);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ alias, port, status: 'starting' }));
        return;
    }

    // API: stop node
    if (url.pathname.startsWith('/api/nodes/stop/') && req.method === 'POST') {
        const alias = url.pathname.split('/').pop();
        const node = nodes.find((n) => n.alias === alias);
        if (!node || node.status === 'stopped' || node.status === 'stopping') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Node not found or already stopped' }));
            return;
        }
        node.status = 'stopping';
        node.process.kill('SIGINT');
        // Broadcast immediately so SSE clients see the change right away
        broadcastSSE({ type: 'node-status', alias, status: 'stopping' });
        // Also poll topology shortly after to refresh ring data
        setTimeout(() => pollTopology(), 500);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ alias, status: 'stopping' }));
        return;
    }

    // SSE
    if (url.pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });
        res.write('data: {"type":"connected"}\n\n');
        sseClients.push(res);
        req.on('close', () => {
            const idx = sseClients.indexOf(res);
            if (idx !== -1) sseClients.splice(idx, 1);
        });
        return;
    }

    // Load-balanced proxy
    if (url.pathname.startsWith('/proxy')) {
        const target = getNextNode();
        if (!target) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No running nodes available' }));
            return;
        }
        res.setHeader('X-Ring-Node', target.alias);
        proxyRequest(target.port, req, res);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
}

// ── Dashboard HTML ──────────────────────────────────────────────────────────

function generateDashboardHTML() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Distflow Ring — Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
      background: #1b1b1b; color: #e0e0e0;
      min-height: 100vh; line-height: 1.5;
    }

    /* ── Header ──────────────────────────────────── */
    .header {
      background: linear-gradient(135deg, #6264A7 0%, #464775 50%, #33344A 100%);
      padding: 24px 40px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 4px 16px rgba(0,0,0,.4);
    }
    .header h1 { font-size: 24px; font-weight: 700; color: #fff; }
    .header .subtitle { font-size: 12px; color: rgba(255,255,255,.65); margin-top: 2px; }
    .header-right { display: flex; gap: 10px; align-items: center; }

    /* ── Buttons ──────────────────────────────────── */
    .btn {
      border: none; padding: 8px 18px; border-radius: 6px; cursor: pointer;
      font-size: 13px; font-weight: 600; font-family: inherit;
      transition: background .15s, transform .1s; display: inline-flex; align-items: center; gap: 6px;
    }
    .btn:active { transform: scale(.97); }
    .btn-primary { background: #6264A7; color: #fff; }
    .btn-primary:hover { background: #7577bd; }
    .btn-danger { background: #c4314b; color: #fff; }
    .btn-danger:hover { background: #d9435d; }
    .btn-ghost { background: rgba(255,255,255,.08); color: #e0e0e0; border: 1px solid #444; }
    .btn-ghost:hover { background: rgba(255,255,255,.14); }
    .btn-sm { padding: 5px 12px; font-size: 12px; }

    /* ── Layout ──────────────────────────────────── */
    .main { max-width: 1440px; margin: 0 auto; padding: 24px 40px; }

    /* ── Stats ────────────────────────────────────── */
    .status-bar { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
    .stat-card {
      background: #252526; border: 1px solid #333; border-radius: 8px;
      padding: 14px 22px; flex: 1; min-width: 150px; text-align: center;
    }
    .stat-value { font-size: 28px; font-weight: 700; color: #fff; }
    .stat-label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }

    /* ── Two-column layout ────────────────────────── */
    .content-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    @media (max-width: 960px) { .content-grid { grid-template-columns: 1fr; } }

    /* ── Ring Visualisation ───────────────────────── */
    .ring-card {
      background: #252526; border: 1px solid #333; border-radius: 10px;
      padding: 24px; display: flex; flex-direction: column; align-items: center;
    }
    .ring-card h2 {
      font-size: 16px; font-weight: 600; color: #ccc; margin-bottom: 16px;
      display: flex; align-items: center; gap: 8px; align-self: flex-start;
    }
    #ringCanvas {
      background: #1b1b1b; border: 1px solid #333; border-radius: 8px;
    }

    /* ── Node list ───────────────────────────────── */
    .node-list-card {
      background: #252526; border: 1px solid #333; border-radius: 10px; padding: 24px;
      max-height: 540px; overflow-y: auto;
    }
    .node-list-card h2 {
      font-size: 16px; font-weight: 600; color: #ccc; margin-bottom: 14px;
      display: flex; align-items: center; gap: 8px;
    }
    .node-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; border-radius: 6px; margin-bottom: 6px;
      background: #1f1f1f; border: 1px solid #2d2d2d;
      transition: border-color .15s;
    }
    .node-row:hover { border-color: #6264A7; }
    .node-row.stopped { opacity: .45; }
    .node-alias { font-weight: 700; color: #fff; font-family: 'Consolas', monospace; font-size: 14px; }
    .node-meta { font-size: 11px; color: #888; margin-top: 2px; }
    .node-badge {
      display: inline-block; padding: 2px 8px; border-radius: 10px;
      font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
    }
    .badge-running  { background: rgba(146,195,83,.15); color: #92c353; border: 1px solid rgba(146,195,83,.3); }
    .badge-starting { background: rgba(240,173,78,.15); color: #f0ad4e; border: 1px solid rgba(240,173,78,.3); }
    .badge-stopped  { background: rgba(196,49,75,.15);  color: #c4314b; border: 1px solid rgba(196,49,75,.3); }
    .node-row-right { display: flex; align-items: center; gap: 8px; }

    /* ── LB Section ──────────────────────────────── */
    .lb-section {
      background: #252526; border: 1px solid #333; border-radius: 10px;
      padding: 24px; margin-bottom: 24px;
    }
    .lb-section h2 { font-size: 16px; font-weight: 600; color: #ccc; margin-bottom: 14px; }
    .lb-area { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
    .lb-result {
      background: #1b1b1b; border: 1px solid #333; border-radius: 8px;
      padding: 14px; flex: 1; min-width: 280px; max-height: 200px; overflow-y: auto;
      font-family: 'Consolas', monospace; font-size: 12px; color: #ccc;
    }
    .lb-entry { padding: 3px 0; border-bottom: 1px solid #2a2a2a; display: flex; gap: 10px; }
    .lb-entry .lb-node { color: #6264A7; font-weight: 600; min-width: 72px; }
    .lb-entry .lb-status { color: #92c353; }
    .lb-entry .lb-time { color: #666; font-size: 11px; }

    /* ── Log ──────────────────────────────────────── */
    .log-section {
      background: #1b1b1b; border: 1px solid #333; border-radius: 10px; padding: 18px;
    }
    .log-section h2 { font-size: 14px; font-weight: 600; color: #999; margin-bottom: 10px; }
    #eventLog {
      max-height: 150px; overflow-y: auto;
      font-family: 'Consolas', monospace; font-size: 11px; color: #777; line-height: 1.7;
    }
    .log-ts { color: #555; margin-right: 6px; }

    /* ── SSE dot ─────────────────────────────────── */
    .sse-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .sse-dot.online  { background: #92c353; box-shadow: 0 0 6px #92c353; }
    .sse-dot.offline { background: #c4314b; box-shadow: 0 0 6px #c4314b; }

    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #3b3a39; border-radius: 4px; }
  </style>
</head>
<body>

<div class="header">
  <div>
    <h1>⚡ Distflow Ring Dashboard</h1>
    <div class="subtitle">Front-end load balancer &amp; ring visualisation</div>
  </div>
  <div class="header-right">
    <span class="sse-dot online" id="sseDot"></span>
    <span style="font-size:11px;color:#aaa" id="sseLabel">Connected</span>
    <button class="btn btn-primary btn-sm" onclick="addNode()">＋ Add Node</button>
  </div>
</div>

<div class="main">
  <!-- Stats -->
  <div class="status-bar">
    <div class="stat-card"><div class="stat-value" id="statTotal">0</div><div class="stat-label">Total</div></div>
    <div class="stat-card"><div class="stat-value" id="statRunning" style="color:#92c353">0</div><div class="stat-label">Running</div></div>
    <div class="stat-card"><div class="stat-value" id="statStopped" style="color:#c4314b">0</div><div class="stat-label">Stopped</div></div>
    <div class="stat-card"><div class="stat-value" id="statRingSize" style="color:#6264A7">0</div><div class="stat-label">Ring Members</div></div>
    <div class="stat-card"><div class="stat-value" id="statRingState" style="font-size:14px;color:#f0ad4e">—</div><div class="stat-label">Ring State</div></div>
    <div class="stat-card"><div class="stat-value" id="statLBCount" style="color:#6264A7">0</div><div class="stat-label">LB Calls</div></div>
  </div>

  <!-- Ring visualisation + Node list -->
  <div class="content-grid">
    <div class="ring-card">
      <h2>🔄 Ring Topology</h2>
      <canvas id="ringCanvas" width="460" height="460"></canvas>
    </div>
    <div class="node-list-card">
      <h2>🖥️ Nodes</h2>
      <div id="nodeList"><div style="color:#666;padding:20px;text-align:center">Waiting for nodes…</div></div>
    </div>
  </div>

  <!-- Load Balancer -->
  <div class="lb-section">
    <h2>⚖️ Load Balancer</h2>
    <div class="lb-area">
      <div style="display:flex;flex-direction:column;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="sendLBRequest()">Send Request</button>
        <button class="btn btn-ghost btn-sm" onclick="sendBurstLB(5)">Burst ×5</button>
        <button class="btn btn-ghost btn-sm" onclick="clearLBLog()">Clear</button>
      </div>
      <div class="lb-result" id="lbResult"><div style="color:#555">No requests yet.</div></div>
    </div>
  </div>

  <!-- Log -->
  <div class="log-section">
    <h2>📋 Event Log</h2>
    <div id="eventLog"></div>
  </div>
</div>

<script>
// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════
let nodesData = [];
let ringMembers = [];
let ringState = 'BOOTSTRAPPING';
let lbCount = 0;
let lbFirst = true;

// ═══════════════════════════════════════════════════════════════════════════
// SSE
// ═══════════════════════════════════════════════════════════════════════════
const es = new EventSource('/events');
es.onopen = () => {
  document.getElementById('sseDot').className = 'sse-dot online';
  document.getElementById('sseLabel').textContent = 'Connected';
};
es.onerror = () => {
  document.getElementById('sseDot').className = 'sse-dot offline';
  document.getElementById('sseLabel').textContent = 'Disconnected';
};
es.onmessage = (evt) => {
  const d = JSON.parse(evt.data);
  if (d.type === 'topology-update') {
    nodesData = d.nodes || nodesData;
    ringMembers = d.ringMembers || ringMembers;
    ringState = d.ringState || ringState;
    render();
  } else if (d.type === 'node-status') {
    logEvent('Node ' + d.alias + ' → ' + d.status);
    // Fetch immediately + again after a short delay to catch the process exit
    fetchAll();
    setTimeout(fetchAll, 1000);
  }
};

async function fetchAll() {
  try {
    const [nodesRes, ringRes] = await Promise.all([
      fetch('/api/nodes'),
      fetch('/api/ring'),
    ]);
    nodesData = await nodesRes.json();
    const ring = await ringRes.json();
    ringMembers = ring.ringMembers || [];
    ringState = ring.ringState || 'BOOTSTRAPPING';
    render();
  } catch (_) {}
}
// Alias for backward compat
const fetchNodes = fetchAll;

// ═══════════════════════════════════════════════════════════════════════════
// Render
// ═══════════════════════════════════════════════════════════════════════════
function render() {
  renderStats();
  renderNodeList();
  renderRing();
}

function renderStats() {
  const total = nodesData.length;
  const running = nodesData.filter(n => n.status === 'running').length;
  const stopped = nodesData.filter(n => n.status === 'stopped').length;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statRunning').textContent = running;
  document.getElementById('statStopped').textContent = stopped;
  document.getElementById('statRingSize').textContent = ringMembers.length;
  const stateEl = document.getElementById('statRingState');
  stateEl.textContent = ringState;
  stateEl.style.color = ringState === 'STABLE' ? '#92c353' : ringState === 'UNSTABLE' ? '#f0ad4e' : '#c4314b';
}

function renderNodeList() {
  const el = document.getElementById('nodeList');
  if (nodesData.length === 0) { el.innerHTML = '<div style="color:#666;padding:20px;text-align:center">No nodes.</div>'; return; }

  el.innerHTML = nodesData.map(n => {
    const bc = n.status === 'running' ? 'badge-running' : n.status === 'starting' ? 'badge-starting' : n.status === 'stopping' ? 'badge-starting' : 'badge-stopped';
    const statusLabel = n.status === 'stopping' ? 'stopping' : n.status;
    const up = n.uptime > 0 ? fmtUp(n.uptime) : '—';
    // Find ring data for this node
    const rd = n.ringData;
    const ringInfo = rd ? 'members: ' + rd.size + ' | peers: ' + rd.onlinePeers : '';
    const dimmed = (n.status === 'stopped' || n.status === 'stopping') ? 'stopped' : '';
    return '<div class="node-row ' + dimmed + '">'
      + '<div><div class="node-alias">' + n.alias + '</div>'
      + '<div class="node-meta">:' + n.port + ' · pid ' + (n.pid || '—') + ' · ' + up
      + (ringInfo ? ' · ' + ringInfo : '') + '</div></div>'
      + '<div class="node-row-right"><span class="node-badge ' + bc + '">' + statusLabel + '</span>'
      + (n.status === 'running' ? '<button class="btn btn-danger btn-sm" onclick="stopNode(\\'' + n.alias + '\\')">Stop</button>' : '')
      + '</div></div>';
  }).join('');
}

function fmtUp(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// ═══════════════════════════════════════════════════════════════════════════
// Ring Canvas Rendering
// ═══════════════════════════════════════════════════════════════════════════
function renderRing() {
  const canvas = document.getElementById('ringCanvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) / 2 - 60; // ring radius

  ctx.clearRect(0, 0, W, H);

  // Draw the ring circle
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#3b3a39';
  ctx.lineWidth = 2;
  ctx.stroke();

  const members = ringMembers;
  if (!members || members.length === 0) {
    ctx.fillStyle = '#666';
    ctx.font = '14px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Waiting for ring members…', cx, cy);
    return;
  }

  const n = members.length;
  const nodeRadius = Math.max(18, Math.min(28, 120 / n));
  const positions = [];

  // Compute positions on the circle (starting from top, clockwise)
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
    positions.push({
      x: cx + R * Math.cos(angle),
      y: cy + R * Math.sin(angle),
      angle,
    });
  }

  // Draw edges (arcs between consecutive nodes)
  ctx.strokeStyle = '#6264A7';
  ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const from = positions[i];
    const to = positions[(i + 1) % n];
    drawArrow(ctx, from.x, from.y, to.x, to.y, nodeRadius);
  }

  // Draw nodes
  for (let i = 0; i < n; i++) {
    const m = members[i];
    const p = positions[i];
    const isRunning = nodesData.some(nd => nd.alias === m.alias && nd.status === 'running');

    // Glow
    if (isRunning) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(p.x, p.y, nodeRadius + 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(98,100,167,0.15)';
      ctx.fill();
      ctx.restore();
    }

    // Node circle
    ctx.beginPath();
    ctx.arc(p.x, p.y, nodeRadius, 0, Math.PI * 2);
    ctx.fillStyle = isRunning ? '#6264A7' : '#c4314b';
    ctx.fill();
    ctx.strokeStyle = isRunning ? '#8b8cc7' : '#e05c75';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Alias text
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.max(10, nodeRadius * 0.55) + 'px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const label = m.alias || m.nodeId.substring(0, 6);
    ctx.fillText(label, p.x, p.y);

    // Token hash below node
    ctx.fillStyle = '#888';
    ctx.font = Math.max(8, nodeRadius * 0.4) + 'px Consolas, monospace';
    const hashLabel = '@' + (m.tokenHex || m.token.toString(16)).substring(0, 8);
    const labelOffset = nodeRadius + 14;
    // Place label outside the circle
    const lx = cx + (R + labelOffset) * Math.cos(positions[i].angle);
    const ly = cy + (R + labelOffset) * Math.sin(positions[i].angle);
    ctx.fillText(hashLabel, lx, ly);
  }

  // Center text
  ctx.fillStyle = '#555';
  ctx.font = '12px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(n + ' member' + (n > 1 ? 's' : ''), cx, cy - 8);
  const stColor = ringState === 'STABLE' ? '#92c353' : ringState === 'UNSTABLE' ? '#f0ad4e' : '#c4314b';
  ctx.fillStyle = stColor;
  ctx.font = 'bold 12px Segoe UI, sans-serif';
  ctx.fillText(ringState, cx, cy + 8);
}

function drawArrow(ctx, x1, y1, x2, y2, nodeR) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist === 0) return;
  const ux = dx / dist, uy = dy / dist;
  // Shorten by node radius at both ends
  const sx = x1 + ux * (nodeR + 2), sy = y1 + uy * (nodeR + 2);
  const ex = x2 - ux * (nodeR + 6), ey = y2 - uy * (nodeR + 6);

  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();

  // Arrowhead
  const headLen = 8;
  const angle = Math.atan2(ey - sy, ex - sx);
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - headLen * Math.cos(angle - 0.4), ey - headLen * Math.sin(angle - 0.4));
  ctx.lineTo(ex - headLen * Math.cos(angle + 0.4), ey - headLen * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fillStyle = '#6264A7';
  ctx.fill();
}

// ═══════════════════════════════════════════════════════════════════════════
// Actions
// ═══════════════════════════════════════════════════════════════════════════
async function addNode() {
  try {
    const r = await fetch('/api/nodes/add', { method: 'POST' });
    const d = await r.json();
    logEvent('Added ' + d.alias + ' on :' + d.port);
    fetchNodes();
  } catch (e) { console.error(e); }
}

async function stopNode(alias) {
  try {
    await fetch('/api/nodes/stop/' + alias, { method: 'POST' });
    logEvent('Stopping ' + alias);
    // Poll multiple times to catch the transition starting → stopped
    fetchAll();
    setTimeout(fetchAll, 600);
    setTimeout(fetchAll, 1500);
  } catch (e) { console.error(e); }
}

// ═══════════════════════════════════════════════════════════════════════════
// Load Balancer
// ═══════════════════════════════════════════════════════════════════════════
async function sendLBRequest() {
  if (lbFirst) { document.getElementById('lbResult').innerHTML = ''; lbFirst = false; }
  const t0 = performance.now();
  try {
    const r = await fetch('/proxy/api/status');
    const elapsed = Math.round(performance.now() - t0);
    const node = r.headers.get('X-Ring-Node') || '?';
    lbCount++;
    document.getElementById('statLBCount').textContent = lbCount;
    const e = document.createElement('div');
    e.className = 'lb-entry';
    e.innerHTML = '<span class="lb-node">' + node + '</span><span class="lb-status">' + r.status + '</span><span class="lb-time">' + elapsed + 'ms</span>';
    document.getElementById('lbResult').prepend(e);
  } catch (err) {
    const e = document.createElement('div');
    e.className = 'lb-entry';
    e.innerHTML = '<span style="color:#c4314b">Error: ' + err.message + '</span>';
    document.getElementById('lbResult').prepend(e);
  }
}
async function sendBurstLB(c) { for (let i = 0; i < c; i++) await sendLBRequest(); }
function clearLBLog() { document.getElementById('lbResult').innerHTML = '<div style="color:#555">No requests yet.</div>'; lbFirst = true; }

// ═══════════════════════════════════════════════════════════════════════════
// Event log
// ═══════════════════════════════════════════════════════════════════════════
function logEvent(msg) {
  const log = document.getElementById('eventLog');
  const line = document.createElement('div');
  line.innerHTML = '<span class="log-ts">' + new Date().toLocaleTimeString() + '</span>' + msg;
  log.prepend(line);
  while (log.children.length > 80) log.removeChild(log.lastChild);
}

// ═══════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════
fetchAll();
</script>
</body>
</html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const frontPort = parseInt(process.argv[2], 10) || DEFAULT_FRONT_PORT;
    const nodeCount = parseInt(process.argv[3], 10) || DEFAULT_NODE_COUNT;

    console.log('═'.repeat(60));
    console.log('  Distflow Ring — Front-End Load Balancer');
    console.log('═'.repeat(60));
    console.log('  Dashboard port : ' + frontPort);
    console.log('  Ring nodes     : ' + nodeCount);
    console.log('  Node ports     : ' + NODE_BASE_PORT + '–' + (NODE_BASE_PORT + nodeCount - 1));
    console.log('');

    spawnAllNodes(nodeCount);

    const server = http.createServer(handleRequest);
    server.listen(frontPort, () => {
        console.log('\\n🌐 Dashboard: http://localhost:' + frontPort + '\\n');
        console.log('Routes:');
        console.log('  GET  /                  → Dashboard');
        console.log('  GET  /api/ring          → Aggregated ring topology');
        console.log('  GET  /api/nodes         → Process-level node list');
        console.log('  POST /api/nodes/add     → Spawn a new node');
        console.log('  POST /api/nodes/stop/:a → Stop a node');
        console.log('  GET  /proxy/*           → Round-robin LB proxy');
        console.log('  GET  /events            → SSE live updates');
        console.log('');
    });

    process.on('SIGINT', async () => {
        console.log('\\n\\nShutting down all nodes...');
        for (const node of nodes) {
            if (node.status !== 'stopped') node.process.kill('SIGINT');
        }
        setTimeout(() => { server.close(); process.exit(0); }, 2000);
    });
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
