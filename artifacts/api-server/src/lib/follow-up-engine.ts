import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  opportunitiesTable,
  opportunityFollowUpsTable,
  salesAssistantSettingsTable,
  salesAuditEventsTable,
  chatsTable,
  chatMessagesTable,
  channelsTable,
  type OpportunityRow,
} from "@workspace/db";
import { ownerHasSalesAssistant } from "./sales-assistant";
import { getOrCreateTenantSettings } from "./settings-store";
import { generateFollowUpMessage } from "./follow-up-message";
import {
  decideFollowUp,
  type FollowUpDecision,
} from "./follow-up-decision-build";
import { lastMeaningfulInteractionAt } from "./last-meaningful-interaction";
import { sendFollowUpOnChannel } from "../routes/whatsapp";
import { logger } from "./logger";

// ===========================================================================
// AI Sales Assistant — Auto Follow-Up engine (DB layer + scheduler).
//
// Periodically sweeps every entitled tenant's OPEN, "waiting_customer"
// opportunities and decides — via the pure decideFollowUp state machine — whether
// the next sequenced follow-up touch (max 3) is due. The pure module owns ALL
// the no-send rules + timing; this module only gathers inputs, performs side
// effects, and audits.
//
// Two behaviours, gated on the tenant's autoFollowUpEnabled toggle:
//   • ON  → generate a personalized message, SEND it on the chat's OWN channel
//           (WhatsApp only, with outbound pacing), persist a `sent` follow-up row,
//           audit `follow_up_sent`.
//   • OFF → store a RECOMMENDATION only: a `pending` follow-up row with no message
//           (no AI/token spend), audited `follow_up_recommended`, so the human can
//           see the deal is due and act manually. Never sends.
//
// Idempotency: the (opportunity_id, sequence) unique index means each touch is
// claimed at most once; a concurrent/duplicate sweep no-ops on conflict. Customer
// replies are handled implicitly — detection flips waitingStatus away from
// "waiting_customer", so decideFollowUp returns not_waiting_customer and any stale
// `pending` recommendation is cancelled here.
// ===========================================================================

// Trailing messages scanned to derive the last meaningful interaction + detect
// an explicit stop request.
const HISTORY_LIMIT = 20;

const DEFAULT_AUTO_FOLLOW_UP_ENABLED = false;
const DEFAULT_FOLLOW_UP_INTERVAL_HOURS = 48;

// Phrases that signal the customer wants no more contact. Matched against the
// normalized inbound text. Conservative: a false negative just means one more
// (gentle, capped) touch; a false positive would suppress legitimate sales.
const STOP_PATTERNS = [
  "stop",
  "berhenti",
  "unsubscribe",
  "jangan hubungi",
  "jangan dihubungi",
  "jangan kirim",
  "tidak berminat",
  "gak minat",
  "ga minat",
  "nggak minat",
  "block",
  "blokir",
];

function detectStopRequest(
  inbound: ReadonlyArray<{ content: string }>
): boolean {
  for (const m of inbound) {
    const t = m.content.toLowerCase();
    if (STOP_PATTERNS.some((p) => t.includes(p))) return true;
  }
  return false;
}

export type FollowUpSweepResult = {
  scannedOwners: number;
  scannedOpportunities: number;
  sent: number;
  recommended: number;
  cancelled: number;
};

type Settings = { enabled: boolean; intervalHours: number };

async function getFollowUpSettings(ownerUserId: number): Promise<Settings> {
  const [row] = await db
    .select()
    .from(salesAssistantSettingsTable)
    .where(eq(salesAssistantSettingsTable.ownerUserId, ownerUserId))
    .limit(1);
  return {
    enabled: row?.autoFollowUpEnabled ?? DEFAULT_AUTO_FOLLOW_UP_ENABLED,
    intervalHours:
      row?.followUpIntervalHours ?? DEFAULT_FOLLOW_UP_INTERVAL_HOURS,
  };
}

