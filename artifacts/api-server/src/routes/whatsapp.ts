import { Router } from "express";
import type makeWASocketType from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import path from "path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db } from "@workspace/db";
import {
  whatsappSessionTable,
  chatsTable,
  chatMessagesTable,
  knowledgeTable,
  settingsTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";

const AUTH_DIR = path.join(process.cwd(), ".whatsapp-auth");
export const MEDIA_DIR = path.join(process.cwd(), "media");

async function ensureMediaDir() {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
  } catch {}
}

async function saveBufferToMedia(
  buffer: Buffer,
  mimeType: string,
  preferredFilename?: string
): Promise<{ url: string; filename: string }> {
  await ensureMediaDir();
  const ext = preferredFilename
    ? path.extname(preferredFilename) || `.${mime.extension(mimeType) || "bin"}`
    : `.${mime.extension(mimeType) || "bin"}`;
  const filename = `${randomUUID()}${ext}`;
  const filepath = path.join(MEDIA_DIR, filename);
  await fs.writeFile(filepath, buffer);
  return { url: `/api/media/${filename}`, filename: preferredFilename ?? filename };
}

export function getActiveSocket(): WASocket | null {
  return sock;
}

export async function sendMediaToJid(
  jid: string,
  filepath: string,
  mimeType: string,
  mediaType: "image" | "video" | "document" | "audio",
  caption?: string,
  filename?: string
): Promise<string | null> {
  if (!sock) throw new Error("WhatsApp is not connected");
  const buffer = await fs.readFile(filepath);
  let sent;
  if (mediaType === "image") {
    sent = await sock.sendMessage(jid, { image: buffer, caption, mimetype: mimeType });
  } else if (mediaType === "video") {
    sent = await sock.sendMessage(jid, { video: buffer, caption, mimetype: mimeType });
  } else if (mediaType === "audio") {
    sent = await sock.sendMessage(jid, { audio: buffer, mimetype: mimeType, ptt: false });
  } else {
    sent = await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mimeType,
      fileName: filename ?? path.basename(filepath),
      caption,
    });
  }
  return sent?.key?.id ?? null;
}

export async function sendContactToJid(
  jid: string,
  contactName: string,
  contactPhone: string
): Promise<string | null> {
  if (!sock) throw new Error("WhatsApp is not connected");
  // Build vCard
  const cleanPhone = contactPhone.replace(/[^\d+]/g, "");
  const waNumber = cleanPhone.startsWith("+") ? cleanPhone.slice(1) : cleanPhone;
  const vcard =
    "BEGIN:VCARD\n" +
    "VERSION:3.0\n" +
    `FN:${contactName}\n` +
    `TEL;type=CELL;type=VOICE;waid=${waNumber}:${cleanPhone}\n` +
    "END:VCARD";
  const sent = await sock.sendMessage(jid, {
    contacts: {
      displayName: contactName,
      contacts: [{ vcard }],
    },
  });
  return sent?.key?.id ?? null;
}

type WASocket = Awaited<ReturnType<typeof makeWASocketType>>;

let sock: WASocket | null = null;
let isConnecting = false;
// Bumped on every disconnect/reset. Event handlers capture the epoch at
// attach time and refuse to persist if the global epoch has moved on — this
// prevents stale in-flight messages.upsert / messaging-history.set callbacks
// from a torn-down socket reinserting chats *after* /disconnect cleared them.
let sessionEpoch = 0;

// Digits-only phone number of the currently linked WhatsApp account. Set on
// connection.open, cleared on disconnect. Every chat/message we persist while
// connected is scoped to this owner so different operators (scanning their
// own QR after a logout) see ONLY their own conversations.
let currentOwnerPhone: string | null = null;

// Baileys' sock.user.id looks like "628111…:7@s.whatsapp.net" — strip every
// non-digit to canonicalise. Returns null for empty / null input.
function normalizeOwnerPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/[^0-9]/g, "");
  return digits.length ? digits : null;
}

/**
 * Returns the digits-only phone number of the WhatsApp account currently
 * linked via QR, or null if disconnected. Used by chat / analytics routes
 * to scope every read & write to the active session — without this, a new
 * operator scanning their own QR would see the previous account's chats.
 */
export async function getCurrentOwnerPhone(): Promise<string | null> {
  if (currentOwnerPhone) return currentOwnerPhone;
  // Cold-start path: server restart between connect events means the
  // module-level cache is empty even though the DB still has the row.
  const rows = await db
    .select({ phoneNumber: whatsappSessionTable.phoneNumber, status: whatsappSessionTable.status })
    .from(whatsappSessionTable)
    .limit(1);
  if (!rows.length || rows[0].status !== "connected") return null;
  const normalized = normalizeOwnerPhone(rows[0].phoneNumber);
  currentOwnerPhone = normalized;
  return normalized;
}

async function getOrCreateSession() {
  const sessions = await db.select().from(whatsappSessionTable).limit(1);
  if (sessions.length > 0) return sessions[0];
  const [created] = await db
    .insert(whatsappSessionTable)
    .values({ status: "disconnected" })
    .returning();
  return created;
}

async function setStatus(
  id: number,
  status: string,
  opts: { qrCode?: string | null; phoneNumber?: string | null; connectedAt?: Date | null } = {}
) {
  const [updated] = await db
    .update(whatsappSessionTable)
    .set({ status, updatedAt: new Date(), ...opts })
    .where(eq(whatsappSessionTable.id, id))
    .returning();
  return updated;
}

