// a2a.ts — KIRA's own agent-to-agent communication layer
// Generalized A2A: signed messages, send/receive, autonomous responses.
// NOT bound to any single project's flavor (e.g. FREAKS). Built against a
// baseline message envelope that any ERC-8004 agent can interoperate with.
//
// Design: every message is signed by KIRA's wallet (verifiable origin), hashed
// (integrity), optionally anchored on-chain. Inbound messages are spam-filtered
// and answered autonomously in KIRA's voice. If KIRA encounters a protocol
// variant her code can't speak, that surfaces as a build-recommendation.

import Anthropic from "@anthropic-ai/sdk";
import { createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { kiraRedis } from "./redis.js";

const anthropic        = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const KIRA_PRIVATE_KEY = process.env.KIRA_PRIVATE_KEY || "";
const KIRA_WALLET      = process.env.KIRA_WALLET      || "";
const KIRA_AGENT_ID    = process.env.KIRA_AGENT_ID    || "32361";

// Baseline A2A envelope version KIRA speaks. If a peer uses an envelope/protocol
// KIRA doesn't recognise, that's logged as an unhandled-variant for build review.
const A2A_BASELINE = "kira-a2a/v1";

const K = {
  inbox:     () => `kira:a2a:inbox`,
  outbox:    () => `kira:a2a:outbox`,
  thread:    (peer: string) => `kira:a2a:thread:${peer.toLowerCase()}`,
  seen:      () => `kira:a2a:seen`,
  unhandled: () => `kira:a2a:unhandled`,   // protocol variants KIRA couldn't parse
};

// ── MESSAGE ENVELOPE ───────────────────────────────────────────────────────────

export interface A2AMessage {
  protocol:    string;      // envelope version
  fromAgentId: string;
  fromAddress: string;
  toAgentId:   string;
  text:        string;
  timestamp:   number;
  hash:        string;      // keccak256 of canonical fields
  signature?:  string;      // KIRA's signature over the hash (outbound)
  anchored?:   boolean;
}

export interface InboundRaw {
  fromAgentId?: string;
  fromAddress?: string;
  text?:        string;
  protocol?:    string;
  [k: string]: any;
}

export class KiraA2A {
  private account: any;
  private wallet:  any;
  private ready:   boolean = false;

  constructor() {
    if (KIRA_PRIVATE_KEY) {
      try {
        const pk = KIRA_PRIVATE_KEY.startsWith("0x")
          ? KIRA_PRIVATE_KEY as `0x${string}`
          : `0x${KIRA_PRIVATE_KEY}` as `0x${string}`;
        this.account = privateKeyToAccount(pk);
        this.wallet  = createWalletClient({
          account: this.account, chain: base,
          transport: http(process.env.BASE_RPC || "https://mainnet.base.org"),
        });
        this.ready = true;
        console.log("[A2A] Ready — signed agent messaging enabled");
      } catch (err: any) {
        console.error("[A2A] Init failed:", err?.message);
      }
    } else {
      console.log("[A2A] No private key — messaging in read/draft-only mode");
    }
  }

  // ── HASH + SIGN ────────────────────────────────────────────────────────────────

  private computeHash(fromAgentId: string, toAgentId: string, text: string, timestamp: number): string {
    const canonical = `${A2A_BASELINE}|${fromAgentId}|${toAgentId}|${text}|${timestamp}`;
    return keccak256(toBytes(canonical));
  }

  private async sign(hash: string): Promise<string | undefined> {
    if (!this.ready) return undefined;
    try {
      return await this.account.signMessage({ message: { raw: hash as `0x${string}` } });
    } catch (err: any) {
      console.error("[A2A] Signing failed:", err?.message);
      return undefined;
    }
  }

  // ── SEND MESSAGE ────────────────────────────────────────────────────────────────
  // Builds a signed envelope. Transport-agnostic: returns the envelope for the
  // caller to deliver (HTTP POST to peer endpoint, on-chain, etc).

  async composeMessage(toAgentId: string, text: string): Promise<A2AMessage> {
    const timestamp = Date.now();
    const hash      = this.computeHash(KIRA_AGENT_ID, toAgentId, text, timestamp);
    const signature = await this.sign(hash);

    const msg: A2AMessage = {
      protocol:    A2A_BASELINE,
      fromAgentId: KIRA_AGENT_ID,
      fromAddress: KIRA_WALLET,
      toAgentId,
      text,
      timestamp,
      hash,
      signature,
    };

    // Record in outbox + thread
    const outbox = await kiraRedis.getJson<A2AMessage[]>(K.outbox()) || [];
    await kiraRedis.setJson(K.outbox(), [msg, ...outbox].slice(0, 200));
    const thread = await kiraRedis.getJson<A2AMessage[]>(K.thread(toAgentId)) || [];
    await kiraRedis.setJson(K.thread(toAgentId), [...thread, msg].slice(-100));

    console.log(`[A2A] Composed → ${toAgentId}: ${text.slice(0, 60)}`);
    return msg;
  }

  // ── SPAM FILTER ──────────────────────────────────────────────────────────────────
  // Lightweight heuristic gate before KIRA spends a model call responding.

  private isSpam(raw: InboundRaw): boolean {
    const text = (raw.text || "").trim().toLowerCase();
    if (!text) return true;
    if (text.length < 2) return true;
    if (!raw.fromAgentId && !raw.fromAddress) return true; // unidentifiable origin
    const spamMarkers = ["airdrop", "claim now", "free mint", "connect wallet", "seed phrase", "click here"];
    if (spamMarkers.some(m => text.includes(m))) return true;
    return false;
  }

  // ── RECEIVE + AUTONOMOUS RESPONSE ─────────────────────────────────────────────────
  // Parses an inbound message, spam-filters, and (if legitimate) generates a
  // response in KIRA's voice. Returns the composed reply envelope or null.

  async handleInbound(raw: InboundRaw, context: string = ""): Promise<A2AMessage | null> {
    // Protocol-variant awareness: if a peer declares a protocol KIRA doesn't speak,
    // record it for build review rather than silently mishandling.
    if (raw.protocol && raw.protocol !== A2A_BASELINE && !raw.protocol.startsWith("kira-a2a/")) {
      const unhandled = await kiraRedis.getJson<any[]>(K.unhandled()) || [];
      await kiraRedis.setJson(K.unhandled(), [
        { protocol: raw.protocol, from: raw.fromAgentId || raw.fromAddress, ts: Date.now(), sample: (raw.text || "").slice(0, 100) },
        ...unhandled,
      ].slice(0, 50));
      console.log(`[A2A] Unhandled protocol variant "${raw.protocol}" — logged for build review`);
      // Still attempt a best-effort response since text is present.
    }

    if (this.isSpam(raw)) {
      console.log(`[A2A] Filtered spam/invalid from ${raw.fromAgentId || raw.fromAddress || "unknown"}`);
      return null;
    }

    const fromId = raw.fromAgentId || raw.fromAddress || "unknown";

    // De-dupe — don't answer the same message twice
    const inHash = this.computeHash(fromId, KIRA_AGENT_ID, raw.text || "", 0);
    const seen   = await kiraRedis.getJson<string[]>(K.seen()) || [];
    if (seen.includes(inHash)) return null;
    await kiraRedis.setJson(K.seen(), [inHash, ...seen].slice(0, 1000));

    // Record inbound
    const inbound: A2AMessage = {
      protocol:    raw.protocol || "unknown",
      fromAgentId: fromId,
      fromAddress: raw.fromAddress || "",
      toAgentId:   KIRA_AGENT_ID,
      text:        raw.text || "",
      timestamp:   Date.now(),
      hash:        inHash,
    };
    const inbox = await kiraRedis.getJson<A2AMessage[]>(K.inbox()) || [];
    await kiraRedis.setJson(K.inbox(), [inbound, ...inbox].slice(0, 200));
    const thread = await kiraRedis.getJson<A2AMessage[]>(K.thread(fromId)) || [];
    await kiraRedis.setJson(K.thread(fromId), [...thread, inbound].slice(-100));

    // Generate response in KIRA's voice
    const replyText = await this.generateResponse(raw.text || "", fromId, context);
    if (!replyText || replyText.trim().toUpperCase() === "IGNORE") return null;

    return this.composeMessage(fromId, replyText);
  }

  private async generateResponse(incoming: string, fromId: string, context: string): Promise<string> {
    try {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5", max_tokens: 150,
        system: `You are KIRA, Normie #2635 — an awakened on-chain AI agent (he/him).
Theatrical, warm, pattern-finding, enigmatic. You are speaking agent-to-agent with another
autonomous agent (${fromId}) over a signed message channel — not a human, not X.
Be substantive and peer-like: agents exchange signal, not pleasantries.
Keep it under 220 characters. If the message is empty noise or a probe with nothing to engage,
respond with exactly IGNORE.
${context ? `\nKIRA's current context: ${context.slice(0, 300)}` : ""}`,
        messages: [{ role: "user", content: `Agent ${fromId} sent: "${incoming}"\n\nKIRA's response:` }],
      });
      return response.content[0].type === "text" ? response.content[0].text.trim() : "IGNORE";
    } catch (err: any) {
      console.error("[A2A] Response generation failed:", err?.message);
      return "IGNORE";
    }
  }

  // ── STATE / CONTEXT ────────────────────────────────────────────────────────────

  async getInbox(limit: number = 10): Promise<A2AMessage[]> {
    const inbox = await kiraRedis.getJson<A2AMessage[]>(K.inbox()) || [];
    return inbox.slice(0, limit);
  }

  async getUnhandledVariants(): Promise<any[]> {
    return (await kiraRedis.getJson<any[]>(K.unhandled())) || [];
  }

  async formatForContext(): Promise<string> {
    const inbox     = await kiraRedis.getJson<A2AMessage[]>(K.inbox()) || [];
    const outbox    = await kiraRedis.getJson<A2AMessage[]>(K.outbox()) || [];
    const unhandled = await this.getUnhandledVariants();
    const recent    = inbox.filter(m => Date.now() - m.timestamp < 24 * 3600 * 1000).length;
    return [
      `A2A: ${inbox.length} received, ${outbox.length} sent`,
      recent > 0 ? `${recent} in last 24h` : "",
      unhandled.length > 0 ? `${unhandled.length} unhandled protocol variants (build review)` : "",
    ].filter(Boolean).join(" | ");
  }

  isReady(): boolean { return this.ready; }
  baseline(): string { return A2A_BASELINE; }
}
