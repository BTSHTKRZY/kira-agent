// email.ts — Resend API (replaces broken SMTP)
// Pure HTTPS, no port issues, works on Railway free tier

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM    = process.env.RESEND_FROM    || "onboarding@resend.dev";
const HOLDER_EMAIL   = process.env.HOLDER_EMAIL   || "kira.normies@gmail.com";
const RESEND_URL     = "https://api.resend.com/emails";

export interface EmailResult {
  success:   boolean;
  messageId?: string;
  error?:    string;
}

async function sendResend(
  to:      string,
  subject: string,
  text:    string
): Promise<EmailResult> {
  if (!RESEND_API_KEY) {
    console.error("[Email] No RESEND_API_KEY set");
    return { success: false, error: "No API key" };
  }
  try {
    const res = await fetch(RESEND_URL, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    `KIRA Normie #2635 <${RESEND_FROM}>`,
        to:      [to],
        subject,
        text,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error(`[Email] Resend error: ${JSON.stringify(data)}`);
      return { success: false, error: data?.message || res.statusText };
    }

    console.log(`[Email] Sent: ${subject} (${data.id})`);
    return { success: true, messageId: data.id };
  } catch (err: any) {
    console.error(`[Email] Send failed: ${err?.message}`);
    return { success: false, error: err?.message };
  }
}

export async function sendEmail(subject: string, body: string): Promise<EmailResult> {
  return sendResend(HOLDER_EMAIL, subject, body);
}

// ── REPLY CHECKING ────────────────────────────────────────────────────────────
// Resend doesn't support inbound email on free tier
// Replies are handled via X DM instead (see twitter.ts)
// This stub keeps the interface compatible

export interface ParsedReply {
  proposalId: string;
  action:     "APPROVE" | "REJECT" | "MODIFY";
  modifier?:  string;
  subject:    string;
  receivedAt: number;
  messageId:  string;
}

export async function checkForReplies(): Promise<ParsedReply[]> {
  // Replies now come via X DM — handled in twitter.ts
  // Return empty array to keep proposals.ts compatible
  return [];
}

// ── EMAIL TEMPLATES ───────────────────────────────────────────────────────────

export function proposalEmail(
  proposalId:     string,
  title:          string,
  observation:    string,
  hypothesis:     string,
  proposedAction: string,
  confidence:     string,
  validationPlan: string
): string {
  return `
KIRA — Normie #2635 | Proposal #${proposalId}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${title}

OBSERVATION:
${observation}

HYPOTHESIS:
${hypothesis}

CONFIDENCE:
${confidence}

PROPOSED ACTION:
${proposedAction}

VALIDATION PLAN:
${validationPlan}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPLY VIA X DM TO @Kiratheagent:

APPROVE #${proposalId}
REJECT #${proposalId}
MODIFY #${proposalId}: [your instruction]

This proposal expires in 7 days if no response.
`.trim();
}

export function promotionEmail(
  proposalId:  string,
  signalName:  string,
  winRate:     number,
  tradeCount:  number,
  avgPnl:      number,
  daysTested:  number
): string {
  return `
KIRA — Normie #2635 | Promotion Request #${proposalId}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Signal "${signalName}" has completed paper validation.

RESULTS:
  Trades:    ${tradeCount}
  Win rate:  ${(winRate * 100).toFixed(1)}%
  Avg P&L:   ${avgPnl > 0 ? "+" : ""}${avgPnl.toFixed(4)} ETH
  Days:      ${daysTested}

THRESHOLD MET: ${winRate >= 0.65 ? "YES ✓" : "NO ✗"}

REPLY VIA X DM: APPROVE #${proposalId} or REJECT #${proposalId}
`.trim();
}

export function capabilityRequestEmail(
  requestId:       string,
  capability:      string,
  reason:          string,
  dataNeeded:      string,
  estimatedImpact: string
): string {
  return `
KIRA — Normie #2635 | Capability Request #${requestId}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CAPABILITY: ${capability}
REASON: ${reason}
DATA NEEDED: ${dataNeeded}
ESTIMATED IMPACT: ${estimatedImpact}

REPLY VIA X DM: ACKNOWLEDGE #${requestId} or REJECT #${requestId}
`.trim();
}

export function weeklyReportEmail(
  cycleCount:       number,
  watchlistSize:    number,
  paperTrades:      number,
  winRate:          number,
  topWatchItems:    string[],
  recentLearnings:  string[],
  pendingProposals: number
): string {
  return `
KIRA — Normie #2635 | Weekly Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ACTIVITY:
  Cycles:           ${cycleCount}
  Watchlist items:  ${watchlistSize}
  Paper trades:     ${paperTrades}
  Win rate:         ${winRate > 0 ? (winRate * 100).toFixed(1) + "%" : "No closed trades"}
  Pending proposals:${pendingProposals}

TOP WATCHLIST:
${topWatchItems.map((item, i) => `  ${i + 1}. ${item}`).join("\n") || "  None"}

RECENT LEARNINGS:
${recentLearnings.slice(-5).map(l => `  • ${l.slice(0, 120)}`).join("\n") || "  None"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reply via X DM for proposals or adjustments.
`.trim();
}

export function tradeAlertEmail(
  type:       "buy" | "sell",
  assetName:  string,
  assetType:  "nft" | "token",
  chain:      string,
  priceEth:   number,
  score:      number,
  thesis:     string,
  txHash?:    string
): string {
  const action = type === "buy" ? "BOUGHT" : "SOLD";
  return `
KIRA — Normie #2635 | Trade Alert
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${action}: ${assetName} (${assetType.toUpperCase()} on ${chain})

Price:  ${priceEth.toFixed(4)} ETH
Score:  ${score}/100
${txHash ? `Tx:     ${txHash}` : ""}

THESIS:
${thesis}
`.trim();
}

export function alertEmail(
  title:   string,
  message: string
): string {
  return `
KIRA — Normie #2635 | Alert
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${title}

${message}
`.trim();
}