// Cancel any still-`pending` recommendation touches for an opportunity. Called
// when the deal is no longer due (e.g. the customer replied, the deal closed),
// so a stale "follow-up disarankan" never lingers in the UI.
async function cancelPendingRecommendations(
  opportunityId: number
): Promise<number> {
  const cancelled = await db
    .update(opportunityFollowUpsTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(opportunityFollowUpsTable.opportunityId, opportunityId),
        eq(opportunityFollowUpsTable.status, "pending")
      )
    )
    .returning({ id: opportunityFollowUpsTable.id });
  return cancelled.length;
}

// Gather the timing/lifecycle inputs for one opportunity and run the pure
// decision. Returns the decision plus the resolved sentCount so the caller can
// claim the right sequence.
async function decideForOpportunity(
  opp: OpportunityRow,
  settings: Settings,
  now: Date
): Promise<{ decision: FollowUpDecision; stopRequested: boolean }> {
  // Delivered follow-ups so far (only `sent` count toward the cap; the latest
  // sent timestamp anchors the next touch's spacing).
  const sentRows = await db
    .select({
      scheduledAt: opportunityFollowUpsTable.scheduledAt,
      sentAt: opportunityFollowUpsTable.sentAt,
    })
    .from(opportunityFollowUpsTable)
    .where(
      and(
        eq(opportunityFollowUpsTable.opportunityId, opp.id),
        eq(opportunityFollowUpsTable.status, "sent")
      )
    );
  const sentCount = sentRows.length;
  let lastFollowUpAt: Date | null = null;
  for (const r of sentRows) {
    const ts = r.sentAt ?? r.scheduledAt;
    if (ts && (lastFollowUpAt === null || ts.getTime() > lastFollowUpAt.getTime())) {
      lastFollowUpAt = ts;
    }
  }

  // Recent transcript → last meaningful interaction (skips filler) + stop-word
  // scan over inbound messages only.
  const recent = await db
    .select({
      direction: chatMessagesTable.direction,
      content: chatMessagesTable.content,
      createdAt: chatMessagesTable.createdAt,
    })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatId, opp.chatId))
    .orderBy(desc(chatMessagesTable.id))
    .limit(HISTORY_LIMIT);
  const lastMeaningfulAt = lastMeaningfulInteractionAt(
    recent.map((m) => ({ at: m.createdAt, content: m.content }))
  );
  const stopRequested = detectStopRequest(
    recent.filter((m) => m.direction === "inbound")
  );

  const decision = decideFollowUp({
    status: opp.status,
    waitingStatus: opp.waitingStatus,
    sentCount,
    stopRequested,
    hasOpenTask: false,
    lastMeaningfulAt,
    lastFollowUpAt,
    intervalHours: settings.intervalHours,
    now,
  });
  return { decision, stopRequested };
}

