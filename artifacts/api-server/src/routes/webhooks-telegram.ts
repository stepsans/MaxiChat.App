import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  db,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  settingsTable,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { withTag, AI_TAG } from "../lib/sender-tag.js";
import {
  parseTelegramMessage,
  sendMessage as tgSendMessage,
  type TelegramUpdate,
} from "../lib/telegram";
import { generateAiReply } from "./whatsapp";
import { getOrCreateTenantSettings } from "../lib/settings-store";
import { isOwnerReadOnly } from "../lib/billing";
import { notifyInboundMessage } from "../lib/push";

const router = Router();

// Webhook receiver for inbound Telegram updates. Mounted at
// /api/webhooks/telegram/:channelId BEFORE requireAuth — Telegram has no
// session cookie. We authenticate the caller via the secret token Telegram
// echoes in X-Telegram-Bot-Api-Secret-Token (set at /setWebhook time and
// stored on the channel row).
//
// We ack 200 fast even on processing errors so Telegram doesn't retry the
// same update repeatedly; persistence/AI failures are logged for the
// operator instead.
router.post("/:channelId", async (req, res): Promise<void> => {
  const channelId = Number.parseInt(String(req.params.channelId ?? ""), 10);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    res.status(400).json({ error: "Invalid channel id" });
    return;
  }

  // Look up the channel + its stored webhook secret.
  const [channel] = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId))
    .limit(1);

  if (!channel || channel.kind !== "telegram") {
    res.status(404).json({ error: "Channel not found" });
    return;
  }

  const meta =
    (channel.metadata as Record<string, unknown> | null)?.["telegram"] as
      | { botToken?: string; webhookSecret?: string }
      | undefined;
  const expectedSecret = meta?.webhookSecret;
  const botToken = meta?.botToken;
  if (!expectedSecret || !botToken) {
    res.status(404).json({ error: "Channel not configured" });
    return;
  }

  // Constant-time secret comparison. Telegram caps the secret at 256 chars
  // and our generator is fixed-width, so length mismatch is itself a hard
  // reject (timingSafeEqual would throw on unequal lengths).
  const provided = req.header("x-telegram-bot-api-secret-token") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(403).json({ error: "Bad secret" });
    return;
  }

  // ACK Telegram immediately, then process. This avoids Telegram retrying
  // on slow AI calls and matches the WhatsApp inbound model where reply
  // generation is fire-and-forget relative to the network event.
  res.status(200).json({ ok: true });

  void processUpdate(channelId, channel.userId, botToken, req.body as TelegramUpdate).catch(
    (err) =>
      logger.error({ err, channelId }, "telegram webhook processing failed")
  );
});

