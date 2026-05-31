// redis.ts — Upstash Redis via direct REST fetch
// No SDK. No silent failures. Same pattern as AgentCheck.

const REDIS_URL   = process.env.KIRA_REDIS_URL!;
const REDIS_TOKEN = process.env.KIRA_REDIS_TOKEN!;

function headers(): Record<string, string> {
  return {
    Authorization:  `Bearer ${REDIS_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export const kiraRedis = {

  async get(key: string): Promise<string | null> {
    try {
      const res  = await fetch(
        `${REDIS_URL}/get/${encodeURIComponent(key)}`,
        { headers: headers(), signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json() as any;
      return data.result ?? null;
    } catch (err: any) {
      console.error(`Redis GET failed [${key}]:`, err?.message);
      return null;
    }
  },

  async set(key: string, value: string): Promise<boolean> {
    try {
      const res = await fetch(
        `${REDIS_URL}/set/${encodeURIComponent(key)}`,
        {
          method:  "POST",
          headers: headers(),
          body:    JSON.stringify(value),
          signal:  AbortSignal.timeout(8000),
        }
      );
      const data = await res.json() as any;
      return data.result === "OK";
    } catch (err: any) {
      console.error(`Redis SET failed [${key}]:`, err?.message);
      return false;
    }
  },

  async del(key: string): Promise<boolean> {
    try {
      const res  = await fetch(
        `${REDIS_URL}/del/${encodeURIComponent(key)}`,
        { method: "POST", headers: headers(), signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json() as any;
      return data.result === 1;
    } catch (err: any) {
      console.error(`Redis DEL failed [${key}]:`, err?.message);
      return false;
    }
  },

  async sadd(key: string, ...members: string[]): Promise<boolean> {
    try {
      const res  = await fetch(
        `${REDIS_URL}/sadd/${encodeURIComponent(key)}/${members.map(encodeURIComponent).join("/")}`,
        { method: "POST", headers: headers(), signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json() as any;
      return typeof data.result === "number";
    } catch (err: any) {
      console.error(`Redis SADD failed [${key}]:`, err?.message);
      return false;
    }
  },

  async srem(key: string, member: string): Promise<boolean> {
    try {
      const res  = await fetch(
        `${REDIS_URL}/srem/${encodeURIComponent(key)}/${encodeURIComponent(member)}`,
        { method: "POST", headers: headers(), signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json() as any;
      return data.result === 1;
    } catch (err: any) {
      console.error(`Redis SREM failed [${key}]:`, err?.message);
      return false;
    }
  },

  async smembers(key: string): Promise<string[]> {
    try {
      const res  = await fetch(
        `${REDIS_URL}/smembers/${encodeURIComponent(key)}`,
        { headers: headers(), signal: AbortSignal.timeout(8000) }
      );
      const data = await res.json() as any;
      return Array.isArray(data.result) ? data.result : [];
    } catch (err: any) {
      console.error(`Redis SMEMBERS failed [${key}]:`, err?.message);
      return [];
    }
  },

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await kiraRedis.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  },

  async setJson(key: string, value: unknown): Promise<boolean> {
    return kiraRedis.set(key, JSON.stringify(value));
  },
};
