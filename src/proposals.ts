// proposals.ts — KIRA's proposal lifecycle system
// Generates proposals, tracks them in Redis, parses email replies, manages validation

import { kiraRedis }       from "./redis.js";
import { ParsedReply, sendEmail, proposalEmail, promotionEmail, capabilityRequestEmail } from "./email.js";

// ── TYPES ──────────────────────────────────────────────────────────────────────

export type ProposalType   = "signal" | "weight_adjustment" | "macro_factor" | "capability_request";
export type ProposalStatus = "pending" | "approved" | "rejected" | "paper_validating" | "ready_for_promotion" | "live" | "expired";

export interface Proposal {
  id:              string;
  type:            ProposalType;
  status:          ProposalStatus;
  title:           string;
  observation:     string;
  hypothesis:      string;
  proposedAction:  string;
  confidence:      string;
  validationPlan:  string;

  // Signal details (if type === "signal")
  signalName?:     string;
  signalLogic?:    string;       // natural language description Claude interprets
  initialWeight?:  number;
  validationDays?: number;
  minTrades?:      number;

  // Validation tracking
  paperTradeIds?:  string[];
  paperWins?:      number;
  paperLosses?:    number;
  paperAvgPnl?:    number;
  validationStart?: number;

  // Macro factor (if type === "macro_factor")
  macroEvent?:     string;
  weightAdjustments?: Record<string, number>;

  createdAt:       number;
  updatedAt:       number;
  expiresAt:       number;
  approvedAt?:     number;
  rejectedAt?:     number;
  promotedAt?:     number;
  modifier?:       string;       // holder's modification instruction
}

// Redis keys
const K = {
  proposal:  (id: string) => `kira:proposal:${id}`,
  proposals: ()            => `kira:proposals`,
  pending:   ()            => `kira:proposals:pending`,
  active:    ()            => `kira:proposals:active`,
  counter:   ()            => `kira:proposal:counter`,
  live:      ()            => `kira:proposals:live`,
};

const VALIDATION_WIN_RATE   = 0.65;
const VALIDATION_MIN_TRADES = 10;
const PROPOSAL_EXPIRY_DAYS  = 7;

// ── PROPOSAL MANAGER ───────────────────────────────────────────────────────────

export class KiraProposals {

  // ── ID GENERATION ────────────────────────────────────────────────────────────

  private async nextId(): Promise<string> {
    const current = await kiraRedis.get(K.counter());
    const next    = parseInt(current || "0") + 1;
    await kiraRedis.set(K.counter(), String(next));
    return String(next).padStart(3, "0");
  }

  // ── CREATE PROPOSAL ──────────────────────────────────────────────────────────

  async createSignalProposal(
    title:        string,
    observation:  string,
    hypothesis:   string,
    signalName:   string,
    signalLogic:  string,
    confidence:   string,
    initialWeight: number = 0.5,
    validationDays: number = 14
  ): Promise<Proposal> {
    const id = await this.nextId();

    const proposal: Proposal = {
      id,
      type:           "signal",
      status:         "pending",
      title,
      observation,
      hypothesis,
      proposedAction: `Add signal "${signalName}" to scoring engine with initial weight ${initialWeight}`,
      confidence,
      validationPlan: `Paper trade for ${validationDays} days or ${VALIDATION_MIN_TRADES} trades minimum. Promote if win rate ≥ ${VALIDATION_WIN_RATE * 100}%.`,
      signalName,
      signalLogic,
      initialWeight,
      validationDays,
      minTrades:      VALIDATION_MIN_TRADES,
      paperTradeIds:  [],
      paperWins:      0,
      paperLosses:    0,
      paperAvgPnl:    0,
      createdAt:      Date.now(),
      updatedAt:      Date.now(),
      expiresAt:      Date.now() + PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    };

    await this.save(proposal);
    await kiraRedis.sadd(K.proposals(), id);
    await kiraRedis.sadd(K.pending(), id);

    // Send email
    const body = proposalEmail(
      id, title, observation, hypothesis,
      proposal.proposedAction, confidence, proposal.validationPlan
    );
    await sendEmail(`[KIRA Proposal #${id}] ${title}`, body);

    console.log(`[Proposals] Created proposal #${id}: ${title}`);
    return proposal;
  }

