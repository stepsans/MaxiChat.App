import { and, desc, eq } from "drizzle-orm";
import {
  db,
  contactLeadStatusTable,
  leadFeedbackTable,
  leadReviewRequestsTable,
  aiPipelineAnalysesTable,
} from "@workspace/db";

// Shared write-path for a tenant's manual lead-status correction. One call:
//   1. upserts contact_lead_status as 'manual' (always wins over AI),
//   2. records a lead_feedback training row when the status actually changed
//      (enriched with what the AI last thought, for conflict-aware lessons),
//   3. resolves any pending review request for that contact.
// Used by the chat combobox, bulk edit, and the Review Lead answer route — so
// every correction feeds the learning loop the same way ([[lead-learning]]).
export async function recordLeadCorrection(opts: {
  ownerUserId: number;
  phoneNumber: string;
  contactName?: string | null;
  toStatus: string;
  reason?: string | null;
  reasonCode?: string | null;
  source?: string; // 'manual_edit' | 'bulk_edit' | 'review_answer'
  chatId?: number | null;
  channelId?: number | null;
  answeredByUserId?: number | null;
}): Promise<{ changed: boolean; fromStatus: string }> {
  const {
    ownerUserId,
    phoneNumber,
    toStatus,
    reason = null,
    reasonCode = null,
    source = "manual_edit",
    chatId = null,
    channelId = null,
    answeredByUserId = null,
  } = opts;

  // Prior status (defaults to "unknown" when the contact has no row yet).
  const [prior] = await db
    .select({ leadStatus: contactLeadStatusTable.leadStatus })
    .from(contactLeadStatusTable)
    .where(
      and(
        eq(contactLeadStatusTable.ownerUserId, ownerUserId),
        eq(contactLeadStatusTable.phoneNumber, phoneNumber)
      )
    )
    .limit(1);
  const fromStatus = prior?.leadStatus ?? "unknown";

  // Upsert as manual — a manual edit always wins and re-stamps as 'manual'.
  await db
    .insert(contactLeadStatusTable)
    .values({ ownerUserId, phoneNumber, leadStatus: toStatus, leadClassifiedBy: "manual" })
    .onConflictDoUpdate({
      target: [contactLeadStatusTable.ownerUserId, contactLeadStatusTable.phoneNumber],
      set: { leadStatus: toStatus, leadClassifiedBy: "manual", updatedAt: new Date() },
    });

  const changed = fromStatus !== toStatus;

  // Only an actual transition teaches anything.
  if (changed) {
    // Enrich the lesson with what the AI last concluded for this contact.
    const [lastAi] = await db
      .select({
        aiConversationRole: aiPipelineAnalysesTable.conversationRole,
        aiScore: aiPipelineAnalysesTable.score,
        productInterest: aiPipelineAnalysesTable.productInterest,
        scoreReason: aiPipelineAnalysesTable.scoreReason,
      })
      .from(aiPipelineAnalysesTable)
      .where(
        and(
          eq(aiPipelineAnalysesTable.ownerUserId, ownerUserId),
          eq(aiPipelineAnalysesTable.contactPhone, phoneNumber)
        )
      )
      .orderBy(desc(aiPipelineAnalysesTable.createdAt))
      .limit(1);

    await db.insert(leadFeedbackTable).values({
      ownerUserId,
      contactPhone: phoneNumber,
      chatId,
      channelId,
      fromStatus,
      toStatus,
      reason,
      reasonCode,
      aiConversationRole: lastAi?.aiConversationRole ?? null,
      aiScore: lastAi?.aiScore ?? null,
      contextSummary: lastAi?.productInterest || lastAi?.scoreReason || null,
      source,
    });
  }

  // Close any open clarification request for this contact — the tenant just
  // decided, directly or via the combobox.
  await db
    .update(leadReviewRequestsTable)
    .set({
      status: "answered",
      answeredStatus: toStatus,
      answeredReason: reason,
      answeredByUserId,
      answeredAt: new Date(),
    })
    .where(
      and(
        eq(leadReviewRequestsTable.ownerUserId, ownerUserId),
        eq(leadReviewRequestsTable.contactPhone, phoneNumber),
        eq(leadReviewRequestsTable.status, "pending")
      )
    );

  return { changed, fromStatus };
}