// Process a single owner's candidate opportunities.
async function processOwner(
  ownerUserId: number,
  opportunities: OpportunityRow[],
  now: Date
): Promise<{ sent: number; recommended: number; cancelled: number }> {
  const settings = await getFollowUpSettings(ownerUserId);
  let sent = 0;
  let recommended = 0;
  let cancelled = 0;

  for (const opp of opportunities) {
    try {
      const { decision } = await decideForOpportunity(opp, settings, now);

      if (!decision.due) {
        // Any non-due state (customer replied, closed, capped, stop) clears a
        // lingering recommendation so the UI doesn't keep nagging.
        cancelled += await cancelPendingRecommendations(opp.id);
        continue;
      }

      if (!settings.enabled) {
        // Recommend-only: claim the sequence as a `pending` row (no AI spend).
        const inserted = await db
          .insert(opportunityFollowUpsTable)
          .values({
            opportunityId: opp.id,
            ownerUserId,
            sequence: decision.nextSequence,
            scheduledAt: decision.dueAt,
            status: "pending",
            generatedMessage: null,
          })
          .onConflictDoNothing({
            target: [
              opportunityFollowUpsTable.opportunityId,
              opportunityFollowUpsTable.sequence,
            ],
          })
          .returning({ id: opportunityFollowUpsTable.id });
        if (inserted.length > 0) {
          recommended++;
          await db.insert(salesAuditEventsTable).values({
            ownerUserId,
            opportunityId: opp.id,
            actorUserId: null,
            eventType: "follow_up_recommended",
            detail: {
              sequence: decision.nextSequence,
              dueAt: decision.dueAt.toISOString(),
            },
          });
        }
        continue;
      }

      // Auto-send path. Only WhatsApp channels send; other kinds (Telegram)
      // are skipped per the approved scope (recommendation still applies via
      // the cancel/skip below would be wrong — instead leave for manual).
      const [channel] = await db
        .select({ kind: channelsTable.kind })
        .from(channelsTable)
        .where(eq(channelsTable.id, opp.channelId))
        .limit(1);
      if (!channel || channel.kind !== "whatsapp") continue;

      const draft = await generateFollowUpMessage({
        opportunity: opp,
        sequence: decision.nextSequence,
      });
      if (!draft) continue; // generation failed → retry next sweep.

      // Claim the sequence FIRST (unique guard) so a concurrent sweep can't
      // double-send. Insert as pending; flip to sent only after the send
      // succeeds.
      const claimed = await db
        .insert(opportunityFollowUpsTable)
        .values({
          opportunityId: opp.id,
          ownerUserId,
          sequence: decision.nextSequence,
          scheduledAt: decision.dueAt,
          status: "pending",
          generatedMessage: draft.text,
        })
        .onConflictDoUpdate({
          target: [
            opportunityFollowUpsTable.opportunityId,
            opportunityFollowUpsTable.sequence,
          ],
          // Re-claim a stale `pending` recommendation for this same sequence
          // (toggle was off, now on) and attach the freshly drafted message.
          set: { generatedMessage: draft.text },
          setWhere: eq(opportunityFollowUpsTable.status, "pending"),
        })
        .returning({
          id: opportunityFollowUpsTable.id,
          status: opportunityFollowUpsTable.status,
        });
      const row = claimed[0];
      if (!row || row.status !== "pending") continue; // already sent.

      const tenant = await getOrCreateTenantSettings(ownerUserId);
      const ok = await sendFollowUpOnChannel(
        opp.channelId,
        opp.chatId,
        draft.text,
        { min: tenant.replyDelayMin, max: tenant.replyDelayMax }
      );
      if (!ok) {
        // Send failed (channel offline etc.). Roll the row back to pending
        // recommendation so we retry next sweep instead of marking it sent.
        await db
          .update(opportunityFollowUpsTable)
          .set({ status: "pending" })
          .where(eq(opportunityFollowUpsTable.id, row.id));
        continue;
      }

      const sentAt = new Date();
      await db
        .update(opportunityFollowUpsTable)
        .set({ status: "sent", sentAt })
        .where(eq(opportunityFollowUpsTable.id, row.id));
      // Advance the deal's activity clock so staleness/health reflect the touch.
      await db
        .update(opportunitiesTable)
        .set({ lastActivityAt: sentAt })
        .where(eq(opportunitiesTable.id, opp.id));
      await db.insert(salesAuditEventsTable).values({
        ownerUserId,
        opportunityId: opp.id,
        actorUserId: null,
        eventType: "follow_up_sent",
        detail: {
          sequence: decision.nextSequence,
          provider: draft.provider,
          model: draft.model,
        },
      });
      sent++;
    } catch (err) {
      logger.error(
        { err: (err as Error)?.message, opportunityId: opp.id },
        "follow-up engine: failed to process opportunity; will retry next sweep"
      );
    }
  }

  return { sent, recommended, cancelled };
}

