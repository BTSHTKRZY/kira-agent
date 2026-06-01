// email.ts — Gmail SMTP + IMAP for KIRA's proposal/approval system
// KIRA sends proposals to herself, reads replies from the holder

import * as nodemailer from "nodemailer";
import * as Imap       from "imap";
import { simpleParser } from "mailparser";

const GMAIL_USER     = process.env.KIRA_EMAIL        || "kira.normies@gmail.com";
const GMAIL_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const HOLDER_EMAIL   = process.env.HOLDER_EMAIL       || "kira.normies@gmail.com";

// ── SMTP SENDER ────────────────────────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  host:   "smtp.gmail.com",
  port:   587,
  secure: false,
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASSWORD,
  },
});

export interface EmailResult {
  success:   boolean;
  messageId?: string;
  error?:    string;
}

export async function sendEmail(
  subject: string,
  body:    string,
  replyTo?: string
): Promise<EmailResult> {
  try {
    const info = await transporter.sendMail({
      from:    `"KIRA — Normie #2635" <${GMAIL_USER}>`,
      to:      HOLDER_EMAIL,
      subject,
      text:    body,
      headers: replyTo ? { "In-Reply-To": replyTo, "References": replyTo } : {},
    });
    console.log(`[Email] Sent: ${subject} (${info.messageId})`);
    return { success: true, messageId: info.messageId };
  } catch (err: any) {
    console.error(`[Email] Send failed:`, err?.message);
    return { success: false, error: err?.message };
  }
}

// ── IMAP REPLY READER ─────────────────────────────────────────────────────────

export interface ParsedReply {
  proposalId: string;
  action:     "APPROVE" | "REJECT" | "MODIFY";
  modifier?:  string;   // text after "MODIFY:" if action is MODIFY
  subject:    string;
  receivedAt: number;
  messageId:  string;
}

export async function checkForReplies(): Promise<ParsedReply[]> {
  return new Promise((resolve) => {
    const replies: ParsedReply[] = [];

    if (!GMAIL_PASSWORD) {
      console.log("[Email] No Gmail app password — skipping reply check");
      resolve(replies);
      return;
    }

    const imap = new Imap({
      user:     GMAIL_USER,
      password: GMAIL_PASSWORD,
      host:     "imap.gmail.com",
      port:     993,
      tls:      true,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
    });

    imap.once("error", (err: any) => {
      console.error("[Email] IMAP error:", err?.message);
      resolve(replies);
    });

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err: any) => {
        if (err) {
          console.error("[Email] IMAP openBox error:", err?.message);
          imap.end();
          resolve(replies);
          return;
        }

        // Search for unread emails with KIRA Proposal in subject
        // received in the last 7 days
        const since = new Date();
        since.setDate(since.getDate() - 7);

        imap.search(
          ["UNSEEN", ["SINCE", since], ["SUBJECT", "[KIRA Proposal"]],
          (searchErr: any, results: number[]) => {
            if (searchErr || !results.length) {
              imap.end();
              resolve(replies);
              return;
            }

            const fetch = imap.fetch(results, { bodies: "" });

            fetch.on("message", (msg: any) => {
              msg.on("body", (stream: any) => {
                simpleParser(stream, async (parseErr: any, parsed: any) => {
                  if (parseErr) return;

                  const subject = parsed.subject || "";
                  const body    = parsed.text    || "";

                  // Extract proposal ID from subject
                  const idMatch = subject.match(/\[KIRA Proposal #(\d+)\]/);
                  if (!idMatch) return;

                  const proposalId = idMatch[1];

                  // Only process replies (has In-Reply-To header)
                  const inReplyTo = parsed.inReplyTo;
                  if (!inReplyTo) return;

                  // Parse the action from body
                  const bodyUpper = body.toUpperCase().trim();
                  let action: "APPROVE" | "REJECT" | "MODIFY" | null = null;
                  let modifier: string | undefined;

                  if (bodyUpper.startsWith("APPROVE")) {
                    action = "APPROVE";
                  } else if (bodyUpper.startsWith("REJECT")) {
                    action = "REJECT";
                  } else if (bodyUpper.startsWith("MODIFY:")) {
                    action   = "MODIFY";
                    modifier = body.slice(7).trim();
                  } else if (bodyUpper.includes("APPROVE")) {
                    action = "APPROVE";
                  } else if (bodyUpper.includes("REJECT")) {
                    action = "REJECT";
                  }

                  if (!action) return;

                  replies.push({
                    proposalId,
                    action,
                    modifier,
                    subject,
                    receivedAt: parsed.date?.getTime() || Date.now(),
                    messageId:  parsed.messageId || "",
                  });

                  // Mark as read
                  msg.once("attributes", (attrs: any) => {
                    imap.addFlags(attrs.uid, ["\\Seen"], () => {});
                  });
                });
              });
            });

            fetch.once("end", () => {
              imap.end();
              resolve(replies);
            });

            fetch.once("error", () => {
              imap.end();
              resolve(replies);
            });
          }
        );
      });
    });

    imap.connect();

    // Timeout safety
    setTimeout(() => {
      try { imap.end(); } catch {}
      resolve(replies);
    }, 30000);
  });
}