  async createMacroProposal(
    title:        string,
    observation:  string,
    macroEvent:   string,
    weightAdjustments: Record<string, number>,
    confidence:   string
  ): Promise<Proposal> {
    const id = await this.nextId();

    const adjustmentText = Object.entries(weightAdjustments)
      .map(([signal, delta]) => `${signal}: ${delta > 0 ? "+" : ""}${delta}`)
      .join(", ");

    const proposal: Proposal = {
      id,
      type:            "macro_factor",
      status:          "pending",
      title,
      observation,
      hypothesis:      `${macroEvent} historically correlates with crypto price movements. Adjusting weights to reflect this.`,
      proposedAction:  `Temporarily adjust signal weights: ${adjustmentText}`,
      confidence,
      validationPlan:  "Apply immediately if approved. Monitor over next 30 days and revert if outcomes worsen.",
      macroEvent,
      weightAdjustments,
      createdAt:       Date.now(),
      updatedAt:       Date.now(),
      expiresAt:       Date.now() + PROPOSAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    };

    await this.save(proposal);
    await kiraRedis.sadd(K.proposals(), id);
    await kiraRedis.sadd(K.pending(), id);

    const body = proposalEmail(
      id, title, observation, proposal.hypothesis,
      proposal.proposedAction, confidence, proposal.validationPlan
    );
    await sendEmail(`[KIRA Proposal #${id}] ${title}`, body);

    console.log(`[Proposals] Created macro proposal #${id}: ${title}`);
    return proposal;
  }

  async createCapabilityRequest(
    capability:       string,
    reason:           string,
    dataNeeded:       string,
    estimatedImpact:  string
  ): Promise<Proposal> {
    const id = await this.nextId();

    const proposal: Proposal = {
      id,
      type:           "capability_request",
      status:         "pending",
      title:          capability,
      observation:    reason,
      hypothesis:     `Adding ${capability} would improve trading intelligence.`,
      proposedAction: `Integrate ${dataNeeded}`,
      confidence:     "N/A — requires human implementation",
      validationPlan: "After implementation, paper trade for 14 days before live use.",
      createdAt:      Date.now(),
      updatedAt:      Date.now(),
      expiresAt:      Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
    };

    await this.save(proposal);
    await kiraRedis.sadd(K.proposals(), id);
    await kiraRedis.sadd(K.pending(), id);

    const body = capabilityRequestEmail(id, capability, reason, dataNeeded, estimatedImpact);
    await sendEmail(`[KIRA Proposal #${id}] Capability Request: ${capability}`, body);

    console.log(`[Proposals] Capability request #${id}: ${capability}`);
    return proposal;
  }

  // ── PROCESS REPLIES ──────────────────────────────────────────────────────────

  async processReplies(replies: ParsedReply[]): Promise<void> {
    for (const reply of replies) {
      const proposal = await this.getById(reply.proposalId);
      if (!proposal) {
        console.log(`[Proposals] No proposal found for ID #${reply.proposalId}`);
        continue;
      }

      if (proposal.status !== "pending") {
        console.log(`[Proposals] Proposal #${reply.proposalId} already processed (${proposal.status})`);
        continue;
      }

      switch (reply.action) {
        case "APPROVE":
          await this.approve(proposal);
          break;

        case "REJECT":
          await this.reject(proposal);
          break;

        case "MODIFY":
          await this.modify(proposal, reply.modifier || "");
          break;
      }
    }
  }

