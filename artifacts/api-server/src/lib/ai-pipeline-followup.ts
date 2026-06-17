import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  db,
  aiPipelineEntriesTable,
  aiPipelineFollowupLogsTable,
  aiPipelinesTable,
  chatMessagesTable,
  chatsTable,
  channelsTable,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";

// ─── Schedule follow-up for a newly entered pipeline entry ────────────────────

export async function scheduleFollowups(opts: {
  entryId: number;
  pipelineId: number;
  ownerUserId: number;
  followupIntervals: string[];
  currentFollowupCount: number;
}): Promise<void> {
  const { entryId, pipelineId, ownerUserId, followupIntervals, currentFollowupCount } = opts;

  // Get the next interval (based on how many follow-ups have been sent).
  const nextIdx = currentFollowupCount;
  if (nextIdx >= followupIntervals.length || nextIdx >= 3) return;

  const interval = followupIntervals[nextIdx]!;
  const hours = parseIntervalHours(interval);
  if (hours <= 0) return;

  const nextFollowupAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  await db.update(aiPipelineEntriesTable)
    .set({ nextFollowupAt, updatedAt: new Date() })
    .where(eq(aiPipelineEntriesTable.id, entryId));
}

// ─── Process pending follow-ups (called by cron every 5 minutes) ──────────────

export async function processPendingFollowups(): Promise<void> {
  // Find entries that are due for follow-up.
  const due = await db
    .select()
    .from(aiPipelineEntriesTable)
    .where(
      and(
        eq(aiPipelineEntriesTable.doNotFollowup, false),
        lte(aiPipelineEntriesTable.nextFollowupAt, sql`NOW()`),
        inArray(aiPipelineEntriesTable.status, ["new", "followup_sent"])
      )
    )
    .limit(20);

  for (const entry of due) {
    sendFollowup(entry.id).catch((err: unknown) => {
      console.error("[ai-pipeline-followup] error for entry", entry.id, err);
    });
  }
}

// ─── Send a single follow-up message ─────────────────────────────────────────

async function sendFollowup(entryId: number): Promise<void> {
  const entry = await db.query.aiPipelineEntriesTable.findFirst({
    where: eq(aiPipelineEntriesTable.id, entryId),
  });
  if (!entry) return;

  // Re-check conditions.
  if (entry.doNotFollowup) return;
  if (entry.followupCount >= 3) {
    await db.update(aiPipelineEntriesTable)
      .set({ nextFollowupAt: null, updatedAt: new Date() })
      .where(eq(aiPipelineEntriesTable.id, entryId));
    return;
  }

  const pipeline = await db.query.aiPipelinesTable.findFirst({
    where: eq(aiPipelinesTable.id, entry.pipelineId),
  });
  if (!pipeline || !pipeline.autoFollowupEnabled) return;

  // Check for recent customer reply (stop signal).
  const [chat] = await db
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(
      and(
        eq(chatsTable.phoneNumber, entry.contactPhone),
        eq(chatsTable.channelId, entry.channelId)
      )
    )
    .limit(1);

  if (chat) {
    // Check if customer replied after the last follow-up.
    const sinceTime = entry.lastFollowupAt ?? entry.enteredAt;
    const [recentReply] = await db
      .select({ id: chatMessagesTable.id })
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.chatId, chat.id),
          eq(chatMessagesTable.direction, "inbound"),
          gte(chatMessagesTable.createdAt, sinceTime)
        )
      )
      .limit(1);

    if (recentReply) {
      // Customer replied — mark as replied and stop follow-up.
      await db.update(aiPipelineEntriesTable)
        .set({ status: "replied", doNotFollowup: true, nextFollowupAt: null, updatedAt: new Date() })
        .where(eq(aiPipelineEntriesTable.id, entryId));
      return;
    }
  }

  // Generate follow-up message using AI.
  const message = await generateFollowupMessage(entry, pipeline);
  if (!message) return;

  // Log the follow-up.
  const followupNumber = entry.followupCount + 1;
  await db.insert(aiPipelineFollowupLogsTable).values({
    entryId,
    pipelineId: entry.pipelineId,
    contactPhone: entry.contactPhone,
    channelId: entry.channelId,
    followupNumber,
    messageSent: message,
    sentAt: new Date(),
    wasReplied: false,
    status: "sent",
  });

  // Update entry.
  const followupIntervals = (pipeline.followupIntervals as string[] | null) ?? ["24h", "48h", "72h"];
  const nextIdx = followupNumber; // 0-indexed, so after sending follow-up N we check interval N+1
  let nextFollowupAt: Date | null = null;
  if (nextIdx < followupIntervals.length && nextIdx < 3) {
    const hours = parseIntervalHours(followupIntervals[nextIdx]!);
    if (hours > 0) {
      nextFollowupAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    }
  }

  await db.update(aiPipelineEntriesTable)
    .set({
      followupCount: followupNumber,
      lastFollowupAt: new Date(),
      nextFollowupAt,
      status: "followup_sent",
      updatedAt: new Date(),
    })
    .where(eq(aiPipelineEntriesTable.id, entryId));

  // Send the actual WhatsApp/Telegram message.
  if (chat) {
    await sendMessageToChat(chat.id, entry.channelId, message);
  }
}