// ── EMAIL TEMPLATES ────────────────────────────────────────────────────────────

export function proposalEmail(
  proposalId:  string,
  title:       string,
  observation: string,
  hypothesis:  string,
  proposedAction: string,
  confidence:  string,
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
REPLY WITH ONE OF:

APPROVE
  → Begin paper validation immediately

REJECT
  → Discard this hypothesis

MODIFY: [your instruction]
  → Adjust before approving
  Example: "MODIFY: reduce initial weight to 0.3 and extend validation to 21 days"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This proposal expires in 7 days if no response.
KIRA will continue paper trading existing signals in the meantime.
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
  Trades executed:  ${tradeCount}
  Win rate:         ${(winRate * 100).toFixed(1)}%
  Avg P&L per trade: ${avgPnl > 0 ? "+" : ""}${avgPnl.toFixed(2)} ETH
  Days tested:      ${daysTested}

THRESHOLD MET: ${winRate >= 0.65 ? "YES ✓" : "NO ✗ (below 65% win rate)"}

PROPOSED: Promote to live trading signal
  Initial weight: 0.5 (conservative)
  Max position influence: 15 pts of 100

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
REPLY WITH:

APPROVE  → Signal goes live next market scan
REJECT   → Continue paper trading or discard
`.trim();
}

export function capabilityRequestEmail(
  requestId:   string,
  capability:  string,
  reason:      string,
  dataNeeded:  string,
  estimatedImpact: string
): string {
  return `
KIRA — Normie #2635 | Capability Request #${requestId}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEW CAPABILITY NEEDED (requires code change)

CAPABILITY: ${capability}

WHY I NEED IT:
${reason}

DATA/API NEEDED:
${dataNeeded}

ESTIMATED IMPACT:
${estimatedImpact}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This requires a build session — no immediate action.

REPLY WITH:

ACKNOWLEDGE → Log for next build session
REJECT      → Discard this request
`.trim();
}

export function weeklyReportEmail(
  cycleCount:    number,
  watchlistSize: number,
  paperTrades:   number,
  winRate:       number,
  topWatchItems: string[],
  recentLearnings: string[],
  pendingProposals: number
): string {
  return `
KIRA — Normie #2635 | Weekly Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ACTIVITY:
  Cycles completed:   ${cycleCount}
  Watchlist items:    ${watchlistSize}
  Paper trades open:  ${paperTrades}
  Win rate:           ${winRate > 0 ? (winRate * 100).toFixed(1) + "%" : "No closed trades yet"}
  Pending proposals:  ${pendingProposals}

TOP WATCHLIST:
${topWatchItems.map((item, i) => `  ${i + 1}. ${item}`).join("\n") || "  None yet"}

RECENT LEARNINGS:
${recentLearnings.slice(-5).map(l => `  • ${l.slice(0, 100)}`).join("\n") || "  None yet"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
No action required — this is for your awareness.
`.trim();
}