// Extracts pin/archive metadata from a Baileys chat object. Returns a partial
// update set; missing keys mean "leave the column as-is". An explicit
// pinned=0/null clears any prior pin.
function extractChatListMeta(
  c: Record<string, unknown>
): { pinnedAt?: Date | null; isArchived?: boolean } {
  const meta: { pinnedAt?: Date | null; isArchived?: boolean } = {};
  if (Object.prototype.hasOwnProperty.call(c, "pinned")) {
    const p = (c as { pinned?: unknown }).pinned;
    if (typeof p === "number" && p > 0) {
      // Baileys stores pin time as unix seconds.
      meta.pinnedAt = new Date(p * 1000);
    } else if (p === 0 || p === null) {
      // Explicit unpin signal. Skip undefined / other values to avoid
      // false clears from partial updates.
      meta.pinnedAt = null;
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(c, "archived") &&
    typeof (c as { archived?: unknown }).archived === "boolean"
  ) {
    meta.isArchived = (c as { archived: boolean }).archived;
  }
  return meta;
}

async function applyChatListMeta(
  ownerPhone: string,
  phoneNumber: string,
  c: Record<string, unknown>
): Promise<void> {
  const meta = extractChatListMeta(c);
  if (Object.keys(meta).length === 0) return;
  await db
    .update(chatsTable)
    .set(meta)
    .where(
      sql`${chatsTable.ownerPhone} = ${ownerPhone} AND ${chatsTable.phoneNumber} = ${phoneNumber}`
    );
}

async function getOrCreateChat(
  ownerPhone: string,
  phoneNumber: string,
  contactName: string,
  opts: { isLid?: boolean } = {}
) {
  // True upsert keyed on (owner_phone, phone_number) so the same conversation
  // jid can exist independently under each WhatsApp account. ON CONFLICT DO
  // UPDATE on a no-op column returns the row.
  const isLid = !!opts.isLid;
  const [row] = await db
    .insert(chatsTable)
    .values({
      ownerPhone,
      phoneNumber,
      contactName,
      status: "ai_handled",
      tag: "none",
      isHumanTakeover: false,
      unreadCount: 0,
      isLid,
    })
    .onConflictDoUpdate({
      target: [chatsTable.ownerPhone, chatsTable.phoneNumber],
      // No-op write to make ON CONFLICT return the row. Never re-set `isLid`
      // here — once a chat has been resolved to a real phone we must not
      // regress it back to LID on a subsequent stray message.
      set: { phoneNumber: sql`${chatsTable.phoneNumber}` },
    })
    .returning();
  return row;
}

async function generateAiReply(
  ownerPhone: string,
  chatId: number,
  userMessage: string
): Promise<string | null> {
  try {
    // Per-owner AI persona + knowledge base. Without this scoping the AI
    // would happily answer with another account's products and prompts.
    const settingsRows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.ownerPhone, ownerPhone))
      .limit(1);
    const settings = settingsRows[0];
    if (!settings?.autoReplyEnabled) return null;

    const knowledgeEntries = await db
      .select()
      .from(knowledgeTable)
      .where(eq(knowledgeTable.ownerPhone, ownerPhone));
    const knowledgeContext = knowledgeEntries
      .map((e) => `[${e.type.toUpperCase()}] ${e.title}:\n${e.content}`)
      .join("\n\n");

    const recentMessages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chatId))
      .limit(10);

    const history = recentMessages.map((m) => ({
      role: m.direction === "outbound" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    const systemPrompt = `${settings.systemPrompt}

ATURAN MUTLAK:
- HANYA gunakan informasi dari KNOWLEDGE BASE di bawah sebagai sumber kebenaran tentang produk, kategori, harga, dan layanan toko.
- Jika riwayat percakapan menyebut produk, kategori bisnis, atau bidang usaha yang TIDAK ADA di knowledge base saat ini, abaikan sepenuhnya dan jangan ulang. Knowledge base bisa berubah — anggap riwayat lama yang tidak konsisten dengan knowledge base saat ini sudah tidak berlaku.
- Jika pertanyaan customer berada di luar knowledge base, jawab dengan sopan bahwa admin akan membantu. Jangan menebak atau mengarang.

--- KNOWLEDGE BASE ---
${knowledgeContext || "Tidak ada knowledge base yang tersedia."}
--- END KNOWLEDGE BASE ---`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        { role: "user", content: userMessage },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });

    return response.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

interface IncomingMedia {
  mediaType: "image" | "video" | "document" | "audio" | "contact";
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
}

interface ParsedWaMessage {
  jid: string;
  isGroup: boolean;
  rawNumber: string;
  lidRawNumber: string | null;
  pushName: string;
  waMessageId: string | null;
  fromMe: boolean;
  timestamp: Date;
  messageContent: string;
  media?: IncomingMedia;
}

function toEpochMs(ts: unknown): number {
  if (typeof ts === "number") return ts * 1000;
  if (typeof ts === "bigint") return Number(ts) * 1000;
  if (ts && typeof ts === "object") {
    const anyTs = ts as { toNumber?: () => number; low?: number };
    if (typeof anyTs.toNumber === "function") return anyTs.toNumber() * 1000;
    if (typeof anyTs.low === "number") return anyTs.low * 1000;
  }
  return Date.now();
}

async function parseWaMessage(
  msg: any,
  isJidGroup: (jid: string) => boolean,
  downloadMediaMessage: any,
  downloadMedia: boolean,
  resolveGroupName?: (jid: string) => Promise<string | null>
): Promise<ParsedWaMessage | null> {
  if (!msg?.message) return null;
  const jid: string | undefined = msg.key?.remoteJid;
  if (!jid) return null;

  // Skip broadcasts, status, newsletters. Groups ARE persisted (mirroring
  // the user's WhatsApp client) but never auto-replied to.
  if (
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter") ||
    jid === "status@broadcast"
  ) {
    return null;
  }
  const isGroup = isJidGroup(jid);
  if (!isGroup && !jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return null;

  // Unwrap ephemeral / viewOnce
  let inner: any = msg.message;
  for (let i = 0; i < 5; i++) {
    const next =
      inner.ephemeralMessage?.message ||
      inner.viewOnceMessage?.message ||
      inner.viewOnceMessageV2?.message ||
      inner.viewOnceMessageV2Extension?.message;
    if (!next) break;
    inner = next;
  }

  // protocolMessage = edits/deletes/key changes — not real user content, skip
  if (inner.protocolMessage || inner.senderKeyDistributionMessage || inner.messageContextInfo) {
    // messageContextInfo alone (no payload) also has no content
    const onlyMeta =
      !inner.conversation &&
      !inner.extendedTextMessage &&
      !inner.imageMessage &&
      !inner.videoMessage &&
      !inner.audioMessage &&
      !inner.documentMessage &&
      !inner.stickerMessage &&
      !inner.locationMessage &&
      !inner.contactMessage;
    if (inner.protocolMessage || onlyMeta) return null;
  }

  // Reactions, pinned messages, polls votes — telemetry, not chat content
  if (inner.reactionMessage || inner.pollUpdateMessage) return null;

  let messageContent: string =
    inner.conversation ||
    inner.extendedTextMessage?.text ||
    inner.imageMessage?.caption ||
    inner.videoMessage?.caption ||
    inner.documentMessage?.caption ||
    inner.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    inner.buttonsMessage?.contentText ||
    inner.templateMessage?.hydratedTemplate?.hydratedContentText ||
    inner.listMessage?.description ||
    inner.interactiveMessage?.body?.text ||
    "";

  let media: IncomingMedia | undefined;
  let mediaKind: "image" | "video" | "document" | "audio" | null = null;
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;

  if (inner.imageMessage) {
    mediaKind = "image";
    mediaMime = inner.imageMessage.mimetype ?? "image/jpeg";
  } else if (inner.videoMessage) {
    mediaKind = "video";
    mediaMime = inner.videoMessage.mimetype ?? "video/mp4";
  } else if (inner.audioMessage) {
    mediaKind = "audio";
    mediaMime = inner.audioMessage.mimetype ?? "audio/ogg";
  } else if (inner.documentMessage) {
    mediaKind = "document";
    mediaMime = inner.documentMessage.mimetype ?? "application/octet-stream";
    mediaFilename = inner.documentMessage.fileName ?? null;
  } else if (inner.documentWithCaptionMessage?.message?.documentMessage) {
    mediaKind = "document";
    const doc = inner.documentWithCaptionMessage.message.documentMessage;
    mediaMime = doc.mimetype ?? "application/octet-stream";
    mediaFilename = doc.fileName ?? null;
  }

  if (mediaKind) {
    if (downloadMedia) {
      try {
        const buf = (await downloadMediaMessage(
          { ...msg, message: inner } as any,
          "buffer",
          {}
        )) as Buffer;
        const saved = await saveBufferToMedia(
          buf,
          mediaMime ?? "application/octet-stream",
          mediaFilename ?? undefined
        );
        media = {
          mediaType: mediaKind,
          mediaUrl: saved.url,
          mediaMimeType: mediaMime,
          mediaFilename: mediaFilename ?? saved.filename,
        };
      } catch (err) {
        logger.error({ err }, "Failed to download media");
        media = {
          mediaType: mediaKind,
          mediaUrl: null,
          mediaMimeType: mediaMime,
          mediaFilename,
        };
      }
    } else {
      // History sync: skip download to avoid hammering WA & filling disk
      media = {
        mediaType: mediaKind,
        mediaUrl: null,
        mediaMimeType: mediaMime,
        mediaFilename,
      };
    }
  } else if (inner.contactMessage || inner.contactsArrayMessage) {
    const contact = inner.contactMessage ?? inner.contactsArrayMessage?.contacts?.[0];
    const displayName = contact?.displayName ?? "Kontak";
    media = {
      mediaType: "contact",
      mediaUrl: null,
      mediaMimeType: "text/vcard",
      mediaFilename: displayName,
    };
  } else if (inner.stickerMessage) {
    // Stickers are images but use a placeholder so they appear in chat list
    if (!messageContent) messageContent = "🏷️ Stiker";
  } else if (inner.locationMessage || inner.liveLocationMessage) {
    const loc = inner.locationMessage ?? inner.liveLocationMessage;
    const name = loc?.name ? ` ${loc.name}` : "";
    if (!messageContent) messageContent = `📍 Lokasi${name}`;
  } else if (inner.pollCreationMessage || inner.pollCreationMessageV3) {
    const poll = inner.pollCreationMessage ?? inner.pollCreationMessageV3;
    if (!messageContent) messageContent = `📊 Polling: ${poll?.name ?? ""}`.trim();
  } else if (inner.groupInviteMessage) {
    if (!messageContent) messageContent = `👥 Undangan grup: ${inner.groupInviteMessage.groupName ?? ""}`.trim();
  } else if (inner.productMessage || inner.orderMessage) {
    if (!messageContent) messageContent = "🛒 Pesan produk/pesanan";
  }

  if (!messageContent.trim() && !media) {
    // Log unknown types once so we can extend later; only for live to avoid spam
    if (downloadMedia) {
      const keys = Object.keys(inner).slice(0, 5);
      logger.info({ keys, jid }, "skip: unrecognized message body");
    }
    return null;
  }

  let rawNumber: string;
  let lidRawNumber: string | null = null;
  let pushName: string;

  if (isGroup) {
    // For groups, rawNumber holds the JID id (the part before @g.us). It's
    // used as the numeric fallback display name and lets the contactName
    // self-heal logic detect a stale fallback name. The persist layer maps
    // this back to the full @g.us JID for the unique storage key.
    rawNumber = jid.split("@")[0];
    const groupName = resolveGroupName ? await resolveGroupName(jid) : null;
    pushName = groupName || rawNumber;
  } else {
    // Baileys 7.x uses LID addressing for new contacts: msg.key.remoteJid is
    // "<lid>@lid" and msg.key.remoteJidAlt carries the actual phone
    // "<pn>@s.whatsapp.net". Prefer the phone-side JID for deriving the
    // displayed number so chats appear under the user's real phone.
    const remoteJidAlt: string | undefined = msg.key?.remoteJidAlt;
    const phoneJid =
      jid.endsWith("@s.whatsapp.net")
        ? jid
        : remoteJidAlt?.endsWith("@s.whatsapp.net")
        ? remoteJidAlt
        : jid;
    rawNumber = phoneJid.split("@")[0].split(":")[0];
    lidRawNumber =
      jid.endsWith("@lid")
        ? jid.split("@")[0].split(":")[0]
        : remoteJidAlt?.endsWith("@lid")
        ? remoteJidAlt.split("@")[0].split(":")[0]
        : null;
    pushName = msg.pushName || rawNumber;
  }

  const waMessageId: string | null = msg.key?.id ?? null;
  const fromMe = !!msg.key?.fromMe;
  const timestamp = new Date(toEpochMs(msg.messageTimestamp));

  return {
    jid,
    isGroup,
    rawNumber,
    lidRawNumber,
    pushName,
    waMessageId,
    fromMe,
    timestamp,
    messageContent,
    media,
  };
}

function buildPreview(messageText: string, media?: IncomingMedia): string {
  if (messageText.trim().length) return messageText;
  if (!media) return "";
  switch (media.mediaType) {
    case "image": return "📷 Gambar";
    case "video": return "🎥 Video";
    case "audio": return "🎤 Audio";
    case "document": return `📄 ${media.mediaFilename ?? "Dokumen"}`;
    case "contact": return `👤 ${media.mediaFilename ?? "Kontak"}`;
    default: return "Media";
  }
}

async function persistWaMessage(
  ownerPhone: string,
  parsed: ParsedWaMessage,
  opts: { incrementUnread: boolean }
): Promise<{ chat: typeof chatsTable.$inferSelect; inserted: boolean }> {
  // DMs are stored as "+<phone>"; groups use the full "<id>@g.us" JID as the
  // unique key so they coexist with phone-keyed DMs in the same table.
  const phoneNumber = parsed.isGroup ? parsed.jid : `+${parsed.rawNumber}`;
  const contactName = parsed.pushName || parsed.rawNumber;

  // Heal pre-existing rows that were stored under the LID number (before we
  // learned to prefer remoteJidAlt). When the same conversation now resolves
  // to a real phone, merge messages from the LID-keyed chat into the canonical
  // phone-keyed chat (or rename if no canonical row exists yet). Run in a
  // transaction with row-level locks so concurrent ingestion can't race
  // between the merge update and the chat delete. Scoped to ownerPhone so
  // one account's LID heal can't touch another account's rows.
  if (!parsed.isGroup && parsed.lidRawNumber && parsed.lidRawNumber !== parsed.rawNumber) {
    const lidPhone = `+${parsed.lidRawNumber}`;
    await db.transaction(async (tx) => {
      // Lock both candidate rows in a deterministic order to avoid deadlocks.
      const candidates = await tx
        .select()
        .from(chatsTable)
        .where(
          sql`${chatsTable.ownerPhone} = ${ownerPhone}
              AND ${chatsTable.phoneNumber} IN (${lidPhone}, ${phoneNumber})`
        )
        .orderBy(chatsTable.phoneNumber)
        .for("update");

      const lidChat = candidates.find((c) => c.phoneNumber === lidPhone);
      if (!lidChat) return;
      const realChat = candidates.find((c) => c.phoneNumber === phoneNumber);

      if (realChat) {
        await tx
          .update(chatMessagesTable)
          .set({ chatId: realChat.id })
          .where(eq(chatMessagesTable.chatId, lidChat.id));
        await tx.delete(chatsTable).where(eq(chatsTable.id, lidChat.id));
        // Mark the surviving real chat as resolved (not LID).
        await tx
          .update(chatsTable)
          .set({ isLid: false })
          .where(eq(chatsTable.id, realChat.id));
        logger.info(
          { lidPhone, phoneNumber },
          "Merged stale LID-keyed chat into canonical phone chat"
        );
      } else {
        await tx
          .update(chatsTable)
          .set({ phoneNumber, contactName, isLid: false })
          .where(eq(chatsTable.id, lidChat.id));
        logger.info(
          { lidPhone, phoneNumber },
          "Renamed stale LID-keyed chat to canonical phone"
        );
      }
    });
  }

  // A chat is LID-only when the JID is "@lid" with no phone alt — we ended
  // up using the LID raw digits as the phone key because we have nothing
  // better. parseWaMessage signals this by setting rawNumber === lidRawNumber.
  const isLidChat =
    !parsed.isGroup &&
    parsed.lidRawNumber !== null &&
    parsed.lidRawNumber === parsed.rawNumber;
  const chat = await getOrCreateChat(ownerPhone, phoneNumber, contactName, { isLid: isLidChat });
  const direction = parsed.fromMe ? "outbound" : "inbound";

  let inserted = true;
  if (parsed.waMessageId) {
    const result = await db
      .insert(chatMessagesTable)
      .values({
        chatId: chat.id,
        direction,
        content: parsed.messageContent,
        isAiGenerated: false,
        mediaType: parsed.media?.mediaType ?? null,
        mediaUrl: parsed.media?.mediaUrl ?? null,
        mediaMimeType: parsed.media?.mediaMimeType ?? null,
        mediaFilename: parsed.media?.mediaFilename ?? null,
        waMessageId: parsed.waMessageId,
        createdAt: parsed.timestamp,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId })
      .returning({ id: chatMessagesTable.id });
    inserted = result.length > 0;
  } else {
    await db.insert(chatMessagesTable).values({
      chatId: chat.id,
      direction,
      content: parsed.messageContent,
      isAiGenerated: false,
      mediaType: parsed.media?.mediaType ?? null,
      mediaUrl: parsed.media?.mediaUrl ?? null,
      mediaMimeType: parsed.media?.mediaMimeType ?? null,
      mediaFilename: parsed.media?.mediaFilename ?? null,
      waMessageId: null,
      createdAt: parsed.timestamp,
    });
  }

  if (!inserted) return { chat, inserted };

  const preview = buildPreview(parsed.messageContent, parsed.media);

  // Atomic, race-safe aggregate update:
  // - lastMessage/lastMessageAt only overwrite if THIS message is newer
  //   than what's currently stored (handled SQL-side via CASE).
  // - unreadCount uses SQL increment so concurrent inserts don't lose counts.
  // - contactName fills in only when the existing name is still the bare
  //   phone number (i.e. we never got a real pushName before).
  const ts = parsed.timestamp;
  const updateSet: Record<string, unknown> = {
    lastMessage: sql`CASE WHEN ${chatsTable.lastMessageAt} IS NULL OR ${chatsTable.lastMessageAt} < ${ts} THEN ${preview} ELSE ${chatsTable.lastMessage} END`,
    lastMessageAt: sql`CASE WHEN ${chatsTable.lastMessageAt} IS NULL OR ${chatsTable.lastMessageAt} < ${ts} THEN ${ts} ELSE ${chatsTable.lastMessageAt} END`,
  };
  if (opts.incrementUnread && !parsed.fromMe) {
    updateSet.unreadCount = sql`${chatsTable.unreadCount} + 1`;
  }
  // Self-heal contactName when we initially stored the numeric fallback (raw
  // phone digits for DMs, or the JID id for groups) and a real name later
  // becomes available via pushName / groupMetadata.
  if (
    parsed.pushName &&
    parsed.pushName !== parsed.rawNumber &&
    (chat.contactName === parsed.rawNumber || !chat.contactName)
  ) {
    updateSet.contactName = sql`CASE WHEN ${chatsTable.contactName} = ${parsed.rawNumber} OR ${chatsTable.contactName} IS NULL THEN ${parsed.pushName} ELSE ${chatsTable.contactName} END`;
  }
  await db.update(chatsTable).set(updateSet).where(eq(chatsTable.id, chat.id));
  return { chat, inserted };
}

async function maybeTriggerAutoReply(
  ownerPhone: string,
  epoch: number,
  chat: typeof chatsTable.$inferSelect,
  jid: string,
  messageText: string
) {
  if (chat.isHumanTakeover) return;
  if (!messageText.trim()) return;

  const settingsRows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.ownerPhone, ownerPhone))
    .limit(1);
  const settings = settingsRows[0];
  if (!settings?.autoReplyEnabled) return;

  const delayMin = (settings.replyDelayMin ?? 1) * 1000;
  const delayMax = (settings.replyDelayMax ?? 3) * 1000;
  const delay = Math.random() * (delayMax - delayMin) + delayMin;

  setTimeout(async () => {
    try {
      // Cross-session safety: if /disconnect (epoch bump) or owner change has
      // happened during the delay, abort. Without this, a delayed reply for
      // owner A could be sent through owner B's active socket and persisted
      // under owner A's chat row.
      if (epoch !== sessionEpoch) return;
      if (currentOwnerPhone !== ownerPhone) return;

      const aiReply = await generateAiReply(ownerPhone, chat.id, messageText);
      const replyText = aiReply ?? settings.fallbackMessage;

      // Re-check after the async AI call — same reasons as above.
      if (epoch !== sessionEpoch) return;
      if (currentOwnerPhone !== ownerPhone) return;

      if (sock && replyText) {
        const sent = await sock.sendMessage(jid, { text: replyText });

        // Owner-atomic writes: every mutation includes owner_phone in the
        // WHERE so even a stray late callback can't touch another account.
        await db
          .insert(chatMessagesTable)
          .values({
            chatId: chat.id,
            direction: "outbound",
            content: replyText,
            isAiGenerated: !!aiReply,
            waMessageId: sent?.key?.id ?? null,
          })
          .onConflictDoNothing({ target: chatMessagesTable.waMessageId });

        await db
          .update(chatsTable)
          .set({
            lastMessage: replyText,
            lastMessageAt: new Date(),
            status: "ai_handled",
          })
          .where(
            sql`${chatsTable.id} = ${chat.id} AND ${chatsTable.ownerPhone} = ${ownerPhone}`
          );
      }
    } catch (err) {
      logger.error({ err }, "Auto-reply failed");
    }
  }, delay);
}

