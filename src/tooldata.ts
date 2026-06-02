// tooldata.ts — Secure read-only data API for KIRA's deployed ERC-8257 tools
// Tools call this endpoint instead of holding Redis credentials.
// Validates a per-tool read key and only serves whitelisted key prefixes (read-only).

import { createServer, IncomingMessage, ServerResponse } from "http";
import { kiraRedis } from "./redis.js";

const TOOL_READ_KEY = process.env.TOOL_READ_KEY || "";

// Only these key prefixes may ever be read by external tools.
// Everything else in KIRA's Redis (private keys references, twitter state,
// proposals, agent memory) is NEVER exposed.
const ALLOWED_PREFIXES = [
  "kira:floor:",          // floor oracle data
  "kira:score:",          // NFT scores
  "kira:smartmoney:signals", // smart money signals (public-safe subset)
  "kira:research:macro",  // macro context
];

function isAllowed(key: string): boolean {
  return ALLOWED_PREFIXES.some(p => key === p || key.startsWith(p));
}

export function startToolDataServer(port: number): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const url = new URL(req.url || "/", `http://localhost:${port}`);
    if (url.pathname !== "/tool-data") {
      res.writeHead(404); res.end("Not found"); return;
    }

    // Auth — tools must present the shared read key
    const providedKey = req.headers["x-tool-key"];
    if (!TOOL_READ_KEY || providedKey !== TOOL_READ_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const dataKey = url.searchParams.get("key") || "";
    if (!isAllowed(dataKey)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Key not permitted" }));
      return;
    }

    try {
      const value = await kiraRedis.get(dataKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ key: dataKey, value }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message || "lookup failed" }));
    }
  });

  server.listen(port, () => {
    console.log(`[ToolData] Secure tool data API on port ${port}`);
  });

  server.on("error", (err: any) => {
    console.error("[ToolData] Server error:", err?.message);
  });
}
