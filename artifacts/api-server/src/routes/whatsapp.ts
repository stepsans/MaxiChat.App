import { Router, type Request } from "express";
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
  whatsappStatusesTable,
  chatbotFlowsTable,
  productsTable,
  type FlowGraph,
  type FlowNode,
} from "@workspace/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "../lib/logger";
import {
  getOwnerPhoneForUser,
  setOwnerPhoneForUser,
} from "../lib/seed";

const AUTH_ROOT = path.join(process.cwd(), ".whatsapp-auth");
export const MEDIA_DIR = path.join(process.cwd(), "media");

// Per-user auth state dir. Pairing creds live here; wiping the dir forces a
// fresh QR pairing. Kept under one root so we can scope IO per user without
// re-architecting Baileys' file-based auth helpers.
function authDirForUser(userId: number): string {
  return path.join(AUTH_ROOT, String(userId));
}

type WASocket = Awaited<ReturnType<typeof makeWASocketType>>;

// Everything that used to be module-level singleton state (`sock`,
// `isConnecting`, `sessionEpoch`, `currentOwnerPhone`) is now per-user so
// every signed-in account can hold its OWN live WhatsApp connection in
// parallel without the accounts crossing wires.
interface UserCtx {
  sock: WASocket | null;
  isConnecting: boolean;
  // Bumped on disconnect/reset. Event handlers capture the epoch at attach
  // time and refuse to persist if the per-user epoch has moved on — this
  // prevents stale in-flight messages.upsert / messaging-history.set
  // callbacks from a torn-down socket reinserting chats after /disconnect.
  epoch: number;
  // Digits-only phone of THIS user's currently linked WA account.
  ownerPhone: string | null;
}

const userCtxs = new Map<number, UserCtx>();

function getCtx(userId: number): UserCtx {
  let c = userCtxs.get(userId);
  if (!c) {
    c = { sock: null, isConnecting: false, epoch: 0, ownerPhone: null };
    userCtxs.set(userId, c);
  }
  return c;
}

// Convenience for route handlers — session middleware guarantees userId is set.
function requireUserId(req: Request): number {
  const id = req.session?.userId;
  if (typeof id !== "number") {
    throw new Error("Unauthenticated request reached WhatsApp router");
  }
  return id;
}

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

export function getActiveSocket(userId: number): WASocket | null {
  return getCtx(userId).sock;
}

// Baileys' sock.user.id looks like "628111…:7@s.whatsapp.net" — strip every
// non-digit to canonicalise. Returns null for empty / null input.
function normalizeOwnerPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/[^0-9]/g, "");
  return digits.length ? digits : null;
}

/**
 * Returns the digits-only phone number of the WhatsApp account currently
 * linked by `userId`, or null if that user has not paired yet. Source of
 * truth is the `user_whatsapp` mapping table (persisted on first pairing);
 * we cache it on the in-memory ctx to keep the hot path off the DB.
 */
export async function getCurrentOwnerPhone(
  userId: number
): Promise<string | null> {
  const ctx = getCtx(userId);
  if (ctx.ownerPhone) return ctx.ownerPhone;
  const phone = await getOwnerPhoneForUser(userId);
  if (phone) ctx.ownerPhone = phone;
  return phone;
}

// Fetch a contact's WhatsApp profile picture URL via Baileys and cache it on
// the chat row. WA URLs are short-lived (token-signed S3-style), so we
// re-check at most once per 6 hours per chat to keep avatars fresh while
// avoiding rate limits. Errors are swallowed because a missing picture is
// expected (privacy setting / unknown contact) and must never break message
// ingestion or the chat list UI.
const PROFILE_PIC_TTL_MS = 6 * 60 * 60 * 1000;
const profilePicInFlight = new Set<number>();

