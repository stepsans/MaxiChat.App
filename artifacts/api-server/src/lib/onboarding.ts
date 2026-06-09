import { and, eq, inArray, asc } from "drizzle-orm";
import {
  db,
  onboardingChecklistTable,
  usersTable,
  channelsTable,
  chatsTable,
  productsTable,
  aiUsageEventsTable,
  chatbotFlowsTable,
  chatbotFlowChannelsTable,
} from "@workspace/db";

// Compute health score from a checklist row.
export function calcHealthScore(
  row: Pick<
    typeof onboardingChecklistTable.$inferSelect,
    | "waConnected"
    | "productAdded"
    | "firstMessageAt"
    | "teamMemberAdded"
    | "aiTriedAt"
    | "flowActivated"
  >
): { score: number; riskLevel: "low" | "medium" | "high" } {
  let score = 0;
  if (row.waConnected) score += 30;
  if (row.productAdded) score += 20;
  if (row.firstMessageAt) score += 20;
  if (row.teamMemberAdded) score += 15;
  if (row.aiTriedAt) score += 10;
  if (row.flowActivated) score += 5;

  const riskLevel: "low" | "medium" | "high" =
    score >= 70 ? "low" : score >= 40 ? "medium" : "high";

  return { score, riskLevel };
}

// Get or create the checklist row for one owner. Called by various event
// handlers (channel connected, product created, etc).
export async function getOrCreateChecklist(ownerUserId: number) {
  const [existing] = await db
    .select()
    .from(onboardingChecklistTable)
    .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(onboardingChecklistTable)
    .values({ ownerUserId })
    .onConflictDoNothing()
    .returning();

  // Fallback on conflict (race condition).
  if (!created) {
    const [refetched] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
      .limit(1);
    return refetched!;
  }
  return created;
}

// Recompute the checklist from actual DB data. Called on: channel connect,
// product add, message in/out, AI reply, flow activation.
export async function refreshChecklist(ownerUserId: number): Promise<void> {
  const now = new Date();

  // 1. WhatsApp connected?
  const [waChannel] = await db
    .select({
      id: channelsTable.id,
      status: channelsTable.status,
      createdAt: channelsTable.createdAt,
    })
    .from(channelsTable)
    .where(
      and(
        eq(channelsTable.userId, ownerUserId),
        eq(channelsTable.kind, "whatsapp"),
        eq(channelsTable.status, "connected")
      )
    )
    .limit(1);

  // 2. Any product?
  const [product] = await db
    .select({ id: productsTable.id, createdAt: productsTable.createdAt })
    .from(productsTable)
    .where(eq(productsTable.userId, ownerUserId))
    .limit(1);

  // 3. Any team member (child user)?
  const [teamMember] = await db
    .select({ id: usersTable.id, createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.parentUserId, ownerUserId))
    .limit(1);

  // 4. Any message (inbound or outbound)? Scope chats to the owner's channels
  // and take the earliest one with activity.
  const ownerChannels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId));

  let firstMessage: Date | null = null;
  if (ownerChannels.length > 0) {
    const channelIds = ownerChannels.map((c) => c.id);
    const [chat] = await db
      .select({ lastMessageAt: chatsTable.lastMessageAt })
      .from(chatsTable)
      .where(inArray(chatsTable.channelId, channelIds))
      .orderBy(asc(chatsTable.lastMessageAt))
      .limit(1);
    if (chat?.lastMessageAt) firstMessage = chat.lastMessageAt;
  }

  // 5. AI ever replied?
  const [aiUsage] = await db
    .select({ createdAt: aiUsageEventsTable.createdAt })
    .from(aiUsageEventsTable)
    .where(eq(aiUsageEventsTable.userId, ownerUserId))
    .limit(1);

  // 6. Any active flow assigned to a channel?
  const [activeFlow] = await db
    .select({ channelId: chatbotFlowChannelsTable.channelId })
    .from(chatbotFlowChannelsTable)
    .innerJoin(
      chatbotFlowsTable,
      eq(chatbotFlowsTable.id, chatbotFlowChannelsTable.flowId)
    )
    .where(
      and(
        eq(chatbotFlowsTable.userId, ownerUserId),
        eq(chatbotFlowsTable.isActive, true)
      )
    )
    .limit(1);

  const patch = {
    waConnected: !!waChannel,
    waConnectedAt: waChannel ? (waChannel.createdAt ?? now) : null,
    productAdded: !!product,
    productAddedAt: product ? (product.createdAt ?? now) : null,
    teamMemberAdded: !!teamMember,
    teamMemberAddedAt: teamMember ? (teamMember.createdAt ?? now) : null,
    firstMessageAt: firstMessage,
    aiTriedAt: aiUsage ? (aiUsage.createdAt ?? now) : null,
    flowActivated: !!activeFlow,
    flowActivatedAt: activeFlow ? now : null,
  };

  const { score, riskLevel } = calcHealthScore(patch);

  await db
    .insert(onboardingChecklistTable)
    .values({
      ownerUserId,
      ...patch,
      healthScore: score,
      riskLevel,
    })
    .onConflictDoUpdate({
      target: onboardingChecklistTable.ownerUserId,
      set: {
        ...patch,
        healthScore: score,
        riskLevel,
        updatedAt: now,
      },
    });
}
