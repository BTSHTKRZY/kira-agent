// dashboard.ts — Simple HTTP dashboard for KIRA's state
// Read-only, no auth needed, runs on PORT 3000

import { createServer, IncomingMessage, ServerResponse } from "http";

export interface DashboardState {
  version:          string;
  uptime:           number;
  cycleCount:       number;
  postCount:        number;
  xApiAvailable:    boolean;
  baseBalance:      string;
  watchlistCount:   number;
  paperTradeCount:  number;
  ecosystemSummary: string;
  macroSummary:     string;
  smartMoneySummary:string;
  floorHistory:     string;
  proposalSummary:  string;
  recentPosts:      string[];
  recentLearnings:  string[];
  lastMarketScan:   number;
  lastUpdate:       number;
}

let dashState: DashboardState = {
  version:          "4.2",
  uptime:           0,
  cycleCount:       0,
  postCount:        0,
  xApiAvailable:    false,
  baseBalance:      "0",
  watchlistCount:   0,
  paperTradeCount:  0,
  ecosystemSummary: "",
  macroSummary:     "",
  smartMoneySummary:"",
  floorHistory:     "",
  proposalSummary:  "",
  recentPosts:      [],
  recentLearnings:  [],
  lastMarketScan:   0,
  lastUpdate:       Date.now(),
};

export function updateDashboard(state: Partial<DashboardState>): void {
  dashState = { ...dashState, ...state, lastUpdate: Date.now() };
}

function htmlDashboard(s: DashboardState): string {
  const uptimeHours = Math.floor(s.uptime / 3600000);
  const uptimeMins  = Math.floor((s.uptime % 3600000) / 60000);
  const lastScan    = s.lastMarketScan > 0
    ? Math.floor((Date.now() - s.lastMarketScan) / 60000) + " min ago"
    : "pending";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>KIRA — Normie #2635</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: 'Courier New', monospace;
      padding: 24px;
      max-width: 900px;
      margin: 0 auto;
    }
    h1 { color: #a78bfa; font-size: 1.4rem; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 0.8rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card {
      background: #141414;
      border: 1px solid #222;
      border-radius: 8px;
      padding: 16px;
    }
    .card-label { color: #888; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
    .card-value { color: #e0e0e0; font-size: 1.1rem; }
    .card-value.green  { color: #4ade80; }
    .card-value.yellow { color: #facc15; }
    .card-value.red    { color: #f87171; }
    .section { background: #141414; border: 1px solid #222; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .section h2 { color: #a78bfa; font-size: 0.85rem; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; }
    .item { color: #ccc; font-size: 0.8rem; padding: 4px 0; border-bottom: 1px solid #1a1a1a; }
    .item:last-child { border-bottom: none; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .dot-green  { background: #4ade80; }
    .dot-yellow { background: #facc15; }
    .dot-red    { background: #f87171; }
    .timestamp  { color: #444; font-size: 0.7rem; margin-top: 16px; text-align: right; }
  </style>
</head>
<body>
  <h1>KIRA — Normie #2635</h1>
  <div class="subtitle">Autonomous on-chain agent | Canvas untouched by choice</div>

  <div class="grid">
    <div class="card">
      <div class="card-label">Status</div>
      <div class="card-value green">
        <span class="status-dot dot-green"></span>Online
      </div>
    </div>
    <div class="card">
      <div class="card-label">Version</div>
      <div class="card-value">v${s.version}</div>
    </div>
    <div class="card">
      <div class="card-label">Uptime</div>
      <div class="card-value">${uptimeHours}h ${uptimeMins}m</div>
    </div>
    <div class="card">
      <div class="card-label">Cycles</div>
      <div class="card-value">${s.cycleCount}</div>
    </div>
    <div class="card">
      <div class="card-label">Balance</div>
      <div class="card-value">${parseFloat(s.baseBalance).toFixed(4)} ETH</div>
    </div>
    <div class="card">
      <div class="card-label">X API</div>
      <div class="card-value ${s.xApiAvailable ? "green" : "red"}">
        ${s.xApiAvailable ? "✓ Live" : "✗ Offline"}
      </div>
    </div>
    <div class="card">
      <div class="card-label">Posts Today</div>
      <div class="card-value">${s.postCount}/5</div>
    </div>
    <div class="card">
      <div class="card-label">Watchlist</div>
      <div class="card-value yellow">${s.watchlistCount} items</div>
    </div>
    <div class="card">
      <div class="card-label">Paper Trades</div>
      <div class="card-value">${s.paperTradeCount}</div>
    </div>
    <div class="card">
      <div class="card-label">Last Market Scan</div>
      <div class="card-value">${lastScan}</div>
    </div>
  </div>

  <div class="section">
    <h2>Market Intelligence</h2>
    <div class="item">📊 ${s.macroSummary || "Not yet fetched"}</div>
    <div class="item">🌊 ${s.ecosystemSummary || "Not yet fetched"}</div>
    <div class="item">🐋 ${s.smartMoneySummary || "Not yet fetched"}</div>
    <div class="item">📈 ${s.floorHistory || "Not yet fetched"}</div>
    <div class="item">📋 ${s.proposalSummary || "No proposals"}</div>
  </div>

  <div class="section">
    <h2>Recent Posts</h2>
    ${s.recentPosts.slice(-5).reverse().map(p =>
      `<div class="item">${p.replace(/\[.*?\] /, "")}</div>`
    ).join("") || '<div class="item">No posts yet</div>'}
  </div>

  <div class="section">
    <h2>Recent Learnings</h2>
    ${s.recentLearnings.slice(-8).reverse().map(l =>
      `<div class="item">${l.slice(0, 120)}</div>`
    ).join("") || '<div class="item">None yet</div>'}
  </div>

  <div class="timestamp">
    Last updated: ${new Date(s.lastUpdate).toISOString()} | Auto-refresh: 60s
  </div>
</body>
</html>`;
}

export function startDashboard(port: number = 3000): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health" || req.url === "/") {
      const isJson = req.headers.accept?.includes("application/json");

      if (isJson || req.url === "/api") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ...dashState,
          recentPosts:     dashState.recentPosts.slice(-5),
          recentLearnings: dashState.recentLearnings.slice(-10),
        }, null, 2));
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(htmlDashboard(dashState));
      }
    } else if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(dashState, null, 2));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(port, () => {
    console.log(`[Dashboard] Running at http://localhost:${port}`);
  });

  server.on("error", (err: any) => {
    console.error("[Dashboard] Server error:", err?.message);
  });
}