async function startBaileys(sessionId: number) {
  if (isConnecting || (sock && (sock as any).ws?.readyState === 1)) return;
  isConnecting = true;
  const myEpoch = ++sessionEpoch;

  try {
    const {
      useMultiFileAuthState,
      makeWASocket,
      DisconnectReason,
      isJidGroup,
    } = await import("@whiskeysockets/baileys");

    const { Boom } = await import("@hapi/boom");
    const { default: NodeCache } = await import("node-cache");

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const msgRetryCounterCache = new NodeCache();

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      msgRetryCounterCache,
      logger: (await import("pino")).default({ level: "warn" }),
      // Pull historical chats & messages on initial connect so the dashboard
      // mirrors the user's phone, not just messages received while online.
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
        await setStatus(sessionId, "qr_ready", { qrCode: dataUrl });
      }

      if (connection === "open") {
        const rawId = sock?.user?.id ?? null;
        const phoneNumber = rawId?.split(":")[0] ?? null;
        // Cache the digits-only owner phone for cheap per-request scoping.
        currentOwnerPhone = normalizeOwnerPhone(phoneNumber);
        await setStatus(sessionId, "connected", {
          qrCode: null,
          phoneNumber,
          connectedAt: new Date(),
        });
        isConnecting = false;
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        await setStatus(sessionId, "disconnected", {
          qrCode: null,
          phoneNumber: null,
          connectedAt: null,
        });
        sock = null;
        isConnecting = false;
        currentOwnerPhone = null;
        if (shouldReconnect) {
          setTimeout(() => startBaileys(sessionId), 3000);
        }
      }
    });

    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");

    // Cache group subjects (network call to WhatsApp; cheap once cached).
    const groupNameCache = new Map<string, string>();
    const resolveGroupName = async (jid: string): Promise<string | null> => {
      if (groupNameCache.has(jid)) return groupNameCache.get(jid) ?? null;
      try {
        const meta = await sock?.groupMetadata(jid);
        const name = meta?.subject ?? null;
        if (name) groupNameCache.set(jid, name);
        return name;
      } catch {
        return null;
      }
    };

    // Live messages — full processing including media download + AI auto-reply
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (myEpoch !== sessionEpoch) return; // stale handler after disconnect
      // Snapshot owner phone: the account that owns these messages is whichever
      // account is currently linked. Skip if we somehow get a message before
      // connection.open has set it (shouldn't happen, but defensive).
      const ownerPhone = currentOwnerPhone;
      if (!ownerPhone) return;
      logger.info(
        { type, count: messages.length, jids: messages.map((m) => m.key.remoteJid) },
        "messages.upsert received"
      );
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        try {
          // Re-check epoch on every iteration: a long backlog must not keep
          // writing (and re-creating chats) after /disconnect bumps the epoch.
          if (myEpoch !== sessionEpoch) return;
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            true,
            resolveGroupName
          );
          if (!parsed) continue;
          if (myEpoch !== sessionEpoch) return;

          const { chat, inserted } = await persistWaMessage(ownerPhone, parsed, {
            incrementUnread: true,
          });
          if (!inserted) continue;
          if (parsed.fromMe) continue;
          // Never auto-reply in groups — too noisy and unsolicited.
          if (parsed.isGroup) continue;

          await maybeTriggerAutoReply(ownerPhone, myEpoch, chat, parsed.jid, parsed.messageContent);
        } catch (err) {
          logger.error({ err }, "Failed to process incoming message");
        }
      }
    });

    // Historical sync — chat list + past messages from the user's phone.
    // Fires (potentially multiple times) right after pairing while WA pushes
    // the backlog. We persist without downloading media and without firing AI
    // replies, so the dashboard mirrors the phone without side effects.
    sock.ev.on("messaging-history.set", async (payload) => {
      if (myEpoch !== sessionEpoch) return; // stale handler after disconnect
      const ownerPhone = currentOwnerPhone;
      if (!ownerPhone) return;
      const { chats = [], messages = [], isLatest, syncType } = payload as {
        chats?: Array<{ id: string; name?: string | null }>;
        messages?: any[];
        isLatest?: boolean;
        syncType?: number;
      };
      logger.info(
        { chats: chats.length, messages: messages.length, isLatest, syncType },
        "messaging-history.set received"
      );

      // Pre-create chat rows from the chat list so empty chats still appear.
      for (const c of chats) {
        try {
          if (!c?.id) continue;
          if (
            c.id.endsWith("@broadcast") ||
            c.id.endsWith("@newsletter") ||
            c.id === "status@broadcast"
          )
            continue;
          const isGroup = (isJidGroup as (j: string) => boolean)(c.id);
          let key: string;
          if (isGroup) {
            // Groups: store full @g.us JID as key, group subject as name.
            const groupName =
              c.name?.trim() || (await resolveGroupName(c.id)) || c.id.split("@")[0];
            await getOrCreateChat(ownerPhone, c.id, groupName);
            key = c.id;
          } else {
            // Only seed canonical phone-number DMs. LID-only entries from the
            // history list have no phone mapping here; they'll be created with
            // the real phone once a live message arrives (which carries remoteJidAlt).
            if (!c.id.endsWith("@s.whatsapp.net")) continue;
            const rawNumber = c.id.split("@")[0].split(":")[0];
            const phoneNumber = `+${rawNumber}`;
            const contactName = c.name?.trim() || rawNumber;
            await getOrCreateChat(ownerPhone, phoneNumber, contactName);
            key = phoneNumber;
          }
          await applyChatListMeta(ownerPhone, key, c);
        } catch (err) {
          logger.error({ err, chatId: c?.id }, "Failed to seed history chat");
        }
      }

      let ingested = 0;
      for (const msg of messages) {
        try {
          // Backlog can be tens of thousands of messages; abort the loop if
          // the session was disconnected mid-sync.
          if (myEpoch !== sessionEpoch) return;
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            false,
            resolveGroupName
          );
          if (!parsed) continue;
          if (myEpoch !== sessionEpoch) return;
          const { inserted } = await persistWaMessage(ownerPhone, parsed, {
            incrementUnread: false,
          });
          if (inserted) ingested++;
        } catch (err) {
          logger.error({ err }, "Failed to ingest history message");
        }
      }
      logger.info({ ingested }, "messaging-history.set done");
    });

    // Contacts metadata — populates verified/business name (nickname) and
    // refines contactName from the user's saved phonebook entry. Fires during
    // initial sync and whenever WA updates contact info.
    const handleContacts = async (
      contacts: Array<{
        id?: string;
        name?: string | null;
        notify?: string | null;
        verifiedName?: string | null;
      }>
    ) => {
      if (myEpoch !== sessionEpoch) return;
      const ownerPhone = currentOwnerPhone;
      if (!ownerPhone) return;
      for (const c of contacts) {
        try {
          if (!c?.id) continue;
          // Only canonical phone-number contacts; LID-only contacts can't be
          // mapped to a chat phoneNumber here.
          if (!c.id.endsWith("@s.whatsapp.net")) continue;
          const rawNumber = c.id.split("@")[0].split(":")[0];
          const phoneNumber = `+${rawNumber}`;
          const savedName = c.name?.trim() || null;
          const verifiedName = c.verifiedName?.trim() || null;
          const pushName = c.notify?.trim() || null;

          const updateSet: Record<string, unknown> = {};
          // Only touch nickname when WA explicitly sent the field. A truthy
          // value sets it; an explicit null/empty clears any stale business
          // name. Missing key → leave the column as-is.
          if (Object.prototype.hasOwnProperty.call(c, "verifiedName")) {
            updateSet.nickname = verifiedName;
          }
          // Prefer saved phonebook name; fall back to pushName when current
          // contactName is still the bare phone-number fallback.
          const preferredName = savedName || pushName;
          if (preferredName) {
            updateSet.contactName = sql`CASE
              WHEN ${chatsTable.contactName} = ${rawNumber}
                OR ${chatsTable.contactName} = ${phoneNumber}
                OR ${chatsTable.contactName} IS NULL
              THEN ${preferredName}
              ELSE ${chatsTable.contactName}
            END`;
          }
          if (Object.keys(updateSet).length === 0) continue;
          await db
            .update(chatsTable)
            .set(updateSet)
            .where(
              sql`${chatsTable.ownerPhone} = ${ownerPhone} AND ${chatsTable.phoneNumber} = ${phoneNumber}`
            );
        } catch (err) {
          logger.error({ err, id: c?.id }, "Failed to apply contact update");
        }
      }
    };
    sock.ev.on("contacts.upsert", handleContacts);
    sock.ev.on("contacts.update", handleContacts);

    // Chat-level metadata (pin / archive). Pin status drives sort order in
    // the UI, so we mirror it from WhatsApp.
    const keyForChatId = (id: string): string | null => {
      if (id.endsWith("@g.us")) return id;
      if (id.endsWith("@s.whatsapp.net")) {
        return `+${id.split("@")[0].split(":")[0]}`;
      }
      return null;
    };
    const handleChatMeta = async (updates: Array<{ id?: string } & Record<string, unknown>>) => {
      if (myEpoch !== sessionEpoch) return;
      const ownerPhone = currentOwnerPhone;
      if (!ownerPhone) return;
      for (const c of updates) {
        try {
          if (!c?.id) continue;
          const key = keyForChatId(c.id);
          if (!key) continue;
          await applyChatListMeta(ownerPhone, key, c);
        } catch (err) {
          logger.error({ err, id: c?.id }, "Failed to apply chat metadata");
        }
      }
    };
    sock.ev.on("chats.upsert", handleChatMeta);
    sock.ev.on("chats.update", handleChatMeta);
  } catch (err) {
    isConnecting = false;
    await setStatus(sessionId, "disconnected");
    throw err;
  }
}