  private async approve(proposal: Proposal): Promise<void> {
    if (proposal.type === "capability_request") {
      proposal.status     = "approved";
      proposal.approvedAt = Date.now();
      proposal.updatedAt  = Date.now();
      await this.save(proposal);
      await kiraRedis.srem(K.pending(), proposal.id);
      console.log(`[Proposals] Capability request #${proposal.id} acknowledged`);
      return;
    }

    // Signal or macro — start paper validation
    proposal.status          = "paper_validating";
    proposal.approvedAt      = Date.now();
    proposal.validationStart = Date.now();
    proposal.updatedAt       = Date.now();

    await this.save(proposal);
    await kiraRedis.srem(K.pending(), proposal.id);
    await kiraRedis.sadd(K.active(), proposal.id);

    console.log(`[Proposals] Approved #${proposal.id} — beginning paper validation`);
  }

  private async reject(proposal: Proposal): Promise<void> {
    proposal.status     = "rejected";
    proposal.rejectedAt = Date.now();
    proposal.updatedAt  = Date.now();

    await this.save(proposal);
    await kiraRedis.srem(K.pending(), proposal.id);

    console.log(`[Proposals] Rejected #${proposal.id}`);
  }

  private async modify(proposal: Proposal, modifier: string): Promise<void> {
    // Store modifier and re-send for approval with modification noted
    proposal.modifier  = modifier;
    proposal.updatedAt = Date.now();
    await this.save(proposal);

    // Re-send email with modification applied
    const modifiedBody = proposalEmail(
      proposal.id,
      `[MODIFIED] ${proposal.title}`,
      proposal.observation,
      `${proposal.hypothesis}\n\nHOLDER MODIFICATION: ${modifier}`,
      proposal.proposedAction,
      proposal.confidence,
      proposal.validationPlan
    ) + `\n\nNote: This is a modified version. Reply APPROVE to confirm or REJECT to discard.`;

    await sendEmail(
      `[KIRA Proposal #${proposal.id}] ${proposal.title} — Modified`,
      modifiedBody
    );

    console.log(`[Proposals] Modified #${proposal.id}: ${modifier.slice(0, 80)}`);
  }

  // ── VALIDATION TRACKING ──────────────────────────────────────────────────────

  async recordPaperResult(
    proposalId: string,
    tradeId:    string,
    won:        boolean,
    pnlEth:     number
  ): Promise<void> {
    const proposal = await this.getById(proposalId);
    if (!proposal || proposal.status !== "paper_validating") return;

    proposal.paperTradeIds = [...(proposal.paperTradeIds || []), tradeId];
    proposal.paperWins     = (proposal.paperWins || 0) + (won ? 1 : 0);
    proposal.paperLosses   = (proposal.paperLosses || 0) + (won ? 0 : 1);

    const totalTrades = proposal.paperWins + proposal.paperLosses;
    const totalPnl    = (proposal.paperAvgPnl || 0) * (totalTrades - 1) + pnlEth;
    proposal.paperAvgPnl = totalPnl / totalTrades;
    proposal.updatedAt   = Date.now();

    await this.save(proposal);

    // Check if validation criteria met
    await this.checkPromotion(proposal);
  }

  private async checkPromotion(proposal: Proposal): Promise<void> {
    const trades    = (proposal.paperWins || 0) + (proposal.paperLosses || 0);
    const winRate   = trades > 0 ? (proposal.paperWins || 0) / trades : 0;
    const daysTested = proposal.validationStart
      ? (Date.now() - proposal.validationStart) / (1000 * 3600 * 24)
      : 0;

    const meetsTradeCount = trades >= (proposal.minTrades || VALIDATION_MIN_TRADES);
    const meetsWinRate    = winRate >= VALIDATION_WIN_RATE;
    const meetsDays       = daysTested >= (proposal.validationDays || 14);

    if ((meetsTradeCount && meetsWinRate) || (meetsDays && meetsWinRate)) {
      proposal.status    = "ready_for_promotion";
      proposal.updatedAt = Date.now();
      await this.save(proposal);
      await kiraRedis.srem(K.active(), proposal.id);

      // Send promotion email
      const body = promotionEmail(
        proposal.id,
        proposal.signalName || proposal.title,
        winRate,
        trades,
        proposal.paperAvgPnl || 0,
        Math.round(daysTested)
      );
      await sendEmail(
        `[KIRA Proposal #${proposal.id}] Ready for Promotion: ${proposal.signalName || proposal.title}`,
        body
      );

      console.log(`[Proposals] #${proposal.id} ready for promotion — win rate: ${(winRate * 100).toFixed(1)}%`);
    }
  }

