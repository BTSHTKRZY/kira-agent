// floorhistory.ts — KIRA records NFT floor prices herself
// Every 2 hours, stores floor price snapshots in Redis
// After 7 days: accurate 7d change. After 30 days: accurate 30d change.
// This replaces reliance on OpenSea's incomplete interval data.

import { kiraRedis } from "./redis.js";

export interface FloorSnapshot {
  address:    string;
  chain:      string;
  floorEth:   number;
  timestamp:  number;
}

export interface FloorHistory {
  address:       string;
  chain:         string;
  name:          string;
  snapshots:     FloorSnapshot[];  // stored newest first, max 360 (30 days at 2hr intervals)
  firstRecorded: number;
  lastUpdated:   number;
}

export interface FloorChanges {
  change7d:  number | null;   // null if < 7 days of data
  change30d: number | null;   // null if < 30 days of data
  change24h: number | null;
  daysOfData: number;
  currentFloor: number;
  lowestFloor:  number;       // all-time low in our data
  highestFloor: number;       // all-time high in our data
  trend:        "recovering" | "declining" | "stable" | "insufficient_data";
}

const K = {
  history:    (chain: string, address: string) =>
    `kira:floor:${chain}:${address.toLowerCase()}`,
  tracked:    () => `kira:floor:tracked`,
};

const MAX_SNAPSHOTS    = 360;  // 30 days at 2hr intervals
const SNAPSHOT_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours

export class KiraFloorHistory {

  // ── RECORD SNAPSHOT ──────────────────────────────────────────────────────────

  async recordFloor(
    address:    string,
    chain:      string,
    name:       string,
    floorEth:   number
  ): Promise<void> {
    if (floorEth <= 0) return;

    const key     = K.history(chain, address);
    const history = await kiraRedis.getJson<FloorHistory>(key) || {
      address:       address.toLowerCase(),
      chain,
      name,
      snapshots:     [],
      firstRecorded: Date.now(),
      lastUpdated:   0,
    };

    // Don't record more than once per interval
    const lastSnap = history.snapshots[0];
    if (lastSnap && Date.now() - lastSnap.timestamp < SNAPSHOT_INTERVAL * 0.9) {
      return;
    }

    // Add new snapshot at front
    history.snapshots.unshift({
      address:   address.toLowerCase(),
      chain,
      floorEth,
      timestamp: Date.now(),
    });

    // Trim to max
    if (history.snapshots.length > MAX_SNAPSHOTS) {
      history.snapshots = history.snapshots.slice(0, MAX_SNAPSHOTS);
    }

    history.lastUpdated = Date.now();
    history.name        = name; // update name in case it changed

    await kiraRedis.setJson(key, history);
    await kiraRedis.sadd(K.tracked(), `${chain}:${address.toLowerCase()}`);
  }

  // ── GET FLOOR CHANGES ─────────────────────────────────────────────────────────

  async getFloorChanges(
    address: string,
    chain:   string
  ): Promise<FloorChanges | null> {
    const key     = K.history(chain, address);
    const history = await kiraRedis.getJson<FloorHistory>(key);
    if (!history || history.snapshots.length < 2) return null;

    const snaps       = history.snapshots;
    const currentFloor = snaps[0].floorEth;
    const now          = Date.now();

    // Find snapshots closest to 24h, 7d, 30d ago
    const snap24h  = this.findClosestSnapshot(snaps, now - 24 * 3600 * 1000);
    const snap7d   = this.findClosestSnapshot(snaps, now - 7  * 24 * 3600 * 1000);
    const snap30d  = this.findClosestSnapshot(snaps, now - 30 * 24 * 3600 * 1000);

    const change24h = snap24h
      ? ((currentFloor - snap24h.floorEth) / snap24h.floorEth) * 100
      : null;

    // Only report 7d change if we have at least 6.5 days of data
    const daysOfData = (now - snaps[snaps.length - 1].timestamp) / (24 * 3600 * 1000);
    const change7d   = snap7d && daysOfData >= 6.5
      ? ((currentFloor - snap7d.floorEth) / snap7d.floorEth) * 100
      : null;

    const change30d  = snap30d && daysOfData >= 28
      ? ((currentFloor - snap30d.floorEth) / snap30d.floorEth) * 100
      : null;

    const floors     = snaps.map(s => s.floorEth);
    const lowestFloor  = Math.min(...floors);
    const highestFloor = Math.max(...floors);

    // Trend: compare last 24h avg vs previous 24h avg
    const recent24h = snaps.filter(s => s.timestamp > now - 24 * 3600 * 1000);
    const prev24h   = snaps.filter(
      s => s.timestamp > now - 48 * 3600 * 1000 &&
           s.timestamp <= now - 24 * 3600 * 1000
    );

    let trend: FloorChanges["trend"] = "insufficient_data";
    if (recent24h.length > 0 && prev24h.length > 0) {
      const recentAvg = recent24h.reduce((s, x) => s + x.floorEth, 0) / recent24h.length;
      const prevAvg   = prev24h.reduce((s, x) => s + x.floorEth, 0)   / prev24h.length;
      const diff      = ((recentAvg - prevAvg) / prevAvg) * 100;
      trend = diff > 3 ? "recovering" : diff < -3 ? "declining" : "stable";
    }

    return {
      change7d,
      change30d,
      change24h,
      daysOfData,
      currentFloor,
      lowestFloor,
      highestFloor,
      trend,
    };
  }