export async function refreshChatProfilePic(
  userId: number,
  chat: {
    id: number;
    ownerPhone: string;
    phoneNumber: string;
    profilePicCheckedAt: Date | null;
  },
  opts: { force?: boolean } = {}
): Promise<string | null> {
  const ctx = getCtx(userId);
  if (!ctx.sock) return null;
  if (profilePicInFlight.has(chat.id)) return null;
  if (
    !opts.force &&
    chat.profilePicCheckedAt &&
    Date.now() - chat.profilePicCheckedAt.getTime() < PROFILE_PIC_TTL_MS
  ) {
    return null;
  }
  // Re-verify that the chat still belongs to the currently-connected account
  // for this user before talking to Baileys. Prevents a refresh task spawned
  // under account A from running its network call once the user has paired B.
  if (!ctx.ownerPhone || ctx.ownerPhone !== chat.ownerPhone) return null;

  // Reconstruct a JID from our stored phone number. Group rows already store
  // the full "<id>@g.us" JID; DMs store "+<digits>".
  let jid: string;
  if (chat.phoneNumber.endsWith("@g.us") || chat.phoneNumber.includes("@")) {
    jid = chat.phoneNumber;
  } else {
    const digits = chat.phoneNumber.replace(/[^\d]/g, "");
    if (!digits) return null;
    jid = `${digits}@s.whatsapp.net`;
  }
  profilePicInFlight.add(chat.id);
  try {
    const url = (await ctx.sock.profilePictureUrl(jid, "image").catch(() => null)) ?? null;
    // Owner-atomic write: the WHERE clause re-checks ownerPhone so a refresh
    // task started under the old account can never overwrite a row that has
    // since been reassigned to a different ownerPhone.
    await db
      .update(chatsTable)
      .set({ profilePicUrl: url, profilePicCheckedAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${chat.id} AND ${chatsTable.ownerPhone} = ${chat.ownerPhone}`
      );
    return url;
  } catch {
    // Mark as checked even on failure so we don't spam Baileys with retries.
    await db
      .update(chatsTable)
      .set({ profilePicCheckedAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${chat.id} AND ${chatsTable.ownerPhone} = ${chat.ownerPhone}`
      )
      .catch(() => {});
    return null;
  } finally {
    profilePicInFlight.delete(chat.id);
  }
}

export async function sendMediaToJid(
  userId: number,
  jid: string,
  filepath: string,
  mimeType: string,
  mediaType: "image" | "video" | "document" | "audio",
  caption?: string,
  filename?: string
): Promise<string | null> {
  const sock = getCtx(userId).sock;
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

// ───────────────────────────────────────────────────────────────────────────
// WhatsApp Status (Stories) — persistence + posting
// ───────────────────────────────────────────────────────────────────────────

const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

// Parse and persist an incoming status broadcast. Called from messages.upsert
// when key.remoteJid === "status@broadcast". ownerJid is passed in (rather
// than read from the singleton sock) so we keep this helper independent of
// any per-user state.
async function persistWaStatus(
  ownerPhone: string,
  ownerJid: string,
  msg: any,
  downloadMediaMessage: any,
  downloadMedia: boolean
): Promise<void> {
  if (!msg?.message) return;
  // participant is the actual author for status broadcasts
  const authorJid: string | undefined = msg.key?.participant ?? msg.participant;
  const fromMe = !!msg.key?.fromMe;
  if (!authorJid && !fromMe) return;
  const effectiveAuthorJid = authorJid ?? ownerJid;
  const authorPhoneDigits = effectiveAuthorJid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
  if (!authorPhoneDigits) return;

  // Unwrap ephemeral wrappers (status messages are almost always ephemeral).
  let inner: any = msg.message;
  for (let i = 0; i < 5; i++) {
    const next =
      inner.ephemeralMessage?.message ||
      inner.viewOnceMessage?.message ||
      inner.viewOnceMessageV2?.message;
    if (!next) break;
    inner = next;
  }

  if (inner.protocolMessage || inner.reactionMessage) return;

  // Classify the status into text / image / video.
  let statusType: "text" | "image" | "video" | null = null;
  let textContent: string | null = null;
  let backgroundColor: string | null = null;
  let mediaMime: string | null = null;
  let mediaKind: "image" | "video" | null = null;
  let caption: string | null = null;

  if (inner.extendedTextMessage) {
    statusType = "text";
    textContent = inner.extendedTextMessage.text ?? "";
    const bgColor = inner.extendedTextMessage.backgroundArgb;
    if (typeof bgColor === "number") {
      const r = (bgColor >> 16) & 0xff;
      const g = (bgColor >> 8) & 0xff;
      const b = bgColor & 0xff;
      backgroundColor = `#${[r, g, b]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("")}`;
    }
  } else if (inner.conversation) {
    statusType = "text";
    textContent = inner.conversation;
  } else if (inner.imageMessage) {
    statusType = "image";
    mediaKind = "image";
    mediaMime = inner.imageMessage.mimetype ?? "image/jpeg";
    caption = inner.imageMessage.caption ?? null;
  } else if (inner.videoMessage) {
    statusType = "video";
    mediaKind = "video";
    mediaMime = inner.videoMessage.mimetype ?? "video/mp4";
    caption = inner.videoMessage.caption ?? null;
  } else {
    return;
  }

  let mediaUrl: string | null = null;
  if (mediaKind && downloadMedia) {
    try {
      const buf = (await downloadMediaMessage(
        { ...msg, message: inner } as any,
        "buffer",
        {}
      )) as Buffer;
      const saved = await saveBufferToMedia(
        buf,
        mediaMime ?? "application/octet-stream"
      );
      mediaUrl = saved.url;
    } catch (err) {
      logger.error({ err }, "Failed to download status media");
    }
  }

  let authorName = msg.pushName?.trim() || "";
  if (!authorName) {
    const rows = await db
      .select({ contactName: chatsTable.contactName, nickname: chatsTable.nickname })
      .from(chatsTable)
      .where(
        sql`${chatsTable.ownerPhone} = ${ownerPhone} AND ${chatsTable.phoneNumber} = ${"+" + authorPhoneDigits}`
      )
      .limit(1);
    authorName = rows[0]?.nickname ?? rows[0]?.contactName ?? authorPhoneDigits;
  }

  const postedAt = new Date(toEpochMs(msg.messageTimestamp));
  const expiresAt = new Date(postedAt.getTime() + STATUS_TTL_MS);
  const waMessageId: string | null = msg.key?.id ?? null;

  await db
    .insert(whatsappStatusesTable)
    .values({
      ownerPhone,
      authorJid: effectiveAuthorJid,
      authorPhone: authorPhoneDigits,
      authorName,
      statusType,
      textContent,
      backgroundColor,
      mediaUrl,
      mediaMimeType: mediaMime,
      caption,
      waMessageId,
      isMine: fromMe,
      postedAt,
      expiresAt,
    })
    .onConflictDoNothing({
      target: [whatsappStatusesTable.ownerPhone, whatsappStatusesTable.waMessageId],
    });
}

// Post a text status broadcast from the connected account.
export async function postTextStatus(
  userId: number,
  ownerPhone: string,
  text: string,
  backgroundColor: string
): Promise<typeof whatsappStatusesTable.$inferSelect> {
  const sock = getCtx(userId).sock;
  if (!sock) throw new Error("WhatsApp is not connected");
  const dmChats = await db
    .select({ phoneNumber: chatsTable.phoneNumber })
    .from(chatsTable)
    .where(
      sql`${chatsTable.ownerPhone} = ${ownerPhone}
          AND ${chatsTable.phoneNumber} NOT LIKE '%@g.us'`
    );
  const statusJidList = dmChats
    .map((c) => c.phoneNumber.replace(/^\+/, "").replace(/[^0-9]/g, ""))
    .filter((d) => d.length >= 7)
    .map((d) => `${d}@s.whatsapp.net`);

  const hex = backgroundColor.replace(/^#/, "");
  const argb =
    hex.length === 6
      ? (0xff << 24) |
        (parseInt(hex.slice(0, 2), 16) << 16) |
        (parseInt(hex.slice(2, 4), 16) << 8) |
        parseInt(hex.slice(4, 6), 16)
      : 0xff128c7e;

  const sent = await sock.sendMessage(
    "status@broadcast",
    {
      text,
      backgroundColor: argb,
      font: 0,
    } as any,
    { statusJidList } as any
  );
  const ownerJid = sock.user?.id ?? `${ownerPhone}@s.whatsapp.net`;
  const ownerDigits = ownerJid.split("@")[0].split(":")[0].replace(/[^0-9]/g, "");
  const postedAt = new Date();
  const waMessageId = sent?.key?.id ?? null;
  const inserted = await db
    .insert(whatsappStatusesTable)
    .values({
      ownerPhone,
      authorJid: ownerJid,
      authorPhone: ownerDigits,
      authorName: "Saya",
      statusType: "text",
      textContent: text,
      backgroundColor,
      mediaUrl: null,
      mediaMimeType: null,
      caption: null,
      waMessageId,
      isMine: true,
      postedAt,
      expiresAt: new Date(postedAt.getTime() + STATUS_TTL_MS),
    })
    .onConflictDoNothing({
      target: [whatsappStatusesTable.ownerPhone, whatsappStatusesTable.waMessageId],
    })
    .returning();
  if (inserted[0]) return inserted[0];
  if (waMessageId) {
    const existing = await db
      .select()
      .from(whatsappStatusesTable)
      .where(
        sql`${whatsappStatusesTable.ownerPhone} = ${ownerPhone}
            AND ${whatsappStatusesTable.waMessageId} = ${waMessageId}`
      )
      .limit(1);
    if (existing[0]) return existing[0];
  }
  throw new Error("Status sent but local row could not be persisted");
}

// Bio / About — fetch own and update own.
export async function fetchOwnBio(
  userId: number
): Promise<{ bio: string | null; setAt: string | null }> {
  const sock = getCtx(userId).sock;
  if (!sock) throw new Error("WhatsApp is not connected");
  const ownerJid = sock.user?.id;
  if (!ownerJid) throw new Error("WhatsApp user not available");
  try {
    const result = (await (sock as any).fetchStatus(ownerJid)) as
      | { status?: string | null; setAt?: Date | string | null }
      | Array<{ status?: { status?: string | null; setAt?: Date | string | null } }>
      | null;
    let normalised: { status?: string | null; setAt?: Date | string | null } | null = null;
    if (Array.isArray(result)) {
      normalised = result[0]?.status ?? null;
    } else {
      normalised = result;
    }
    const bio = normalised?.status ?? null;
    const setAtRaw = normalised?.setAt ?? null;
    const setAt =
      setAtRaw instanceof Date
        ? setAtRaw.toISOString()
        : typeof setAtRaw === "string"
          ? setAtRaw
          : null;
    return { bio, setAt };
  } catch (err) {
    logger.warn({ err }, "fetchOwnBio failed");
    return { bio: null, setAt: null };
  }
}

export async function updateOwnBio(
  userId: number,
  text: string
): Promise<{ bio: string; setAt: string }> {
  const sock = getCtx(userId).sock;
  if (!sock) throw new Error("WhatsApp is not connected");
  await (sock as any).updateProfileStatus(text);
  return { bio: text, setAt: new Date().toISOString() };
}

export async function sendContactToJid(
  userId: number,
  jid: string,
  contactName: string,
  contactPhone: string
): Promise<string | null> {
  const sock = getCtx(userId).sock;
  if (!sock) throw new Error("WhatsApp is not connected");
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

// Fetch (or lazily create) this user's whatsapp_session row. One row per
// user is enforced by the unique index installed in seed.ts
// (`whatsapp_session_user_id_key`). We use an atomic upsert so concurrent
// callers (e.g. /connect + /status polling on first login) can't race into
// duplicate rows. `onConflictDoUpdate` with a no-op SET is required because
// `onConflictDoNothing` returns no row when there's a conflict.
async function getOrCreateSession(userId: number) {
  const [row] = await db
    .insert(whatsappSessionTable)
    .values({ userId, status: "disconnected" })
    .onConflictDoUpdate({
      target: whatsappSessionTable.userId,
      set: { userId },
    })
    .returning();
  return row;
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

// Extracts pin/archive metadata from a Baileys chat object.
function extractChatListMeta(
  c: Record<string, unknown>
): { pinnedAt?: Date | null; isArchived?: boolean } {
  const meta: { pinnedAt?: Date | null; isArchived?: boolean } = {};
  if (Object.prototype.hasOwnProperty.call(c, "pinned")) {
    const p = (c as { pinned?: unknown }).pinned;
    if (typeof p === "number" && p > 0) {
      meta.pinnedAt = new Date(p * 1000);
    } else if (p === 0 || p === null) {
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

  if (
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter") ||
    jid === "status@broadcast"
  ) {
    return null;
  }
  const isGroup = isJidGroup(jid);
  if (!isGroup && !jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return null;

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

  if (inner.protocolMessage || inner.senderKeyDistributionMessage || inner.messageContextInfo) {
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
    rawNumber = jid.split("@")[0];
    const groupName = resolveGroupName ? await resolveGroupName(jid) : null;
    pushName = groupName || rawNumber;
  } else {
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
  userId: number,
  ownerPhone: string,
  parsed: ParsedWaMessage,
  opts: { incrementUnread: boolean }
): Promise<{ chat: typeof chatsTable.$inferSelect; inserted: boolean }> {
  const phoneNumber = parsed.isGroup ? parsed.jid : `+${parsed.rawNumber}`;
  const contactName = parsed.pushName || parsed.rawNumber;

  if (!parsed.isGroup && parsed.lidRawNumber && parsed.lidRawNumber !== parsed.rawNumber) {
    const lidPhone = `+${parsed.lidRawNumber}`;
    await db.transaction(async (tx) => {
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

  const ts = parsed.timestamp;
  const updateSet: Record<string, unknown> = {
    lastMessage: sql`CASE WHEN ${chatsTable.lastMessageAt} IS NULL OR ${chatsTable.lastMessageAt} < ${ts} THEN ${preview} ELSE ${chatsTable.lastMessage} END`,
    lastMessageAt: sql`CASE WHEN ${chatsTable.lastMessageAt} IS NULL OR ${chatsTable.lastMessageAt} < ${ts} THEN ${ts} ELSE ${chatsTable.lastMessageAt} END`,
  };
  if (opts.incrementUnread && !parsed.fromMe) {
    updateSet.unreadCount = sql`${chatsTable.unreadCount} + 1`;
  }
  if (
    parsed.pushName &&
    parsed.pushName !== parsed.rawNumber &&
    (chat.contactName === parsed.rawNumber || !chat.contactName)
  ) {
    updateSet.contactName = sql`CASE WHEN ${chatsTable.contactName} = ${parsed.rawNumber} OR ${chatsTable.contactName} IS NULL THEN ${parsed.pushName} ELSE ${chatsTable.contactName} END`;
  }
  await db.update(chatsTable).set(updateSet).where(eq(chatsTable.id, chat.id));

  // Lazily refresh profile picture in the background via THIS user's socket.
  void refreshChatProfilePic(userId, chat).catch(() => {});

  return { chat, inserted };
}

// ---------- Chatbot flow engine ----------

function renderQuestion(node: FlowNode): string {
  const lines: string[] = [];
  if (node.data.text) lines.push(node.data.text);
  const opts = node.data.options ?? [];
  opts.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
  return lines.join("\n");
}

function pickOption(node: FlowNode, text: string): string | null {
  const opts = node.data.options ?? [];
  if (opts.length === 0) return null;
  const trimmed = text.trim().toLowerCase();
  // Numeric pick: "1", "2", ... — accept leading number even with trailing
  // punctuation like "1." or "1)" but NOT a number embedded in a sentence.
  const numMatch = trimmed.match(/^(\d+)\s*[.)]?\s*$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]!, 10) - 1;
    if (idx >= 0 && idx < opts.length) return opts[idx]!.id;
  }
  // Exact label match (case-insensitive). Substring matching is intentionally
  // avoided so natural-language questions like "ada berapa macam mesin
  // laminating?" are NOT treated as picking the "Mesin Laminating" option —
  // they should fall through to the AI instead.
  for (const o of opts) {
    if (trimmed === o.label.toLowerCase()) return o.id;
  }
  return null;
}

async function sendFlowMessage(
  userId: number,
  epoch: number,
  ownerPhone: string,
  chatId: number,
  jid: string,
  text: string,
  imageUrl?: string | null
): Promise<boolean> {
  const ctx = getCtx(userId);
  if (epoch !== ctx.epoch) return false;
  if (ctx.ownerPhone !== ownerPhone) return false;
  if (!ctx.sock) return false;
  if (!text && !imageUrl) return false;

  // Try to resolve an image buffer if imageUrl is provided. Failure to load
  // the image must not block the text — we fall back to sending text alone
  // and log the error so the operator can fix the asset.
  let imageBuffer: Buffer | null = null;
  if (imageUrl) {
    try {
      imageBuffer = await loadImageBuffer(imageUrl);
    } catch (err) {
      logger.warn({ err, imageUrl, chatId }, "flow image load failed; sending text only");
    }
  }

  let sent;
  if (imageBuffer) {
    sent = await ctx.sock.sendMessage(jid, {
      image: imageBuffer,
      caption: text || undefined,
    });
  } else if (text) {
    sent = await ctx.sock.sendMessage(jid, { text });
  } else {
    // Image-only node whose image failed to load — bail out instead of
    // sending an empty text message (which Baileys would reject anyway).
    return false;
  }
  const stored = text || (imageBuffer ? "[gambar]" : "");
  await db
    .insert(chatMessagesTable)
    .values({
      chatId,
      direction: "outbound",
      content: stored,
      isAiGenerated: false,
      waMessageId: sent?.key?.id ?? null,
    })
    .onConflictDoNothing({ target: chatMessagesTable.waMessageId });
  await db
    .update(chatsTable)
    .set({ lastMessage: stored, lastMessageAt: new Date(), status: "ai_handled" })
    .where(
      sql`${chatsTable.id} = ${chatId} AND ${chatsTable.ownerPhone} = ${ownerPhone}`
    );
  return true;
}

const MAX_EXTERNAL_IMAGE_BYTES = 16 * 1024 * 1024;

// Block list of IP ranges that the server must never make outbound HTTP
// requests to (used as an SSRF guard when loading flow/product images by URL).
// Covers loopback, RFC1918 private, link-local (incl. 169.254.169.254 cloud
// metadata), CGNAT, multicast, reserved, and IPv6 equivalents.
const SSRF_BLOCKLIST: import("node:net").BlockList = (() => {
  // Lazy require to avoid the cost at module import in non-prod hot paths.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BlockList } = require("node:net") as typeof import("node:net");
  const bl = new BlockList();
  bl.addSubnet("0.0.0.0", 8, "ipv4");
  bl.addSubnet("10.0.0.0", 8, "ipv4");
  bl.addSubnet("127.0.0.0", 8, "ipv4");
  bl.addSubnet("169.254.0.0", 16, "ipv4");
  bl.addSubnet("172.16.0.0", 12, "ipv4");
  bl.addSubnet("192.168.0.0", 16, "ipv4");
  bl.addSubnet("100.64.0.0", 10, "ipv4");
  bl.addSubnet("224.0.0.0", 4, "ipv4");
  bl.addSubnet("240.0.0.0", 4, "ipv4");
  bl.addAddress("::", "ipv6");
  bl.addAddress("::1", "ipv6");
  bl.addSubnet("fc00::", 7, "ipv6");
  bl.addSubnet("fe80::", 10, "ipv6");
  bl.addSubnet("ff00::", 8, "ipv6");
  return bl;
})();

// Unwrap IPv4-mapped IPv6 to IPv4 (handles both ::ffff:1.2.3.4 dotted and
// ::ffff:0102:0304 hex forms) so we never miss private IPv4 ranges hidden
// behind IPv6 encoding.
function checkAddressBlocked(addr: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isIP } = require("node:net") as typeof import("node:net");
  const family = isIP(addr);
  if (family === 4) return SSRF_BLOCKLIST.check(addr, "ipv4");
  if (family !== 6) return true; // unknown → block
  const lower = addr.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted) return SSRF_BLOCKLIST.check(dotted[1]!, "ipv4");
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    const v4 = `${(hi >>> 8) & 255}.${hi & 255}.${(lo >>> 8) & 255}.${lo & 255}`;
    return SSRF_BLOCKLIST.check(v4, "ipv4");
  }
  return SSRF_BLOCKLIST.check(addr, "ipv6");
}

// Loads an image for sending via Baileys. Two source kinds are supported:
//
//   - "/api/media/<file>" — server-uploaded media (flow/product image uploads),
//     read straight from disk.
//   - "http(s)://…"      — external image URL. SSRF-hardened: DNS-resolves the
//     host first and rejects if any returned address falls in a
//     private/reserved range; refuses redirects (would re-introduce SSRF);
//     requires an image/* content-type; caps body at MAX_EXTERNAL_IMAGE_BYTES;
//     enforces a 10s timeout. Residual risk: DNS rebinding could in theory
//     change the resolved address between our lookup() and fetch()'s actual
//     connect; mitigating that fully requires pinning the resolved IP via a
//     custom dispatcher. Accepted tradeoff for the small, admin-curated
//     product catalog this serves.
async function loadImageBuffer(imageUrl: string): Promise<Buffer> {
  if (imageUrl.startsWith("/api/media/")) {
    const filename = path.basename(imageUrl.slice("/api/media/".length));
    const filepath = path.join(MEDIA_DIR, filename);
    return await fs.readFile(filepath);
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    throw new Error(`Unsupported image url: ${imageUrl}`);
  }
  const parsed = new URL(imageUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
  const { lookup } = await import("node:dns/promises");
  const addrs = await lookup(parsed.hostname, { all: true });
  if (addrs.length === 0) throw new Error("dns: no addresses");
  for (const a of addrs) {
    if (checkAddressBlocked(a.address)) {
      throw new Error(`blocked private/reserved host: ${a.address}`);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(imageUrl, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (!ct.toLowerCase().startsWith("image/")) {
      throw new Error(`unexpected content-type: ${ct}`);
    }
    const len = Number(res.headers.get("content-length") || 0);
    if (len && len > MAX_EXTERNAL_IMAGE_BYTES) {
      throw new Error(`content-length ${len} exceeds cap`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no response body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.length;
        if (total > MAX_EXTERNAL_IMAGE_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new Error(`response exceeded ${MAX_EXTERNAL_IMAGE_BYTES} bytes`);
        }
        chunks.push(value);
      }
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

// Walk forward from `startNodeId` along straight (non-question) edges, sending
// `message` nodes as they're hit. Stops at a `question` (asks it and persists
// state), an `end` (clears state), or a dead-end (clears state).
async function runFlowFrom(
  userId: number,
  epoch: number,
  ownerPhone: string,
  chatId: number,
  jid: string,
  flowId: number,
  graph: FlowGraph,
  startNodeId: string,
  cooldownMs: number
): Promise<void> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  let cursorId: string | null = startNodeId;
  const visited = new Set<string>();

  while (cursorId) {
    if (visited.has(cursorId)) break; // cycle guard
    visited.add(cursorId);
    const node = nodesById.get(cursorId);
    if (!node) break;

    if (node.type === "message") {
      if (node.data.text || node.data.imageUrl) {
        const ok = await sendFlowMessage(
          userId,
          epoch,
          ownerPhone,
          chatId,
          jid,
          node.data.text ?? "",
          node.data.imageUrl ?? null
        );
        if (!ok) return;
      }
      const next = graph.edges.find((e) => e.source === cursorId && !e.sourceHandle);
      cursorId = next?.target ?? null;
      continue;
    }

    if (node.type === "question") {
      const text = renderQuestion(node);
      const ok = await sendFlowMessage(
        userId,
        epoch,
        ownerPhone,
        chatId,
        jid,
        text,
        node.data.imageUrl ?? null
      );
      if (!ok) return;
      await db
        .update(chatsTable)
        .set({ flowState: { flowId, currentNodeId: node.id } })
        .where(eq(chatsTable.id, chatId));
      return;
    }

    if (node.type === "products") {
      const ids = (node.data.productIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length > 0) {
        // Scope by ownerPhone so a flow can never leak another tenant's products
        // if their ids happened to be referenced.
        const rows = await db
          .select({
            id: productsTable.id,
            code: productsTable.code,
            name: productsTable.name,
            price: productsTable.price,
            imageUrl: productsTable.imageUrl,
          })
          .from(productsTable)
          .where(and(eq(productsTable.ownerPhone, ownerPhone), inArray(productsTable.id, ids)));
        // Preserve the author's ordering from the flow node.
        const byId = new Map(rows.map((p) => [p.id, p]));
        for (const pid of ids) {
          const p = byId.get(pid);
          if (!p) continue;
          const caption =
            `*${p.name}*\n` +
            `Kode: ${p.code}\n` +
            `Harga: Rp ${p.price.toLocaleString("id-ID")}`;
          const ok = await sendFlowMessage(
            userId,
            epoch,
            ownerPhone,
            chatId,
            jid,
            caption,
            p.imageUrl ?? null
          );
          if (!ok) return;
        }
      }
      const next = graph.edges.find((e) => e.source === cursorId && !e.sourceHandle);
      cursorId = next?.target ?? null;
      continue;
    }

    if (node.type === "end") {
      // Mute the Default trigger briefly so the next message is handled by
      // AI instead of immediately re-entering the menu. Cooldown comes
      // from the per-owner setting (configurable in /settings).
      await db
        .update(chatsTable)
        .set({ flowState: { defaultMutedUntil: Date.now() + cooldownMs } })
        .where(eq(chatsTable.id, chatId));
      return;
    }

    if (node.type === "ai") {
      // Handoff node: send optional intro text, then exit the flow and mute
      // the Default trigger for the cooldown so the AI engine answers the
      // customer's subsequent messages naturally. Keyword triggers still
      // override this if the customer types one.
      if (node.data.text) {
        const ok = await sendFlowMessage(userId, epoch, ownerPhone, chatId, jid, node.data.text);
        if (!ok) return;
      }
      await db
        .update(chatsTable)
        .set({ flowState: { defaultMutedUntil: Date.now() + cooldownMs } })
        .where(eq(chatsTable.id, chatId));
      return;
    }

    // Trigger or unknown — just follow first outgoing edge.
    const next = graph.edges.find((e) => e.source === cursorId && !e.sourceHandle);
    cursorId = next?.target ?? null;
  }

  // Dead-end without an explicit end node — same cooldown as End.
  await db
    .update(chatsTable)
    .set({ flowState: { defaultMutedUntil: Date.now() + cooldownMs } })
    .where(eq(chatsTable.id, chatId));
}

// Returns true if the flow handled the inbound message (AI should be skipped).
async function tryRunFlow(
  userId: number,
  ownerPhone: string,
  epoch: number,
  chat: typeof chatsTable.$inferSelect,
  jid: string,
  messageText: string
): Promise<boolean> {
  const text = messageText.trim();
  if (!text) return false;

  // Re-read chat to get fresh flowState (the upserted row may be stale).
  // FOR UPDATE serialises concurrent inbound messages on the same chat so
  // two simultaneous arrivals can't both advance the flow from the same
  // currentNodeId and double-fire replies.
  const [fresh] = await db
    .select({ flowState: chatsTable.flowState })
    .from(chatsTable)
    .where(eq(chatsTable.id, chat.id))
    .for("update")
    .limit(1);
  // flowState can be one of three shapes:
  //  - null                                          → chat has never been in a flow
  //  - { flowId, currentNodeId }                     → chat is mid-flow at a question
  //  - { defaultMutedUntil }                         → flow recently exited; do not
  //    auto-restart via the Default trigger until that timestamp passes.
  //    Keyword triggers still match (explicit user intent).
  const state = (fresh?.flowState ?? null) as
    | { flowId?: number; currentNodeId?: string; defaultMutedUntil?: number }
    | null;
  // Cooldown after any flow exit before the Default trigger may re-fire.
  // Configurable per owner in Settings (5/15/30/60/120 minutes). We read
  // just the column to avoid a circular import with routes/settings.ts and
  // to avoid touching the rest of the settings row on every inbound msg.
  const [settingsRow] = await db
    .select({ flowCooldownMinutes: settingsTable.flowCooldownMinutes })
    .from(settingsTable)
    .where(eq(settingsTable.ownerPhone, ownerPhone))
    .limit(1);
  const cooldownMin = settingsRow?.flowCooldownMinutes ?? 5;
  const cooldownMs = cooldownMin * 60 * 1000;
  const muteState = { defaultMutedUntil: Date.now() + cooldownMs };

  // Case A: chat is mid-flow at a question → try to advance.
  if (state && state.flowId && state.currentNodeId) {
    const [flowRow] = await db
      .select()
      .from(chatbotFlowsTable)
      .where(
        and(
          eq(chatbotFlowsTable.id, state.flowId),
          eq(chatbotFlowsTable.ownerPhone, ownerPhone)
        )
      )
      .limit(1);
    if (!flowRow) {
      await db.update(chatsTable).set({ flowState: muteState }).where(eq(chatsTable.id, chat.id));
      return false;
    }
    const graph = flowRow.graph as FlowGraph;
    const node = graph.nodes.find((n) => n.id === state.currentNodeId);
    if (!node || node.type !== "question") {
      await db.update(chatsTable).set({ flowState: muteState }).where(eq(chatsTable.id, chat.id));
      return false;
    }
    const optId = pickOption(node, text);
    if (!optId) {
      // Strict mode: customer must answer with one of the options. Re-send
      // the question and keep the same flowState so the next reply is still
      // judged against the same options. AI is NOT invoked.
      if (node.data.strictOptions) {
        // Optional error nudge sent BEFORE the question is re-asked (e.g.
        // "Anda belum memilih dengan tepat, tulis angka 1-2 untuk memilih").
        const retryMsg = (node.data.strictRetryMessage ?? "").trim();
        if (retryMsg) {
          const okMsg = await sendFlowMessage(
            userId,
            epoch,
            ownerPhone,
            chat.id,
            jid,
            retryMsg,
            null
          );
          if (!okMsg) return false;
        }
        const questionText = renderQuestion(node);
        const ok = await sendFlowMessage(
          userId,
          epoch,
          ownerPhone,
          chat.id,
          jid,
          questionText,
          node.data.imageUrl ?? null
        );
        // If the re-ask failed to send, don't claim the flow handled the
        // message — fall through to AI so the customer isn't left in silence.
        return ok;
      }
      // Unrecognised reply → user is asking a free-form question, let AI handle it.
      await db.update(chatsTable).set({ flowState: muteState }).where(eq(chatsTable.id, chat.id));
      return false;
    }

    const edge = graph.edges.find(
      (e) => e.source === node.id && e.sourceHandle === optId
    );
    if (!edge) {
      // Picked an option that the flow author never wired up → AI takes over.
      await db.update(chatsTable).set({ flowState: muteState }).where(eq(chatsTable.id, chat.id));
      return false;
    }
    await runFlowFrom(
      userId,
      epoch,
      ownerPhone,
      chat.id,
      jid,
      flowRow.id,
      graph,
      edge.target,
      cooldownMs
    );
    return true;
  }

  // Case B: not in a flow → try to match a trigger from the active flow.
  const [active] = await db
    .select()
    .from(chatbotFlowsTable)
    .where(
      and(eq(chatbotFlowsTable.ownerPhone, ownerPhone), eq(chatbotFlowsTable.isActive, true))
    )
    .limit(1);
  if (!active) return false;
  const graph = active.graph as FlowGraph;
  const lower = text.toLowerCase();

  // Only consider triggers that actually have an outgoing edge — an
  // orphan trigger (left behind during editing) must not block the flow.
  const hasOutgoing = (id: string) => graph.edges.some((e) => e.source === id);
  const triggers = graph.nodes.filter((n) => n.type === "trigger" && hasOutgoing(n.id));
  // Keyword triggers always win (explicit intent) and bypass the mute.
  const keywordHit = triggers.find(
    (n) =>
      (n.data.matchType ?? "keyword") === "keyword" &&
      (n.data.keywords ?? []).some((k) => k && lower.includes(k.toLowerCase()))
  );
  const defaultMuted =
    !!state?.defaultMutedUntil && Date.now() < state.defaultMutedUntil;
  const start =
    keywordHit ??
    (defaultMuted ? undefined : triggers.find((n) => n.data.matchType === "default"));
  if (!start) return false;

  const firstEdge = graph.edges.find((e) => e.source === start.id);
  if (!firstEdge) return false;

  // If the muted period expired and we're re-entering via Default, drop the
  // stale `defaultMutedUntil` marker so the chat state is clean going in.
  // (runFlowFrom will overwrite flowState with either question or
  // new mute on exit, but this keeps semantics tidy.)
  await runFlowFrom(
    userId,
    epoch,
    ownerPhone,
    chat.id,
    jid,
    active.id,
    graph,
    firstEdge.target,
    cooldownMs
  );
  return true;
}

async function maybeTriggerAutoReply(
  userId: number,
  ownerPhone: string,
  epoch: number,
  chat: typeof chatsTable.$inferSelect,
  jid: string,
  messageText: string
) {
  if (chat.isHumanTakeover) return;
  if (!messageText.trim()) return;

  // Try chatbot flow before AI. If a flow handled the message (matched a
  // trigger or advanced from a question), skip the AI auto-reply entirely.
  try {
    const handled = await tryRunFlow(userId, ownerPhone, epoch, chat, jid, messageText);
    if (handled) return;
  } catch (err) {
    logger.error({ err }, "Flow engine failed; falling back to AI");
  }

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
      const ctx = getCtx(userId);
      // Cross-session safety per THIS user: bail if disconnect (epoch bump)
      // or owner reassignment happened during the delay.
      if (epoch !== ctx.epoch) return;
      if (ctx.ownerPhone !== ownerPhone) return;

      const aiReply = await generateAiReply(ownerPhone, chat.id, messageText);
      const replyText = aiReply ?? settings.fallbackMessage;

      if (epoch !== ctx.epoch) return;
      if (ctx.ownerPhone !== ownerPhone) return;

      if (ctx.sock && replyText) {
        const sent = await ctx.sock.sendMessage(jid, { text: replyText });

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

async function startBaileys(userId: number) {
  const ctx = getCtx(userId);
  if (ctx.isConnecting || (ctx.sock && (ctx.sock as any).ws?.readyState === 1)) return;
  ctx.isConnecting = true;
  const myEpoch = ++ctx.epoch;
  const session = await getOrCreateSession(userId);
  const sessionId = session.id;

  try {
    const {
      useMultiFileAuthState,
      makeWASocket,
      DisconnectReason,
      isJidGroup,
    } = await import("@whiskeysockets/baileys");

    const { Boom } = await import("@hapi/boom");
    const { default: NodeCache } = await import("node-cache");

    const authDir = authDirForUser(userId);
    await fs.mkdir(authDir, { recursive: true }).catch(() => {});
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const msgRetryCounterCache = new NodeCache();

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      msgRetryCounterCache,
      logger: (await import("pino")).default({ level: "warn" }),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
    });
    ctx.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
        await setStatus(sessionId, "qr_ready", { qrCode: dataUrl });
      }

      if (connection === "open") {
        const rawId = sock.user?.id ?? null;
        const phoneNumber = rawId?.split(":")[0] ?? null;
        const normalised = normalizeOwnerPhone(phoneNumber);
        // Data-isolation gate: persist the user↔phone mapping BEFORE we
        // expose the phone via ctx.ownerPhone. If another app user already
        // owns this WhatsApp number (unique constraint on
        // user_whatsapp.owner_phone), refuse the connection — otherwise
        // requests from this user would read the other user's chats.
        if (normalised) {
          try {
            await setOwnerPhoneForUser(userId, normalised);
          } catch (err: unknown) {
            const code = (err as { code?: string } | null)?.code;
            if (code === "23505") {
              logger.warn(
                { userId, normalised },
                "WhatsApp number already paired to another account; rejecting connection"
              );
              ctx.ownerPhone = null;
              await setStatus(sessionId, "disconnected", {
                qrCode: null,
                phoneNumber: null,
                connectedAt: null,
              });
              try {
                await sock.logout();
              } catch {}
              ctx.sock = null;
              ctx.isConnecting = false;
              return;
            }
            logger.error(
              { err, userId },
              "Failed to persist user_whatsapp mapping; refusing to expose ownerPhone"
            );
            ctx.ownerPhone = null;
            await setStatus(sessionId, "disconnected", {
              qrCode: null,
              phoneNumber: null,
              connectedAt: null,
            });
            try {
              await sock.logout();
            } catch {}
            ctx.sock = null;
            ctx.isConnecting = false;
            return;
          }
          ctx.ownerPhone = normalised;
        } else {
          ctx.ownerPhone = null;
        }
        await setStatus(sessionId, "connected", {
          qrCode: null,
          phoneNumber,
          connectedAt: new Date(),
        });
        ctx.isConnecting = false;
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        await setStatus(sessionId, "disconnected", {
          qrCode: null,
          phoneNumber: null,
          connectedAt: null,
        });
        ctx.sock = null;
        ctx.isConnecting = false;
        ctx.ownerPhone = null;
        if (shouldReconnect) {
          setTimeout(() => startBaileys(userId).catch(() => {}), 3000);
        }
      }
    });

    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");

    const groupNameCache = new Map<string, string>();
    const resolveGroupName = async (jid: string): Promise<string | null> => {
      if (groupNameCache.has(jid)) return groupNameCache.get(jid) ?? null;
      try {
        const meta = await sock.groupMetadata(jid);
        const name = meta?.subject ?? null;
        if (name) groupNameCache.set(jid, name);
        return name;
      } catch {
        return null;
      }
    };

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (myEpoch !== ctx.epoch) return;
      const ownerPhone = ctx.ownerPhone;
      if (!ownerPhone) return;
      const ownerJid = sock.user?.id ?? "";
      logger.info(
        { type, count: messages.length, jids: messages.map((m) => m.key.remoteJid) },
        "messages.upsert received"
      );
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        try {
          if (myEpoch !== ctx.epoch) return;
          if (msg.key?.remoteJid === "status@broadcast") {
            await persistWaStatus(ownerPhone, ownerJid, msg, downloadMediaMessage, true).catch(
              (err) => logger.error({ err }, "Failed to persist live status")
            );
            continue;
          }
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            true,
            resolveGroupName
          );
          if (!parsed) continue;
          if (myEpoch !== ctx.epoch) return;

          const { chat, inserted } = await persistWaMessage(userId, ownerPhone, parsed, {
            incrementUnread: true,
          });
          if (!inserted) continue;
          if (parsed.fromMe) continue;
          if (parsed.isGroup) continue;

          await maybeTriggerAutoReply(userId, ownerPhone, myEpoch, chat, parsed.jid, parsed.messageContent);
        } catch (err) {
          logger.error({ err }, "Failed to process incoming message");
        }
      }
    });

    sock.ev.on("messaging-history.set", async (payload) => {
      if (myEpoch !== ctx.epoch) return;
      const ownerPhone = ctx.ownerPhone;
      if (!ownerPhone) return;
      const ownerJid = sock.user?.id ?? "";
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
            const groupName =
              c.name?.trim() || (await resolveGroupName(c.id)) || c.id.split("@")[0];
            await getOrCreateChat(ownerPhone, c.id, groupName);
            key = c.id;
          } else {
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
          if (myEpoch !== ctx.epoch) return;
          if (msg.key?.remoteJid === "status@broadcast") {
            await persistWaStatus(ownerPhone, ownerJid, msg, downloadMediaMessage, false).catch(
              (err) => logger.error({ err }, "Failed to persist history status")
            );
            continue;
          }
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            false,
            resolveGroupName
          );
          if (!parsed) continue;
          if (myEpoch !== ctx.epoch) return;
          const { inserted } = await persistWaMessage(userId, ownerPhone, parsed, {
            incrementUnread: false,
          });
          if (inserted) ingested++;
        } catch (err) {
          logger.error({ err }, "Failed to ingest history message");
        }
      }
      logger.info({ ingested }, "messaging-history.set done");
    });

    const handleContacts = async (
      contacts: Array<{
        id?: string;
        name?: string | null;
        notify?: string | null;
        verifiedName?: string | null;
      }>
    ) => {
      if (myEpoch !== ctx.epoch) return;
      const ownerPhone = ctx.ownerPhone;
      if (!ownerPhone) return;
      for (const c of contacts) {
        try {
          if (!c?.id) continue;
          if (!c.id.endsWith("@s.whatsapp.net")) continue;
          const rawNumber = c.id.split("@")[0].split(":")[0];
          const phoneNumber = `+${rawNumber}`;
          const savedName = c.name?.trim() || null;
          const verifiedName = c.verifiedName?.trim() || null;
          const pushName = c.notify?.trim() || null;

          const updateSet: Record<string, unknown> = {};
          if (Object.prototype.hasOwnProperty.call(c, "verifiedName")) {
            updateSet.nickname = verifiedName;
          }
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

    const keyForChatId = (id: string): string | null => {
      if (id.endsWith("@g.us")) return id;
      if (id.endsWith("@s.whatsapp.net")) {
        return `+${id.split("@")[0].split(":")[0]}`;
      }
      return null;
    };
    const handleChatMeta = async (updates: Array<{ id?: string } & Record<string, unknown>>) => {
      if (myEpoch !== ctx.epoch) return;
      const ownerPhone = ctx.ownerPhone;
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
    ctx.isConnecting = false;
    ctx.sock = null;
    await setStatus(sessionId, "disconnected");
    throw err;
  }
}

export async function initWhatsapp() {
  try {
    // Idempotent is_lid backfill (unchanged from pre-auth behavior).
    try {
      const setRes = await db.execute(sql`
        UPDATE chats
           SET is_lid = TRUE
         WHERE is_lid = FALSE
           AND phone_number NOT LIKE '%@g.us'
           AND LENGTH(REGEXP_REPLACE(phone_number, '[^0-9]', '', 'g')) >= 15
           AND (contact_name = SUBSTRING(phone_number FROM 2) OR contact_name IS NULL)
      `);
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

    // Auto-reconnect each user that was previously connected. We do NOT
    // start a session for users who have never paired — they have to hit
    // /connect from the UI first (which produces a QR).
    const rows = await db
      .select()
      .from(whatsappSessionTable)
      .where(
        sql`${whatsappSessionTable.userId} IS NOT NULL
            AND ${whatsappSessionTable.status} IN ('connected', 'connecting', 'qr_ready')`
      );
    for (const row of rows) {
      if (row.userId == null) continue;
      await setStatus(row.id, "connecting");
      startBaileys(row.userId).catch((err) =>
        logger.error({ err, userId: row.userId }, "Auto-reconnect failed")
      );
    }
  } catch {
  }
}

const router = Router();

router.get("/status", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const session = await getOrCreateSession(userId);
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
    const userId = requireUserId(req);
    const session = await getOrCreateSession(userId);
    if (session.status === "connected") {
      return res.json({
        status: session.status,
        qrCode: null,
        phoneNumber: session.phoneNumber ?? null,
        connectedAt: session.connectedAt?.toISOString() ?? null,
      });
    }
    await setStatus(session.id, "connecting");
    startBaileys(userId).catch((err) =>
      req.log.error({ err }, "Baileys start failed")
    );
    res.json({ status: "connecting", qrCode: null, phoneNumber: null, connectedAt: null });
  } catch (err) {
    req.log.error({ err }, "Failed to connect WhatsApp");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/profile/bio", async (req, res): Promise<void> => {
  try {
    const userId = requireUserId(req);
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const result = await fetchOwnBio(userId);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch own bio");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/profile/bio", async (req, res): Promise<void> => {
  try {
    const userId = requireUserId(req);
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const bio = String(req.body?.bio ?? "").trim();
    if (!bio || bio.length > 139) {
      res.status(400).json({ error: "Bio must be 1-139 characters" });
      return;
    }
    const result = await updateOwnBio(userId, bio);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to update own bio");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/disconnect", async (req, res) => {
  try {
    const userId = requireUserId(req);
    const ctx = getCtx(userId);
    // Bump THIS user's epoch FIRST so any in-flight handler callbacks abort
    // before they try to persist into chats we're about to clear.
    ctx.epoch++;
    if (ctx.sock) {
      try {
        ctx.sock.ev.removeAllListeners("messages.upsert");
        ctx.sock.ev.removeAllListeners("messaging-history.set");
        ctx.sock.ev.removeAllListeners("connection.update");
        ctx.sock.ev.removeAllListeners("contacts.upsert");
        ctx.sock.ev.removeAllListeners("contacts.update");
        ctx.sock.ev.removeAllListeners("chats.upsert");
        ctx.sock.ev.removeAllListeners("chats.update");
      } catch {}
      await ctx.sock.logout().catch(() => {});
      ctx.sock = null;
    }
    ctx.isConnecting = false;
    // Wipe THIS user's local auth credentials so the next /connect starts
    // a fresh pairing flow (QR). Other users' auth dirs are untouched.
    await fs.rm(authDirForUser(userId), { recursive: true, force: true }).catch((err) => {
      req.log.warn({ err }, "Failed to wipe WhatsApp auth dir");
    });
    // Per-user isolation: do NOT delete chats. Each chat row is scoped by
    // owner_phone, so once we clear this user's connected phone below the
    // dashboard returns an empty list. When the SAME number scans QR again,
    // its history reappears; a DIFFERENT number sees its own clean slate.
    ctx.ownerPhone = null;
    const session = await getOrCreateSession(userId);
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