  async promoteToLive(proposalId: string): Promise<void> {
    const proposal = await this.getById(proposalId);
    if (!proposal || proposal.status !== "ready_for_promotion") return;

    proposal.status      = "live";
    proposal.promotedAt  = Date.now();
    proposal.updatedAt   = Date.now();

    await this.save(proposal);
    await kiraRedis.sadd(K.live(), proposal.id);

    console.log(`[Proposals] #${proposalId} promoted to live!`);
  }

  // ── EXPIRY ───────────────────────────────────────────────────────────────────

  async expireStale(): Promise<void> {
    const ids = await kiraRedis.smembers(K.pending());
    for (const id of ids) {
      const proposal = await this.getById(id);
      if (!proposal) continue;
      if (Date.now() > proposal.expiresAt && proposal.status === "pending") {
        proposal.status    = "expired";
        proposal.updatedAt = Date.now();
        await this.save(proposal);
        await kiraRedis.srem(K.pending(), id);
        console.log(`[Proposals] Expired proposal #${id}`);
      }
    }
  }

  // ── GETTERS ──────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Proposal | null> {
    return kiraRedis.getJson<Proposal>(K.proposal(id));
  }

  async getPending(): Promise<Proposal[]> {
    const ids = await kiraRedis.smembers(K.pending());
    const proposals = await Promise.all(ids.map(id => this.getById(id)));
    return proposals.filter(Boolean) as Proposal[];
  }

  async getActive(): Promise<Proposal[]> {
    const ids = await kiraRedis.smembers(K.active());
    const proposals = await Promise.all(ids.map(id => this.getById(id)));
    return proposals.filter(Boolean) as Proposal[];
  }

  async getLive(): Promise<Proposal[]> {
    const ids = await kiraRedis.smembers(K.live());
    const proposals = await Promise.all(ids.map(id => this.getById(id)));
    return proposals.filter(Boolean) as Proposal[];
  }

  async hasPendingProposal(signalName: string): Promise<boolean> {
    const pending = await this.getPending();
    return pending.some(p => p.signalName === signalName);
  }

  // ── LIVE SIGNAL READER ───────────────────────────────────────────────────────

  // Returns all live approved signals for scoring engine to use
  async getLiveSignals(): Promise<Array<{
    name:   string;
    logic:  string;
    weight: number;
  }>> {
    const live = await this.getLive();
    return live
      .filter(p => p.type === "signal" && p.signalName && p.signalLogic)
      .map(p => ({
        name:   p.signalName!,
        logic:  p.signalLogic!,
        weight: p.initialWeight || 0.5,
      }));
  }

  // Returns active macro adjustments
  async getActiveMacroAdjustments(): Promise<Record<string, number>> {
    const live = await this.getLive();
    const adjustments: Record<string, number> = {};

    for (const p of live) {
      if (p.type === "macro_factor" && p.weightAdjustments) {
        for (const [signal, delta] of Object.entries(p.weightAdjustments)) {
          adjustments[signal] = (adjustments[signal] || 0) + delta;
        }
      }
    }

    return adjustments;
  }

  private async save(proposal: Proposal): Promise<void> {
    await kiraRedis.setJson(K.proposal(proposal.id), proposal);
  }

  async formatSummaryForContext(): Promise<string> {
    const pending = await this.getPending();
    const active  = await this.getActive();
    const live    = await this.getLive();

    return [
      `Proposals: ${pending.length} pending, ${active.length} in validation, ${live.length} live`,
      live.length > 0
        ? `Live signals: ${live.map(p => p.signalName || p.title).join(", ")}`
        : "",
    ].filter(Boolean).join(" | ");
  }
}