  private findClosestSnapshot(
    snaps:      FloorSnapshot[],
    targetTime: number
  ): FloorSnapshot | null {
    if (!snaps.length) return null;
    return snaps.reduce((closest, snap) => {
      const closestDiff = Math.abs(closest.timestamp - targetTime);
      const snapDiff    = Math.abs(snap.timestamp    - targetTime);
      return snapDiff < closestDiff ? snap : closest;
    });
  }

  // ── BULK RECORD (called during market scan) ───────────────────────────────────

  async recordBatch(
    collections: Array<{ address: string; chain: string; name: string; floor: number }>
  ): Promise<void> {
    for (const col of collections) {
      await this.recordFloor(col.address, col.chain, col.name, col.floor);
    }
  }

  // ── GET ALL TRACKED COLLECTIONS ───────────────────────────────────────────────

  async getTrackedCollections(): Promise<Array<{
    address: string; chain: string; name: string; daysOfData: number
  }>> {
    const keys = await kiraRedis.smembers(K.tracked());
    const results = [];

    for (const key of keys) {
      const [chain, address] = key.split(":");
      const history = await kiraRedis.getJson<FloorHistory>(
        K.history(chain, address)
      );
      if (!history) continue;

      const daysOfData = history.snapshots.length > 0
        ? (Date.now() - history.snapshots[history.snapshots.length - 1].timestamp)
          / (24 * 3600 * 1000)
        : 0;

      results.push({
        address,
        chain,
        name:       history.name,
        daysOfData: Math.round(daysOfData * 10) / 10,
      });
    }

    return results;
  }

  // ── ENRICH COLLECTION WITH OWN FLOOR DATA ─────────────────────────────────────

  // Returns floor change data from our own history if available,
  // falls back to provided values if not enough data yet
  async enrichFloorChanges(
    address:       string,
    chain:         string,
    fallback7d:    number,
    fallback30d:   number
  ): Promise<{ floor7dChange: number; floor30dChange: number; dataSource: string }> {
    const changes = await this.getFloorChanges(address, chain);

    if (!changes) {
      return {
        floor7dChange:  fallback7d,
        floor30dChange: fallback30d,
        dataSource:     "opensea",
      };
    }

    return {
      floor7dChange:  changes.change7d  ?? fallback7d,
      floor30dChange: changes.change30d ?? fallback30d,
      dataSource:     changes.daysOfData >= 7 ? "kira_own" : "partial",
    };
  }

  formatForContext(address: string, chain: string, changes: FloorChanges): string {
    return [
      `Floor ${changes.currentFloor.toFixed(4)} ETH`,
      changes.change24h !== null
        ? `24h: ${changes.change24h > 0 ? "+" : ""}${changes.change24h.toFixed(1)}%`
        : "",
      changes.change7d !== null
        ? `7d: ${changes.change7d > 0 ? "+" : ""}${changes.change7d.toFixed(1)}%`
        : `7d: ${changes.daysOfData.toFixed(1)}d data`,
      changes.change30d !== null
        ? `30d: ${changes.change30d > 0 ? "+" : ""}${changes.change30d.toFixed(1)}%`
        : "",
      `Trend: ${changes.trend}`,
    ].filter(Boolean).join(" | ");
  }

  async getSummaryForContext(): Promise<string> {
    const tracked = await this.getTrackedCollections();
    if (!tracked.length) return "No floor history yet";

    const withData = tracked.filter(t => t.daysOfData >= 1);
    return `Floor history: ${tracked.length} collections tracked, ` +
           `${withData.length} with 1+ day data`;
  }
}