async function processUpdate(
  channelId: number,
  ownerUserId: number,
  botToken: string,
  update: TelegramUpdate
): Promise<void> {
  const raw = update.message ?? update.edited_message;
  if (!raw) return; // ignore non-message updates
  const parsed = parseTelegramMessage(raw);
  if (!parsed) return;
  if (parsed.fromBot) return; // don't loop on other bots
  if (!parsed.isPrivate) return; // MVP: skip groups/channels

  // Upsert chat. Composite unique (channel_id, phone_number) lets us
  // re-use the same DB column for the telegram chat key. We insert with
  // doNothing then re-select so we always have the row id.
  await db
    .insert(chatsTable)
    .values({
      channelId,
      phoneNumber: parsed.chatKey,
      contactName: parsed.contactName,
      lastMessage: parsed.text,
      lastMessageAt: new Date(),
      unreadCount: 1,
    })
    .onConflictDoNothing({
      target: [chatsTable.channelId, chatsTable.phoneNumber],
    });

  const [chat] = await db
    .select()
    .from(chatsTable)
    .where(
      sql`${chatsTable.channelId} = ${channelId} AND ${chatsTable.phoneNumber} = ${parsed.chatKey}`
    )
    .limit(1);
  if (!chat) {
    logger.error({ channelId, chatKey: parsed.chatKey }, "tg chat upsert miss");
    return;
  }

  // Bump existing-row stats. We do this as a second write rather than via
  // RETURNING because the doNothing path above returns no row.
  await db
    .update(chatsTable)
    .set({
      contactName: parsed.contactName,
      lastMessage: parsed.text,
      lastMessageAt: new Date(),
      unreadCount: sql`${chatsTable.unreadCount} + 1`,
    })
    .where(eq(chatsTable.id, chat.id));

  // De-dupe via the per-chat unique (chat_id, wa_message_id) index. Telegram
  // message_id is only unique PER chat, so the key includes the telegram chat
  // id too — keeping it stable even though the unique index is now composite.
  const dedupeId = `tg:${parsed.telegramChatId}:${parsed.messageId}`;
  const insertedRows = await db
    .insert(chatMessagesTable)
    .values({
      chatId: chat.id,
      direction: "inbound",
      content: parsed.text,
      waMessageId: dedupeId,
      isForwarded: parsed.isForwarded,
    })
    .onConflictDoNothing({ target: [chatMessagesTable.chatId, chatMessagesTable.waMessageId] })
    .returning();

  if (insertedRows.length === 0) return; // duplicate, skip AI

  // Push notify allowed mobile users about the new inbound telegram message.
  void notifyInboundMessage({
    channelId,
    chatId: chat.id,
    title: parsed.contactName || chat.contactName || "Telegram",
    body: parsed.text || "Pesan baru",
  });

  if (chat.isHumanTakeover) return; // operator is driving

  // Subscription gate: an expired/suspended tenant's bot stays silent. The
  // inbound message is still recorded above; only the auto-reply is skipped.
  try {
    if (await isOwnerReadOnly(ownerUserId)) return;
  } catch (err) {
    logger.error({ err, ownerUserId }, "tg auto-reply subscription gate failed");
    return;
  }

  // AI auto-reply (no chatbot-flow engine in v1 for Telegram — flows are
  // tightly coupled to the WA-specific runtime today and will be wired in
  // a follow-up).
  const settingsRows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.channelId, channelId))
    .limit(1);
  const settings = settingsRows[0];
  if (!settings?.autoReplyEnabled) return;

  // Reply delay + fallback message are business-wide (tenant), not per-channel.
  const tenant = await getOrCreateTenantSettings(ownerUserId);
  const delayMin = (tenant.replyDelayMin ?? 1) * 1000;
  const delayMax = (tenant.replyDelayMax ?? 3) * 1000;
  const delay = Math.random() * (delayMax - delayMin) + delayMin;
  await new Promise((r) => setTimeout(r, delay));

  // Re-check takeover after the delay so an operator who clicked "ambil
  // alih" mid-delay isn't talked over by the bot.
  const [fresh] = await db
    .select({ isHumanTakeover: chatsTable.isHumanTakeover })
    .from(chatsTable)
    .where(eq(chatsTable.id, chat.id))
    .limit(1);
  if (fresh?.isHumanTakeover) return;

  const ai = await generateAiReply(channelId, ownerUserId, chat.id, parsed.text);
  const replyText = ai ? withTag(ai, AI_TAG) : tenant.fallbackMessage;
  if (!replyText) return;

  let sentMessageId: number | null = null;
  try {
    const sent = await tgSendMessage(botToken, parsed.telegramChatId, replyText);
    sentMessageId = sent.messageId;
  } catch (err) {
    logger.error({ err, channelId, chatId: chat.id }, "telegram sendMessage failed");
    return;
  }

  await db
    .insert(chatMessagesTable)
    .values({
      chatId: chat.id,
      direction: "outbound",
      content: replyText,
      isAiGenerated: !!ai,
      waMessageId: sentMessageId
        ? `tg:${parsed.telegramChatId}:${sentMessageId}`
        : null,
    })
    .onConflictDoNothing({ target: [chatMessagesTable.chatId, chatMessagesTable.waMessageId] });

  await db
    .update(chatsTable)
    .set({
      lastMessage: replyText,
      lastMessageAt: new Date(),
      status: "ai_handled",
    })
    .where(eq(chatsTable.id, chat.id));
}

export default router;