// ─── AI follow-up generation ───────────────────────────────────────────────────

export async function generateFollowupMessage(
  entry: typeof aiPipelineEntriesTable.$inferSelect,
  pipeline: typeof aiPipelinesTable.$inferSelect
): Promise<string | null> {
  try {
    const { client, model, provider, ownerUserId } = await resolveAiClient(pipeline.ownerUserId);

    // Load recent conversation context (last 10 messages).
    const [chat] = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(
        and(
          eq(chatsTable.phoneNumber, entry.contactPhone),
          eq(chatsTable.channelId, entry.channelId)
        )
      )
      .limit(1);

    let recentContext = "";
    if (chat) {
      const msgs = await db
        .select({ direction: chatMessagesTable.direction, content: chatMessagesTable.content })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatId, chat.id))
        .orderBy(desc(chatMessagesTable.id))
        .limit(10);
      recentContext = msgs
        .reverse()
        .map((m) => `${m.direction === "outbound" ? "Bisnis" : "Pelanggan"}: ${m.content ?? ""}`)
        .join("\n");
    }

    const prompt = `Kamu adalah agen penjualan yang ramah dan profesional. Tulis pesan follow-up WhatsApp untuk prospek ini.

Nama kontak: ${entry.contactName ?? "Pelanggan"}
Produk diminati: ${entry.productInterest ?? "tidak diketahui"}
Follow-up ke-${entry.followupCount + 1} dari 3

${recentContext ? `Konteks percakapan terakhir:\n${recentContext}\n` : ""}

Tulis pesan follow-up yang:
- Singkat (2-4 kalimat)
- Natural dan ramah, tidak terlalu formal
- Relevan dengan konteks percakapan
- Tidak memaksa
- Dalam bahasa Indonesia

Balas HANYA dengan teks pesan follow-up (tanpa penjelasan tambahan).`;

    const completion = await (client.chat.completions.create as Function)({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      temperature: 0.7,
    }) as { choices: Array<{ message: { content: string } }>; usage?: Record<string, number> };

    // Record usage.
    try {
      await recordAiUsage({
        ownerUserId,
        channelId: entry.channelId,
        provider,
        model,
        usage: completion.usage ?? null,
      });
    } catch { /* non-fatal */ }

    return completion.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    console.error("[ai-pipeline-followup] message generation failed:", err);
    return null;
  }
}

// ─── Send message helper ──────────────────────────────────────────────────────

async function sendMessageToChat(
  chatId: number,
  channelId: number,
  message: string
): Promise<void> {
  try {
    const { sendFollowUpOnChannel } = await import("../routes/whatsapp");
    await sendFollowUpOnChannel(channelId, chatId, message, { min: 1000, max: 3000 });
  } catch {
    console.warn("[ai-pipeline-followup] could not send message to chat", chatId);
  }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function parseIntervalHours(interval: string): number {
  const match = interval.match(/^(\d+)h$/);
  if (!match) return 0;
  return parseInt(match[1]!, 10);
}

// ─── Stop signal detection ─────────────────────────────────────────────────────
// Called from the message receive handler when a customer sends a message.

export async function handleInboundMessageStopSignal(
  contactPhone: string,
  channelId: number,
  messageContent: string
): Promise<void> {
  // Look for active pipeline entries for this contact.
  const entries = await db
    .select({ id: aiPipelineEntriesTable.id })
    .from(aiPipelineEntriesTable)
    .where(
      and(
        eq(aiPipelineEntriesTable.contactPhone, contactPhone),
        eq(aiPipelineEntriesTable.channelId, channelId),
        inArray(aiPipelineEntriesTable.status, ["new", "followup_sent"])
      )
    );

  if (entries.length === 0) return;

  // Detect explicit stop signals.
  const stopKeywords = ["stop", "berhenti", "tidak perlu", "no thanks", "tidak usah", "jangan", "cancel", "batalkan"];
  const lc = messageContent.toLowerCase();
  const isStopSignal = stopKeywords.some((kw) => lc.includes(kw));

  for (const entry of entries) {
    if (isStopSignal) {
      // Hard stop.
      await db.update(aiPipelineEntriesTable)
        .set({
          doNotFollowup: true,
          doNotFollowupReason: "Pelanggan meminta berhenti",
          doNotFollowupAt: new Date(),
          status: "do_not_followup",
          nextFollowupAt: null,
          updatedAt: new Date(),
        })
        .where(eq(aiPipelineEntriesTable.id, entry.id));
    } else {
      // Any reply (not a stop) marks the entry as replied and pauses follow-up.
      await db.update(aiPipelineEntriesTable)
        .set({
          status: "replied",
          nextFollowupAt: null,
          updatedAt: new Date(),
        })
        .where(eq(aiPipelineEntriesTable.id, entry.id));
    }
  }
}
