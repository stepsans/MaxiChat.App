import { eq } from "drizzle-orm";
import {
  db,
  opportunitiesTable,
  aiPipelineAnalysesTable,
  aiPipelinesTable,
} from "@workspace/db";

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
    await db
      .update(aiPipelineAnalysesTable)
      .set({ opportunityId: opp.id })
      .where(eq(aiPipelineAnalysesTable.id, analysis.id));
  }
}