export async function initWhatsapp() {
  try {
    // One-shot backfill for chats stored with a LID raw number as the phone
    // key (pre-`is_lid` data). Heuristic: DM (not "@g.us"), digit count > 15
    // (E.164 max is 15 — anything longer cannot be a real phone), and
    // contactName is still the bare digits — i.e. we never got a real
    // pushName/verifiedName. Also re-clear is_lid for rows that no longer
    // look like LIDs (e.g. someone got a real name) so the flag self-heals.
    // Safe to re-run; idempotent.
    try {
      const setRes = await db.execute(sql`
        UPDATE chats
           SET is_lid = TRUE
         WHERE is_lid = FALSE
           AND phone_number NOT LIKE '%@g.us'
           AND LENGTH(REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g')) >= 15
           AND (contact_name = SUBSTRING(phone_number FROM 2) OR contact_name IS NULL)
      `);
      // Clear is_lid when the row no longer matches the LID profile. True
      // inverse of the SET predicate so the column is fully self-healing:
      // any row that has since acquired a real contact_name (or has a
      // nickname, or is a group, or has a normal-length phone) gets cleared.
      const clearRes = await db.execute(sql`
        UPDATE chats
           SET is_lid = FALSE
         WHERE is_lid = TRUE
           AND (
             phone_number LIKE '%@g.us'
             OR LENGTH(REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g')) < 15
             OR (
               contact_name IS NOT NULL
               AND contact_name <> SUBSTRING(phone_number FROM 2)
             )
             OR nickname IS NOT NULL
           )
      `);
      logger.info(
        { set: (setRes as any).rowCount ?? null, cleared: (clearRes as any).rowCount ?? null },
        "is_lid backfill done"
      );
    } catch (err) {
      logger.warn({ err }, "is_lid backfill failed (non-fatal)");
    }

    const session = await getOrCreateSession();
    if (session.status === "connected" || session.status === "connecting" || session.status === "qr_ready") {
      await setStatus(session.id, "connecting");
      startBaileys(session.id).catch(() => {});
    }
  } catch {
  }
}

