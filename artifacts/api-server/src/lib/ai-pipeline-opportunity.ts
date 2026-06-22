import { and, eq } from "drizzle-orm";
import {
  db,
  opportunitiesTable,
  aiPipelineAnalysesTable,
  aiPipelineEntriesTable,
  aiPipelinesTable,
} from "@workspace/db";

// Link a freshly resolved opportunity id to both the analysis and (when known)
// its pipeline entry, so a later cut-off won't auto-create a duplicate.
async function linkOpportunity(
  analysis: typeof aiPipelineAnalysesTable.$inferSelect,
  opportunityId: number,
): Promise<void> {
  await db
    .update(aiPipelineAnalysesTable)
    .set({ opportunityId })
    .where(eq(aiPipelineAnalysesTable.id, analysis.id));
  if (analysis.pipelineEntryId != null) {
    await db
      .update(aiPipelineEntriesTable)
      .set({ opportunityId })
      .where(eq(aiPipelineEntriesTable.id, analysis.pipelineEntryId));
  }
}

// Auto-create a sales Opportunity from a high-scoring AI Pipeline analysis.
// Reuses the existing opportunities table. The opportunity lands "unsorted"
// (no pipeline/stage) — the team triages it from there. intentKey is left null
// so it is exempt from the (chat, intent) dedup unique index.
export async function createOpportunityFromAi(opts: {
  analysis: typeof aiPipelineAnalysesTable.$inferSelect;
  pipeline: typeof aiPipelinesTable.$inferSelect;
}): Promise<void> {
  const { analysis, pipeline } = opts;

  // chatId is required by opportunities; analyses created before this feature
  // (or via paths that don't set it) may lack it — skip rather than crash.
  if (analysis.chatId == null) return;

  // Idempotency guard. Pipeline-created opportunities use a null intentKey, so
  // the (chat, intent) unique index can't dedup them. Without this, a contact
  // that re-crosses the opportunity threshold on a later cut-off would spawn a
  // second opportunity row. If an open opportunity already exists for this chat,
  // link the analysis to it instead of creating a duplicate.
  const [existing] = await db
    .select({ id: opportunitiesTable.id })
    .from(opportunitiesTable)
    .where(
      and(
        eq(opportunitiesTable.chatId, analysis.chatId),
        eq(opportunitiesTable.ownerUserId, pipeline.ownerUserId),
        eq(opportunitiesTable.status, "open")
      )
    )
    .limit(1);
  if (existing) {
    await linkOpportunity(analysis, existing.id);
    return;
  }

  const notes = [
    analysis.aiNotes ? `📋 Catatan AI: ${analysis.aiNotes}` : null,
    analysis.scoreReason
      ? `💡 Alasan Skor (${analysis.score}/100): ${analysis.scoreReason}`
      : null,
    `🤖 Sumber: AI Pipeline — ${pipeline.name}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const [opp] = await db
    .insert(opportunitiesTable)
    .values({
      ownerUserId: pipeline.ownerUserId,
      chatId: analysis.chatId,
      channelId: analysis.channelId,
      contactPhone: analysis.contactPhone,
      contactName: analysis.contactName,
      leadScore: analysis.score,
      intentCategory: "purchase",
      estimatedValueIdr: analysis.estimatedValue ?? 0,
      productInterest: analysis.productInterest ? [analysis.productInterest] : [],
      scoreReason: analysis.scoreReason,
      aiNotes: notes,
      recommendation: analysis.recommendation,
      status: "open",
      analyzedAt: new Date(),
      lastActivityAt: new Date(),
    })
    .returning({ id: opportunitiesTable.id });

  if (opp) {
    await linkOpportunity(analysis, opp.id);
  }
}