// Cancel EVERY still-`pending` follow-up whose opportunity is no longer a live
// candidate — i.e. it closed (status != open) or is no longer waiting on the
// customer (the customer replied, flipping waitingStatus away from
// "waiting_customer"). This runs INDEPENDENTLY of the candidate filter because
// the moment a customer replies the deal drops out of the sweep set, so the
// per-candidate `cancelPendingRecommendations` path would never see it again
// and a stale "follow-up disarankan" would linger forever. `IS DISTINCT FROM`
// is used so a NULL waitingStatus also counts as "not waiting_customer".
async function cancelStalePendingFollowUps(): Promise<number> {
  const cancelled = await db
    .update(opportunityFollowUpsTable)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(opportunityFollowUpsTable.status, "pending"),
        sql`EXISTS (
          SELECT 1 FROM ${opportunitiesTable} o
          WHERE o.id = ${opportunityFollowUpsTable.opportunityId}
            AND (
              o.status <> 'open'
              OR o.waiting_status IS DISTINCT FROM 'waiting_customer'
            )
        )`
      )
    )
    .returning({ id: opportunityFollowUpsTable.id });
  return cancelled.length;
}

// Run one full follow-up sweep across every entitled tenant.
export async function runFollowUpSweep(
  now: Date = new Date()
): Promise<FollowUpSweepResult> {
  // Customer-replied / closed deals: cancel their lingering recommendations
  // first (independent of the candidate filter below).
  let cancelled = await cancelStalePendingFollowUps();

  // Candidate deals: open + waiting on the customer. We still load owners whose
  // toggle is OFF — they get recommendation rows. Entitlement is checked per
  // owner so non-Enterprise tenants are skipped entirely.
  const candidates = await db
    .select()
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.status, "open"),
        eq(opportunitiesTable.waitingStatus, "waiting_customer")
      )
    );

  // Group by owner.
  const byOwner = new Map<number, OpportunityRow[]>();
  for (const opp of candidates) {
    const list = byOwner.get(opp.ownerUserId);
    if (list) list.push(opp);
    else byOwner.set(opp.ownerUserId, [opp]);
  }

  let scannedOwners = 0;
  let sent = 0;
  let recommended = 0;
  for (const [ownerUserId, opps] of byOwner) {
    try {
      if (!(await ownerHasSalesAssistant(ownerUserId))) continue;
      scannedOwners++;
      const r = await processOwner(ownerUserId, opps, now);
      sent += r.sent;
      recommended += r.recommended;
      cancelled += r.cancelled;
    } catch (err) {
      logger.error(
        { err: (err as Error)?.message, ownerUserId },
        "follow-up engine: owner sweep failed"
      );
    }
  }

  if (sent > 0 || recommended > 0 || cancelled > 0) {
    logger.info(
      {
        scannedOwners,
        scannedOpportunities: candidates.length,
        sent,
        recommended,
        cancelled,
      },
      "follow-up sweep completed"
    );
  }
  return {
    scannedOwners,
    scannedOpportunities: candidates.length,
    sent,
    recommended,
    cancelled,
  };
}

// Hourly follow-up scheduler, mirroring the dunning/monthly-close pattern. The
// SEND behaviour is gated per-tenant on autoFollowUpEnabled (default OFF =
// recommend only), so this never auto-messages a customer until a tenant opts
// in. First run 3 min after boot, then hourly.
let followUpTimer: NodeJS.Timeout | null = null;
let followUpSweepRunning = false;
export function startFollowUpScheduler(): void {
  if (followUpTimer) return;
  const HOUR = 60 * 60 * 1000;
  const run = () => {
    // In-process overlap guard: if a sweep ever runs longer than the interval,
    // skip the next tick rather than send the same follow-up twice.
    if (followUpSweepRunning) return;
    followUpSweepRunning = true;
    runFollowUpSweep()
      .catch((err) =>
        logger.error({ err }, "follow-up scheduler run failed")
      )
      .finally(() => {
        followUpSweepRunning = false;
      });
  };
  setTimeout(run, 3 * 60 * 1000);
  followUpTimer = setInterval(run, HOUR);
  if (typeof followUpTimer.unref === "function") followUpTimer.unref();
  logger.info("follow-up scheduler started");
}