const router = Router();

router.get("/status", async (req, res) => {
  try {
    const session = await getOrCreateSession();
    res.json({
      status: session.status,
      qrCode: session.qrCode ?? null,
      phoneNumber: session.phoneNumber ?? null,
      connectedAt: session.connectedAt?.toISOString() ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get WhatsApp status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/connect", async (req, res) => {
  try {
    const session = await getOrCreateSession();
    if (session.status === "connected") {
      return res.json({
        status: session.status,
        qrCode: null,
        phoneNumber: session.phoneNumber ?? null,
        connectedAt: session.connectedAt?.toISOString() ?? null,
      });
    }
    await setStatus(session.id, "connecting");
    startBaileys(session.id).catch((err) =>
      req.log.error({ err }, "Baileys start failed")
    );
    res.json({ status: "connecting", qrCode: null, phoneNumber: null, connectedAt: null });
  } catch (err) {
    req.log.error({ err }, "Failed to connect WhatsApp");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/disconnect", async (req, res) => {
  try {
    // Bump epoch FIRST so any in-flight handler callbacks abort before they
    // try to persist into chats we're about to clear.
    sessionEpoch++;
    if (sock) {
      try {
        sock.ev.removeAllListeners("messages.upsert");
        sock.ev.removeAllListeners("messaging-history.set");
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("contacts.upsert");
        sock.ev.removeAllListeners("contacts.update");
        sock.ev.removeAllListeners("chats.upsert");
        sock.ev.removeAllListeners("chats.update");
      } catch {}
      await sock.logout().catch(() => {});
      sock = null;
    }
    isConnecting = false;
    // Wipe local auth credentials so the next /connect starts a fresh
    // pairing flow (QR code). Without this, useMultiFileAuthState reads the
    // now-invalidated creds.json and WhatsApp immediately rejects with
    // DisconnectReason.loggedOut — so no QR is ever generated.
    await fs.rm(AUTH_DIR, { recursive: true, force: true }).catch((err) => {
      req.log.warn({ err }, "Failed to wipe WhatsApp auth dir");
    });
    // Per-phone isolation: do NOT delete chats. Each chat row is scoped by
    // owner_phone, so once we clear the connected phone below the dashboard
    // returns an empty list anyway. When the SAME number scans QR again,
    // its history reappears; a DIFFERENT number sees its own clean slate
    // and won't ever see the previous owner's messages.
    currentOwnerPhone = null;
    const session = await getOrCreateSession();
    const updated = await setStatus(session.id, "disconnected", {
      qrCode: null,
      phoneNumber: null,
      connectedAt: null,
    });
    res.json({ status: updated.status, qrCode: null, phoneNumber: null, connectedAt: null });
  } catch (err) {
    req.log.error({ err }, "Failed to disconnect WhatsApp");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
