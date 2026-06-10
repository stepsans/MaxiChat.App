import { and, eq } from "drizzle-orm";
import {
  db,
  opportunitiesTable,
  aiPipelineAnalysesTable,
  aiPipelineEntriesTable,
  chatsTable,
  pipelinesTable,
  pipelineStagesTable,
} from "@workspace/db";
import { seedDefaultPipelines } from "./sales-assistant";

interface CreateOpportunityOpts {
  analysisId: number;
  entryId: number;
  pipelineId: number;
  ownerUserId: number;
  contactPhone: string;
  contactName: string | null;
  channelId: number;
  score: number;
  estimatedValue: number | null;
  productInterest: string | null;
  scoreReason: string | null;
  recommendation: string | null;
}

export async function createOpportunityFromAnalysis(
  opts: CreateOpportunityOpts
): Promise<void> {
  const {
    analysisId,
    entryId,
    ownerUserId,
    contactPhone,
    contactName,
    channelId,
    score,
    estimatedValue,
    productInterest,
    scoreReason,
    recommendation,
  } = opts;

  // Check if an opportunity already exists for this entry.
  const existingEntry = await db.query.aiPipelineEntriesTable.findFirst({
    where: eq(aiPipelineEntriesTable.id, entryId),
  });
  if (existingEntry?.opportunityId) return; // already has an opportunity

  // Find the chat for this contact + channel.
  const [chat] = await db
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(
      and(
        eq(chatsTable.phoneNumber, contactPhone),
        eq(chatsTable.channelId, channelId)
      )
    )
    .limit(1);
  if (!chat) return; // no chat found, skip

  // Check if this phone+channel already has an open opportunity.
  const existingOpp = await db.query.opportunitiesTable.findFirst({
    where: and(
      eq(opportunitiesTable.ownerUserId, ownerUserId),
      eq(opportunitiesTable.contactPhone, contactPhone),
      eq(opportunitiesTable.channelId, channelId),
      eq(opportunitiesTable.status, "open")
    ),
  });
  if (existingOpp) {
    // Link the existing opportunity to this entry.
    await db.update(aiPipelineEntriesTable)
      .set({ opportunityId: existingOpp.id })
      .where(eq(aiPipelineEntriesTable.id, entryId));
    await db.update(aiPipelineAnalysesTable)
      .set({ opportunityId: existingOpp.id })
      .where(eq(aiPipelineAnalysesTable.id, analysisId));
    return;
  }

  // Get the default sales pipeline + first stage.
  const pipelinesWithStages = await seedDefaultPipelines(ownerUserId);
  const defaultPipeline = pipelinesWithStages.find((p) => p.pipeline.isDefault) ?? pipelinesWithStages[0];
  if (!defaultPipeline) return;

  const firstStage = defaultPipeline.stages.sort((a, b) => a.sortOrder - b.sortOrder)[0] ?? null;

  // Create the opportunity.
  const [opp] = await db.insert(opportunitiesTable).values({
    ownerUserId,
    chatId: chat.id,
    channelId,
    pipelineId: defaultPipeline.pipeline.id,
    stageId: firstStage?.id ?? null,
    contactPhone,
    contactName,
    leadScore: score,
    intentType: "purchase",
    estimatedValueIdr: estimatedValue ?? 0,
    status: "open",
    productInterest: productInterest ? [productInterest] : [],
    scoreReason: scoreReason ?? null,
    recommendation: recommendation ?? null,
    aiNotes: null,
    analyzedMessageIds: [],
  }).returning();

  if (!opp) return;

  // Link opportunity back to the AI pipeline entry and analysis.
  await db.update(aiPipelineEntriesTable)
    .set({ opportunityId: opp.id })
    .where(eq(aiPipelineEntriesTable.id, entryId));

  await db.update(aiPipelineAnalysesTable)
    .set({ opportunityId: opp.id })
    .where(eq(aiPipelineAnalysesTable.id, analysisId));
}
