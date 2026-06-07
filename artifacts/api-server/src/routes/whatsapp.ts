import { Router, type Request } from "express";
import type makeWASocketType from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import path from "path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db } from "@workspace/db";
import {
  chatsTable,
  chatMessagesTable,
  knowledgeTable,
  settingsTable,
  whatsappStatusesTable,
  chatbotFlowsTable,
  chatbotFlowChannelsTable,
  productsTable,
  channelsTable,
  type FlowGraph,
  type FlowNode,
} from "@workspace/db";
import { and, asc, desc, eq, lte, sql, inArray } from "drizzle-orm";
import {
  withTag,
  stripTrailingTag,
  CHATBOT_TAG,
  AI_TAG,
} from "../lib/sender-tag.js";
import { logger } from "../lib/logger";
import { resolveAiClient } from "../lib/ai-provider";
import { recordAiUsage } from "../lib/ai-usage";
import {
  getOwnerPhoneForUser,
  setOwnerPhoneForUser,
  resolveOwnerUserId,
  ensurePrimaryWhatsappChannelForUser,
} from "../lib/seed";
import { getOrCreateTenantSettings } from "../lib/settings-store";
import { isOwnerReadOnly } from "../lib/billing";
import { buildProductCatalogText } from "../lib/product-catalog";
import {
  resolveActiveChannel,
  listOwnedChannels,
} from "../lib/channel-context";
import { readClearUpTo } from "../lib/chat-read-sync";
import {
  FLOW_REPHRASE_SYSTEM_PROMPT,
  cleanRephrasedText,
} from "../lib/flow-rephrase";

// Whether the signed-in user owns the WhatsApp pairing (super_admin) or
// merely inherits it (supervisor / agent). Invited members must not be able
// to pair or disconnect the team's number.
async function isWhatsappOwner(userId: number): Promise<boolean> {
  const owner = await resolveOwnerUserId(userId);
  return owner === userId;
}

const AUTH_ROOT = path.join(process.cwd(), ".whatsapp-auth");
export const MEDIA_DIR = path.join(process.cwd(), "media");

// Per-channel auth state dir. Each WhatsApp channel gets its OWN auth
// subdirectory so one user with N paired numbers holds N independent
// Baileys sessions on disk. Layout: `<AUTH_ROOT>/<userId>/<channelId>/`.
// The legacy single-channel layout (`<AUTH_ROOT>/<userId>/`) is migrated
// on first boot — see `migrateLegacyAuthDirs()` in `initWhatsapp`.
function authDirForChannel(userId: number, channelId: number): string {
  return path.join(AUTH_ROOT, String(userId), String(channelId));
}

type WASocket = Awaited<ReturnType<typeof makeWASocketType>>;

// Per-channel runtime context. One ChannelCtx per channels.id — a user
// with N paired WhatsApp numbers holds N independent ctxs, each with its
// own Baileys socket, epoch, and connection state. Keyed by channelId in
// `channelCtxs`; `userId` is stored on the ctx so event handlers can
// resolve owner-level resources (settings, products) without an extra DB
// hop. Migrated from the previous user-keyed layout in T009 Phase B.
interface ChannelCtx {
  userId: number;
  sock: WASocket | null;
  isConnecting: boolean;
  // Bumped on disconnect/reset. Event handlers capture the epoch at attach
  // time and refuse to persist if the per-channel epoch has moved on — this
  // prevents stale in-flight messages.upsert / messaging-history.set
  // callbacks from a torn-down socket reinserting chats after /disconnect.
  epoch: number;
  // Digits-only phone of THIS channel's currently linked WA account.
  ownerPhone: string | null;
}

const channelCtxs = new Map<number, ChannelCtx>();

function getCtxByChannel(channelId: number, userId: number): ChannelCtx {
  let c = channelCtxs.get(channelId);
  if (!c) {
    c = {
      userId,
      sock: null,
      isConnecting: false,
      epoch: 0,
      ownerPhone: null,
    };
    channelCtxs.set(channelId, c);
  }
  return c;
}

// Lowest-id WhatsApp channel for an OWNER user (super_admin). Used by the
// back-compat exports that still take `userId` — they resolve to the
// owner's "primary" channel (the first one created). Returns null if the
// user has no WhatsApp channels yet.
async function resolvePrimaryChannelId(
  ownerUserId: number,
): Promise<number | null> {
  const rows = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(
      and(
        eq(channelsTable.userId, ownerUserId),
        eq(channelsTable.kind, "whatsapp"),
      ),
    )
    .orderBy(asc(channelsTable.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

// Resolve the primary channel ctx for ANY signed-in user (owner or
// supervisor/agent inheriting the owner's pairing). Returns null when no
// channel exists yet OR no ctx has been spun up. Does NOT auto-create the
// ctx — that only happens inside startBaileys, since a ctx without a live
// socket is meaningless for the read-side back-compat callers.
async function getPrimaryCtxForUser(
  userId: number,
): Promise<ChannelCtx | null> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const cid = await resolvePrimaryChannelId(ownerUserId);
  if (cid == null) return null;
  return channelCtxs.get(cid) ?? null;
}

// Mirror this ctx's pairing state onto the channels table so the new
// multi-channel surface (channel CRUD, frontend switcher) sees a live
// status. Fire-and-forget — never block the pairing hot path on a
// secondary write.
async function syncChannelStatus(
  channelId: number,
  patch: {
    status: string;
    ownerPhone?: string | null;
    // WA-specific: the connected account's own profile/display name. Persisted
    // as a direct column. Pass `undefined` to leave untouched.
    ownerName?: string | null;
    // Optional pairing-QR data url. Persisted into channels.metadata.qrCode
    // so the per-channel pair flow (POST /api/channels/:id/pair → GET
    // /api/channels/:id/qr) can surface it even for non-primary channels.
    // Pass `null` to clear, `undefined` to leave untouched.
    qrCode?: string | null;
    // ISO timestamp of when the socket reached connection.open. Persisted
    // into channels.metadata.connectedAt so the legacy /whatsapp/status
    // shape can surface it. Pass `null` to clear, `undefined` to leave
    // untouched.
    connectedAt?: string | null;
  },
): Promise<void> {
  try {
    const { qrCode, connectedAt, ...statusPatch } = patch;
    const touchesMetadata = qrCode !== undefined || connectedAt !== undefined;
    if (!touchesMetadata) {
      await db
        .update(channelsTable)
        .set({ ...statusPatch, updatedAt: new Date() })
        .where(eq(channelsTable.id, channelId));
      return;
    }
    // Merge into existing metadata so we don't clobber other kind-specific
    // fields a future integration may have stashed there.
    const existing = await db
      .select({ metadata: channelsTable.metadata })
      .from(channelsTable)
      .where(eq(channelsTable.id, channelId))
      .limit(1);
    const prev =
      (existing[0]?.metadata as Record<string, unknown> | null) ?? {};
    const nextMeta: Record<string, unknown> = { ...prev };
    if (qrCode !== undefined) nextMeta.qrCode = qrCode;
    if (connectedAt !== undefined) nextMeta.connectedAt = connectedAt;
    await db
      .update(channelsTable)
      .set({ ...statusPatch, metadata: nextMeta, updatedAt: new Date() })
      .where(eq(channelsTable.id, channelId));
  } catch (err) {
    logger.warn(
      { err, channelId, patch },
      "channels-status sync failed (non-fatal)",
    );
  }
}

// Public helper: start (or resume) the Baileys runtime for a specific
// channel. Used by the per-channel POST /api/channels/:id/pair endpoint
// to bring up a non-primary WhatsApp channel. Idempotent — bails out if
// the channel's socket is already open or a connect is in flight.
export async function startBaileysForChannel(
  userId: number,
  channelId: number,
): Promise<void> {
  await startBaileys(userId, channelId);
}

// Public helper: tear down the Baileys runtime for a specific channel
// without deleting the channel row or its data. Used by both the legacy
// /whatsapp/disconnect (resolves primary channel) and the per-channel
// POST /api/channels/:id/unpair endpoint. Safe to call when no socket
// is active — wipes the per-channel auth dir either way so the next
// pair attempt always starts from a fresh QR.
export async function disconnectChannelRuntime(
  userId: number,
  channelId: number,
): Promise<void> {
  const ctx = getCtxByChannel(channelId, userId);
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
  ctx.ownerPhone = null;
  await fs
    .rm(authDirForChannel(userId, channelId), { recursive: true, force: true })
    .catch(() => {});
  await syncChannelStatus(channelId, {
    status: "disconnected",
    qrCode: null,
  });
  // Evict from the in-memory map so long-running churn (repeated
  // pair/unpair, channel delete + recreate) doesn't grow channelCtxs
  // unboundedly. A subsequent startBaileys recreates the ctx on demand.
  channelCtxs.delete(channelId);
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
  preferredFilename?: string,
): Promise<{ url: string; filename: string }> {
  await ensureMediaDir();
  const ext = preferredFilename
    ? path.extname(preferredFilename) || `.${mime.extension(mimeType) || "bin"}`
    : `.${mime.extension(mimeType) || "bin"}`;
  const filename = `${randomUUID()}${ext}`;
  const filepath = path.join(MEDIA_DIR, filename);
  await fs.writeFile(filepath, buffer);
  return {
    url: `/api/media/${filename}`,
    filename: preferredFilename ?? filename,
  };
}

// Returns the live Baileys socket for this user's team. Supervisor / agent
// inherit the super_admin parent's socket (only the owner pairs a number);
// this resolves the call to the owner's ctx so invited members can send
// messages without re-pairing.
export async function getActiveSocket(
  userId: number,
): Promise<WASocket | null> {
  const ctx = await getPrimaryCtxForUser(userId);
  return ctx?.sock ?? null;
}

// Live Baileys socket for a SPECIFIC channel id (not just the user's primary
// channel). Group operations act on the channel that owns the chat, which may
// be a non-primary paired number. Returns null when that channel has no open
// socket. Synchronous: reads the in-memory ctx map directly.
export function getSockForChannel(channelId: number): WASocket | null {
  return channelCtxs.get(channelId)?.sock ?? null;
}

// Primary channel id + its live socket for any signed-in user. Needed when an
// action (e.g. creating a brand-new group) has no existing chat to derive a
// channel from, so we must persist the resulting chat against the owner's
// primary channel. Returns null if the user has no WhatsApp channel yet.
export async function getPrimaryChannelForUser(
  userId: number,
): Promise<{ channelId: number; sock: WASocket | null } | null> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const cid = await resolvePrimaryChannelId(ownerUserId);
  if (cid == null) return null;
  return { channelId: cid, sock: channelCtxs.get(cid)?.sock ?? null };
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
  userId: number,
): Promise<string | null> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const ctx = await getPrimaryCtxForUser(ownerUserId);
  if (ctx?.ownerPhone) return ctx.ownerPhone;
  const phone = await getOwnerPhoneForUser(ownerUserId);
  if (phone && ctx) ctx.ownerPhone = phone;
  return phone;
}

// Best-effort: the display name of the WhatsApp account currently linked to a
// specific channel, read live from the open socket. Returns null when the
// channel has no live socket (not yet connected / dropped). Used to fill the
// "Served By" column on the sales-order Sheet export for channels that haven't
// re-connected since owner_name was introduced (the persisted column wins when
// present).
export function getLiveOwnerNameForChannel(
  channelId: number,
  userId: number,
): string | null {
  const ctx = getCtxByChannel(channelId, userId);
  return ctx.sock?.user?.name ?? ctx.sock?.user?.verifiedName ?? null;
}

// Fetch a contact's WhatsApp profile picture URL via Baileys and cache it on
// the chat row. WA URLs are token-signed and expire after a while, so we
// re-check periodically — but with split TTLs: rows that *have* a pic refresh
// more often (the cached URL may go stale) while rows that came back empty
// back off longer (privacy / no-pic accounts shouldn't be re-polled every few
// hours). `force: true` bypasses both TTLs and is used by the manual
// "refresh avatar" UI action.
const PROFILE_PIC_TTL_SUCCESS_MS = 2 * 60 * 60 * 1000; // 2h — URL freshness
const PROFILE_PIC_TTL_FAILURE_MS = 12 * 60 * 60 * 1000; // 12h — privacy/no-pic
const profilePicInFlight = new Set<number>();

// Whether a chat row is due for a profile-pic re-fetch. A row that already has
// a (token-signed, expiring) URL is due after the success TTL — this is what
// keeps cached URLs from going stale and 403-ing in the browser. Callers use
// this to decide *which* rows to opportunistically refresh; `refreshChatProfilePic`
// re-checks the same condition defensively.
export function isProfilePicRefreshDue(chat: {
  profilePicUrl: string | null;
  profilePicCheckedAt: Date | null;
}): boolean {
  if (!chat.profilePicCheckedAt) return true;
  const ttl = chat.profilePicUrl
    ? PROFILE_PIC_TTL_SUCCESS_MS
    : PROFILE_PIC_TTL_FAILURE_MS;
  return Date.now() - chat.profilePicCheckedAt.getTime() >= ttl;
}

export async function refreshChatProfilePic(
  _userId: number,
  chat: {
    id: number;
    channelId: number;
    phoneNumber: string;
    profilePicUrl: string | null;
    profilePicCheckedAt: Date | null;
  },
  opts: { force?: boolean } = {},
): Promise<string | null> {
  // Look up the live ctx for this chat's channel. We don't auto-create — if
  // no ctx exists the channel isn't paired and there's nothing to ask.
  const ctx = channelCtxs.get(chat.channelId);
  if (!ctx?.sock) return null;
  if (profilePicInFlight.has(chat.id)) return null;
  if (!opts.force && chat.profilePicCheckedAt) {
    const ttl = chat.profilePicUrl
      ? PROFILE_PIC_TTL_SUCCESS_MS
      : PROFILE_PIC_TTL_FAILURE_MS;
    if (Date.now() - chat.profilePicCheckedAt.getTime() < ttl) {
      return null;
    }
  }
  if (!ctx.ownerPhone) return null;

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
    const url =
      (await ctx.sock.profilePictureUrl(jid, "image").catch(() => null)) ??
      null;
    await db
      .update(chatsTable)
      .set({ profilePicUrl: url, profilePicCheckedAt: new Date() })
      .where(eq(chatsTable.id, chat.id));
    return url;
  } catch {
    // Mark as checked even on failure so we don't spam Baileys with retries.
    await db
      .update(chatsTable)
      .set({ profilePicCheckedAt: new Date() })
      .where(eq(chatsTable.id, chat.id))
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
  filename?: string,
  channelId?: number,
): Promise<string | null> {
  // Send from the chat's OWN channel when a channelId is supplied, so a
  // multi-channel tenant doesn't leak a media message out of the primary
  // number instead of the channel the chat actually belongs to. Falls back to
  // the user's primary socket only when no channel is given (legacy callers).
  const sock =
    channelId != null
      ? getSockForChannel(channelId)
      : ((await getPrimaryCtxForUser(await resolveOwnerUserId(userId)))?.sock ??
        null);
  if (!sock) throw new Error("WhatsApp is not connected");
  const buffer = await fs.readFile(filepath);
  let sent;
  if (mediaType === "image") {
    sent = await sock.sendMessage(jid, {
      image: buffer,
      caption,
      mimetype: mimeType,
    });
  } else if (mediaType === "video") {
    sent = await sock.sendMessage(jid, {
      video: buffer,
      caption,
      mimetype: mimeType,
    });
  } else if (mediaType === "audio") {
    sent = await sock.sendMessage(jid, {
      audio: buffer,
      mimetype: mimeType,
      ptt: false,
    });
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
  channelId: number,
  ownerJid: string,
  msg: any,
  downloadMediaMessage: any,
  downloadMedia: boolean,
): Promise<void> {
  if (!msg?.message) return;
  // participant is the actual author for status broadcasts
  const authorJid: string | undefined = msg.key?.participant ?? msg.participant;
  const fromMe = !!msg.key?.fromMe;
  if (!authorJid && !fromMe) return;
  const effectiveAuthorJid = authorJid ?? ownerJid;
  const authorPhoneDigits = effectiveAuthorJid
    .split("@")[0]
    .split(":")[0]
    .replace(/[^0-9]/g, "");
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
        {},
      )) as Buffer;
      const saved = await saveBufferToMedia(
        buf,
        mediaMime ?? "application/octet-stream",
      );
      mediaUrl = saved.url;
    } catch (err) {
      logger.error({ err }, "Failed to download status media");
    }
  }

  let authorName = msg.pushName?.trim() || "";
  if (!authorName) {
    const rows = await db
      .select({
        contactName: chatsTable.contactName,
        nickname: chatsTable.nickname,
      })
      .from(chatsTable)
      .where(
        sql`${chatsTable.channelId} = ${channelId} AND ${chatsTable.phoneNumber} = ${"+" + authorPhoneDigits}`,
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
      channelId,
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
      target: [
        whatsappStatusesTable.channelId,
        whatsappStatusesTable.waMessageId,
      ],
    });
}

// Post a text status broadcast from the connected account. `channelId` is
// the active channel — recorded on the inserted row so list/aggregate
// queries can filter by channel without touching ownerPhone.
export async function postTextStatus(
  userId: number,
  channelId: number,
  text: string,
  backgroundColor: string,
): Promise<typeof whatsappStatusesTable.$inferSelect> {
  const ctx = getCtxByChannel(channelId, userId);
  const sock = ctx.sock;
  if (!sock) throw new Error("WhatsApp is not connected");
  const ownerPhone = ctx.ownerPhone;
  const dmChats = await db
    .select({ phoneNumber: chatsTable.phoneNumber })
    .from(chatsTable)
    .where(
      sql`${chatsTable.channelId} = ${channelId}
          AND ${chatsTable.phoneNumber} NOT LIKE '%@g.us'`,
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
    { statusJidList } as any,
  );
  const ownerJid =
    sock.user?.id ?? (ownerPhone ? `${ownerPhone}@s.whatsapp.net` : "");
  const ownerDigits = ownerJid
    .split("@")[0]
    .split(":")[0]
    .replace(/[^0-9]/g, "");
  const postedAt = new Date();
  const waMessageId = sent?.key?.id ?? null;
  const inserted = await db
    .insert(whatsappStatusesTable)
    .values({
      channelId,
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
      target: [
        whatsappStatusesTable.channelId,
        whatsappStatusesTable.waMessageId,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0];
  if (waMessageId) {
    const existing = await db
      .select()
      .from(whatsappStatusesTable)
      .where(
        sql`${whatsappStatusesTable.channelId} = ${channelId}
            AND ${whatsappStatusesTable.waMessageId} = ${waMessageId}`,
      )
      .limit(1);
    if (existing[0]) return existing[0];
  }
  throw new Error("Status sent but local row could not be persisted");
}

// Bio / About — fetch own and update own.
export async function fetchOwnBio(
  userId: number,
): Promise<{ bio: string | null; setAt: string | null }> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const sock = (await getPrimaryCtxForUser(ownerUserId))?.sock ?? null;
  if (!sock) throw new Error("WhatsApp is not connected");
  const ownerJid = sock.user?.id;
  if (!ownerJid) throw new Error("WhatsApp user not available");
  try {
    const result = (await (sock as any).fetchStatus(ownerJid)) as
      | { status?: string | null; setAt?: Date | string | null }
      | Array<{
          status?: { status?: string | null; setAt?: Date | string | null };
        }>
      | null;
    let normalised: {
      status?: string | null;
      setAt?: Date | string | null;
    } | null = null;
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
  text: string,
): Promise<{ bio: string; setAt: string }> {
  const ownerUserId = await resolveOwnerUserId(userId);
  const sock = (await getPrimaryCtxForUser(ownerUserId))?.sock ?? null;
  if (!sock) throw new Error("WhatsApp is not connected");
  await (sock as any).updateProfileStatus(text);
  return { bio: text, setAt: new Date().toISOString() };
}

export async function sendContactToJid(
  userId: number,
  jid: string,
  contactName: string,
  contactPhone: string,
  channelId?: number,
): Promise<string | null> {
  // Send from the chat's OWN channel when a channelId is supplied (see
  // sendMediaToJid). Falls back to the primary socket for legacy callers.
  const sock =
    channelId != null
      ? getSockForChannel(channelId)
      : ((await getPrimaryCtxForUser(await resolveOwnerUserId(userId)))?.sock ??
        null);
  if (!sock) throw new Error("WhatsApp is not connected");
  const cleanPhone = contactPhone.replace(/[^\d+]/g, "");
  const waNumber = cleanPhone.startsWith("+")
    ? cleanPhone.slice(1)
    : cleanPhone;
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

// Extracts pin/archive metadata from a Baileys chat object.
function extractChatListMeta(c: Record<string, unknown>): {
  pinnedAt?: Date | null;
  isArchived?: boolean;
} {
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
  channelId: number,
  phoneNumber: string,
  c: Record<string, unknown>,
): Promise<void> {
  const meta = extractChatListMeta(c);
  if (Object.keys(meta).length > 0) {
    await db
      .update(chatsTable)
      .set(meta)
      .where(
        sql`${chatsTable.channelId} = ${channelId} AND ${chatsTable.phoneNumber} = ${phoneNumber}`,
      );
  }
  // Sync "read on the phone": when WhatsApp reports the chat as read, clear
  // MaxiChat's unread badge too. Guarded + atomic — we only clear when the
  // phone's read point covers the chat's latest message (lastMessageAt), so a
  // stale read event can never overwrite a newer inbound increment. Positive
  // unread counts are never mirrored (counted by MaxiChat's own inbound path).
  const readUpTo = readClearUpTo(c);
  if (readUpTo) {
    await db
      .update(chatsTable)
      .set({ unreadCount: 0 })
      .where(
        sql`${chatsTable.channelId} = ${channelId} AND ${chatsTable.phoneNumber} = ${phoneNumber} AND (${chatsTable.lastMessageAt} IS NULL OR ${chatsTable.lastMessageAt} <= ${readUpTo})`,
      );
  }
}

export async function getOrCreateChat(
  channelId: number,
  userId: number,
  phoneNumber: string,
  contactName: string,
  opts: { isLid?: boolean } = {},
) {
  void userId;
  const isLid = !!opts.isLid;
  const [row] = await db
    .insert(chatsTable)
    .values({
      channelId,
      phoneNumber,
      contactName,
      status: "ai_handled",
      tag: "none",
      isHumanTakeover: false,
      unreadCount: 0,
      isLid,
    })
    .onConflictDoUpdate({
      target: [chatsTable.channelId, chatsTable.phoneNumber],
      // For groups, keep the stored subject in sync with WhatsApp: overwrite
      // contact_name when an incoming, real subject is provided. Guard against
      // clobbering a good name with the numeric JID-prefix fallback (used when
      // group metadata isn't available yet during history sync). For 1:1 chats
      // we never touch contact_name here so user-set nicknames are preserved.
      set: phoneNumber.endsWith("@g.us")
        ? {
            contactName: sql`CASE WHEN ${contactName} <> '' AND ${contactName} !~ '^[0-9]+$' THEN ${contactName} ELSE ${chatsTable.contactName} END`,
          }
        : { phoneNumber: sql`${chatsTable.phoneNumber}` },
    })
    .returning();

  // Round-robin auto-assign on a freshly created, still-unassigned chat.
  // Fired async so an inbound-message hot path isn't blocked on it; any
  // failure is non-fatal (chat just stays unassigned and a supervisor can
  // assign manually).
  if (row && row.assignedUserId == null) {
    void autoAssignNewChat(userId, row.id).catch(() => {});
  }
  return row;
}

async function autoAssignNewChat(
  ownerUserId: number,
  chatId: number,
): Promise<void> {
  const { pickNextRoundRobinAgent, getAssignmentMode } =
    await import("../lib/round-robin");
  // channels.userId is the super_admin owner — no parent-walk needed.
  if ((await getAssignmentMode(ownerUserId)) !== "round_robin") return;
  const agentId = await pickNextRoundRobinAgent(ownerUserId);
  if (agentId == null) return;
  await db
    .update(chatsTable)
    .set({
      assignedUserId: agentId,
      firstAssignedAt: sql`COALESCE(${chatsTable.firstAssignedAt}, NOW())`,
    })
    .where(
      sql`${chatsTable.id} = ${chatId} AND ${chatsTable.assignedUserId} IS NULL`,
    );
}

export async function generateAiReply(
  channelId: number,
  userId: number,
  chatId: number,
  userMessage: string,
  // The DB id of the message that triggered this reply. When provided, history
  // is anchored causally to it (`id <= triggerMessageId`) so the model sees the
  // conversation as it was when this message arrived — even if newer messages
  // landed during the reply delay — and so the trigger is always the last turn.
  triggerMessageId?: number,
  // Optional per-node instruction (from an AI-node handoff) appended to the
  // global system prompt for THIS reply only. Empty/null = global prompt only.
  aiInstructionOverride?: string | null,
  // Optional per-node knowledge-base restriction (from an AI-node handoff):
  // when non-empty, only these knowledge entry ids are used as reference for
  // THIS reply. Empty/null = full knowledge base.
  knowledgeIdsOverride?: number[] | null,
): Promise<string | null> {
  try {
    const settingsRows = await db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.channelId, channelId))
      .limit(1);
    const settings = settingsRows[0];
    if (!settings?.autoReplyEnabled) return null;

    // General AI settings (system prompt etc.) are business-wide, keyed on the
    // tenant owner (userId), not per-channel.
    const tenant = await getOrCreateTenantSettings(userId);

    // When an AI-node handoff restricts the reference to specific entries, only
    // those (still scoped to the owner) are loaded so the AI answers strictly
    // from the chosen knowledge. Empty/null override = full knowledge base.
    const restrictKnowledgeIds = (knowledgeIdsOverride ?? []).filter(
      (n) => Number.isInteger(n) && n > 0,
    );
    const knowledgeEntries = await db
      .select()
      .from(knowledgeTable)
      .where(
        restrictKnowledgeIds.length
          ? and(
              eq(knowledgeTable.userId, userId),
              inArray(knowledgeTable.id, restrictKnowledgeIds),
            )
          : eq(knowledgeTable.userId, userId),
      );
    const knowledgeContext = knowledgeEntries
      .map((e) => `[${e.type.toUpperCase()}] ${e.title}:\n${e.content}`)
      .join("\n\n");

    // Live product catalog, read straight from the products table on every
    // reply so prices/codes are always current — no manual "sync to AI" step.
    // buildProductCatalogText excludes internal tier prices + stock.
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, userId))
      .orderBy(productsTable.id);
    const productCatalog = buildProductCatalogText(products);

    // Fetch the 10 MOST RECENT messages in chronological order. Without an
    // explicit ORDER BY, Postgres returns rows in an arbitrary order, so the
    // "history" could silently include stale months-old messages and omit the
    // latest turns — which made the model latch onto outdated context (e.g.
    // repeating a product comparison from a much earlier conversation).
    const recentMessages = (
      await db
        .select()
        .from(chatMessagesTable)
        .where(
          triggerMessageId
            ? and(
                eq(chatMessagesTable.chatId, chatId),
                lte(chatMessagesTable.id, triggerMessageId),
              )
            : eq(chatMessagesTable.chatId, chatId),
        )
        .orderBy(desc(chatMessagesTable.id))
        .limit(10)
    ).reverse();

    const history = recentMessages.map((m) => ({
      role:
        m.direction === "outbound" ? ("assistant" as const) : ("user" as const),
      // Strip the appended sender signature so the model doesn't learn to
      // sign its own replies (which would then get double-tagged by withTag).
      content:
        m.direction === "outbound" ? stripTrailingTag(m.content) : m.content,
    }));

    const extraInstruction = (aiInstructionOverride ?? "").trim();
    const systemPrompt = `${tenant.systemPrompt}${
      extraInstruction
        ? `

--- INSTRUKSI KHUSUS UNTUK PERCAKAPAN INI ---
${extraInstruction}
--- END INSTRUKSI KHUSUS ---`
        : ""
    }

ATURAN MUTLAK:
- HANYA gunakan informasi dari KATALOG PRODUK dan KNOWLEDGE BASE di bawah sebagai sumber kebenaran tentang produk, kategori, harga, dan layanan toko.
- KATALOG PRODUK adalah daftar harga resmi terkini. Saat customer menyebut nama atau kode produk (sebagian pun), cari di KATALOG PRODUK lalu jawab harga sesuai data tersebut. Jangan mengarang harga atau kode.
- Saat customer menanyakan produk dalam suatu kategori, tampilkan SEMUA produk yang relevan di kategori itu beserta harganya — JANGAN membatasi hanya beberapa item. Jika jumlahnya sangat banyak (lebih dari 20), sebutkan dulu total jumlah produk, tampilkan sebagian, lalu tawarkan untuk mengirim daftar lengkap atau bantu menyaring berdasarkan kebutuhan/budget.
- Jika riwayat percakapan menyebut produk, kategori bisnis, atau bidang usaha yang TIDAK ADA di katalog/knowledge base saat ini, abaikan sepenuhnya dan jangan ulang. Data bisa berubah — anggap riwayat lama yang tidak konsisten dengan data saat ini sudah tidak berlaku.
- Jika pertanyaan customer berada di luar katalog dan knowledge base, jawab dengan sopan bahwa admin akan membantu. Jangan menebak atau mengarang.

--- KATALOG PRODUK ---
${productCatalog || "Belum ada produk di katalog."}
--- END KATALOG PRODUK ---

--- KNOWLEDGE BASE ---
${knowledgeContext || "Tidak ada knowledge base yang tersedia."}
--- END KNOWLEDGE BASE ---`;

    // Resolve the tenant's AI client + model. Defaults to the managed Replit
    // integration (gpt-4o-mini) when the tenant hasn't opted into BYOK.
    const { client, model, provider, ownerUserId } =
      await resolveAiClient(userId);
    // The triggering message is already persisted, so it's normally the last
    // item in `history`. Only append it explicitly when recency ordering didn't
    // already capture it, so the same user turn isn't sent to the model twice.
    const lastTurn = history[history.length - 1];
    const includeUserMessage =
      !lastTurn || lastTurn.role !== "user" || lastTurn.content !== userMessage;

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        ...(includeUserMessage
          ? [{ role: "user" as const, content: userMessage }]
          : []),
      ],
      max_tokens: 1500,
      temperature: 0.7,
    });

    // Attribute token usage to the tenant owner (best-effort; never blocks the
    // reply). Telegram routes through this same function, so both channels are
    // covered here.
    void recordAiUsage({
      ownerUserId,
      channelId,
      provider,
      model,
      usage: response.usage,
    });

    return response.choices[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

interface IncomingMedia {
  mediaType: "image" | "video" | "document" | "audio" | "sticker" | "contact";
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
  // Sender identity inside a group (msg.key.participant). For 1:1 chats
  // and for outbound messages these stay null.
  senderJid: string | null;
  senderPhoneDigits: string | null;
  senderName: string | null;
  // Digits of contextInfo.mentionedJid (mentions in the message body),
  // in source order. Empty when the message has no mentions.
  mentionedPhoneDigits: string[];
  // Forwarding metadata from contextInfo. isForwarded marks the message as
  // forwarded; forwardingScore is WhatsApp's forward count (>=4 == "many times").
  isForwarded: boolean;
  forwardingScore: number;
  // Reply/quote context from contextInfo. quotedWaMessageId is the WA id of the
  // replied-to message (stanzaId); quotedContent is a text snapshot for the
  // reply bar. Both null when the message isn't a reply.
  quotedWaMessageId: string | null;
  quotedContent: string | null;
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
  resolveGroupName?: (jid: string) => Promise<string | null>,
  resolveLidToPn?: (lidJid: string) => Promise<string | null>,
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
  if (!isGroup && !jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid"))
    return null;

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

  if (
    inner.protocolMessage ||
    inner.senderKeyDistributionMessage ||
    inner.messageContextInfo
  ) {
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
  let mediaKind: "image" | "video" | "document" | "audio" | "sticker" | null =
    null;
  let mediaMime: string | null = null;
  let mediaFilename: string | null = null;

  if (inner.imageMessage) {
    mediaKind = "image";
    mediaMime = inner.imageMessage.mimetype ?? "image/jpeg";
  } else if (inner.stickerMessage) {
    // Stickers are webp images; download + show them like an image.
    mediaKind = "sticker";
    mediaMime = inner.stickerMessage.mimetype ?? "image/webp";
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
          {},
        )) as Buffer;
        const saved = await saveBufferToMedia(
          buf,
          mediaMime ?? "application/octet-stream",
          mediaFilename ?? undefined,
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
    const contact =
      inner.contactMessage ?? inner.contactsArrayMessage?.contacts?.[0];
    const displayName = contact?.displayName ?? "Kontak";
    media = {
      mediaType: "contact",
      mediaUrl: null,
      mediaMimeType: "text/vcard",
      mediaFilename: displayName,
    };
  } else if (inner.locationMessage || inner.liveLocationMessage) {
    const loc = inner.locationMessage ?? inner.liveLocationMessage;
    const name = loc?.name ? ` ${loc.name}` : "";
    if (!messageContent) messageContent = `📍 Lokasi${name}`;
  } else if (inner.pollCreationMessage || inner.pollCreationMessageV3) {
    const poll = inner.pollCreationMessage ?? inner.pollCreationMessageV3;
    if (!messageContent)
      messageContent = `📊 Polling: ${poll?.name ?? ""}`.trim();
  } else if (inner.groupInviteMessage) {
    if (!messageContent)
      messageContent =
        `👥 Undangan grup: ${inner.groupInviteMessage.groupName ?? ""}`.trim();
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
    const phoneJid = jid.endsWith("@s.whatsapp.net")
      ? jid
      : remoteJidAlt?.endsWith("@s.whatsapp.net")
        ? remoteJidAlt
        : jid;
    rawNumber = phoneJid.split("@")[0].split(":")[0];
    lidRawNumber = jid.endsWith("@lid")
      ? jid.split("@")[0].split(":")[0]
      : remoteJidAlt?.endsWith("@lid")
        ? remoteJidAlt.split("@")[0].split(":")[0]
        : null;
    // Never let an OUTBOUND (fromMe) message name the contact: on a fromMe
    // message msg.pushName is the OWNER's own WhatsApp display name, so using
    // it would label the customer's 1:1 chat with the operator's name (e.g.
    // every new chat the operator messages first would show as "Stephen
    // Maxipro"). Fall back to the number; the contact's real name comes from
    // their own inbound messages or a contacts.upsert.
    pushName = !msg.key?.fromMe && msg.pushName ? msg.pushName : rawNumber;
  }

  const waMessageId: string | null = msg.key?.id ?? null;
  const fromMe = !!msg.key?.fromMe;
  const timestamp = new Date(toEpochMs(msg.messageTimestamp));

  // Capture the participant who actually authored this message inside a
  // group. msg.key.participant is the canonical Baileys field; some
  // versions also expose participantPn / participantAlt for the
  // alternative LID/phone form. We only persist sender info for group
  // inbound messages — for 1:1 the chat header already names the
  // speaker, and outbound messages are always the operator.
  let senderJid: string | null = null;
  let senderPhoneDigits: string | null = null;
  let senderName: string | null = null;
  if (isGroup && !fromMe) {
    const candidates = [
      msg.key?.participantPn,
      msg.key?.participant,
      msg.key?.participantAlt,
      msg.participant,
    ].filter((j): j is string => typeof j === "string" && j.length > 0);

    // Prefer the real phone-number JID (@s.whatsapp.net). Newer WhatsApp
    // delivers group authors as a privacy LID (@lid) in msg.key.participant
    // whose numeric part is NOT a dialable phone number — using it for
    // "Balas pribadi" / "Kirim pesan" opened a bogus personal chat keyed by
    // the LID. participantPn carries the actual phone number when present.
    let phoneJid: string | null =
      candidates.find((j) => j.endsWith("@s.whatsapp.net")) ?? null;
    const lidJid = candidates.find((j) => j.endsWith("@lid")) ?? null;

    // If only a LID is available, map it back to the phone number via the
    // connection's LID store so the private-chat lookup matches the real
    // contact instead of an unreachable LID number.
    if (!phoneJid && lidJid && resolveLidToPn) {
      try {
        phoneJid = await resolveLidToPn(lidJid);
      } catch {
        phoneJid = null;
      }
    }

    // Canonical author id for grouping/avatars — the resolved phone JID when
    // we have one, else whatever identifier we got (may be a LID).
    senderJid = phoneJid ?? candidates[0] ?? null;
    // Phone digits drive "Kirim pesan" / "Balas pribadi": only ever expose a
    // real phone number here. If we could only obtain a LID, leave it null so
    // the UI says "nomor tidak diketahui" rather than opening the wrong chat.
    senderPhoneDigits = phoneJid
      ? phoneJid.split("@")[0].split(":")[0] || null
      : null;
    senderName = msg.pushName?.toString().trim() || null;
  }

  // Pull mention targets so the UI can swap raw "@628…" tokens in the
  // body for the contact's nickname. contextInfo lives on the
  // extendedTextMessage / mediaMessage wrappers depending on which
  // payload Baileys delivered.
  const mentionedJidRaw: unknown =
    inner.extendedTextMessage?.contextInfo?.mentionedJid ||
    inner.imageMessage?.contextInfo?.mentionedJid ||
    inner.videoMessage?.contextInfo?.mentionedJid ||
    inner.documentMessage?.contextInfo?.mentionedJid ||
    inner.conversation?.contextInfo?.mentionedJid ||
    [];
  const mentionedPhoneDigits: string[] = Array.isArray(mentionedJidRaw)
    ? (mentionedJidRaw as unknown[])
        .map((j) =>
          typeof j === "string" ? j.split("@")[0].split(":")[0] : null,
        )
        .filter((d): d is string => !!d)
    : [];

  // Forwarding markers live on the same per-type contextInfo as mentions.
  // WhatsApp sets forwardingScore (a count) and isForwarded; we treat any
  // positive score as forwarded too.
  const fwdContextInfo: any =
    inner.extendedTextMessage?.contextInfo ||
    inner.imageMessage?.contextInfo ||
    inner.videoMessage?.contextInfo ||
    inner.audioMessage?.contextInfo ||
    inner.documentMessage?.contextInfo ||
    inner.stickerMessage?.contextInfo ||
    inner.conversation?.contextInfo ||
    null;
  const forwardingScore = Number(fwdContextInfo?.forwardingScore ?? 0) || 0;
  const isForwarded = !!fwdContextInfo?.isForwarded || forwardingScore > 0;

  // Quoted/reply context: WhatsApp puts the replied-to message id in
  // contextInfo.stanzaId and a snapshot of its body in contextInfo.quotedMessage.
  // We capture the id (to link to our local row) and a text snapshot (to render
  // the grey reply bar even if we never stored the original).
  const quotedWaMessageId: string | null =
    (typeof fwdContextInfo?.stanzaId === "string" && fwdContextInfo.stanzaId) ||
    null;
  let quotedContent: string | null = null;
  if (quotedWaMessageId) {
    const qm = fwdContextInfo?.quotedMessage ?? null;
    quotedContent = extractQuotedText(qm);
  }

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
    senderJid,
    senderPhoneDigits,
    senderName,
    mentionedPhoneDigits,
    isForwarded,
    forwardingScore,
    quotedWaMessageId,
    quotedContent,
  };
}

// Pull a short text snapshot from a (possibly media) quotedMessage proto so we
// can render it in the reply bar. Mirrors buildPreview's media labels.
function extractQuotedText(qm: any): string | null {
  if (!qm || typeof qm !== "object") return null;
  const text: string =
    qm.conversation ||
    qm.extendedTextMessage?.text ||
    qm.imageMessage?.caption ||
    qm.videoMessage?.caption ||
    qm.documentMessage?.caption ||
    "";
  if (text && text.trim()) return text.trim();
  if (qm.imageMessage) return "📷 Gambar";
  if (qm.stickerMessage) return "🏷️ Stiker";
  if (qm.videoMessage) return "🎥 Video";
  if (qm.audioMessage) return "🎤 Audio";
  if (qm.documentMessage) return "📄 Dokumen";
  return null;
}

function buildPreview(messageText: string, media?: IncomingMedia): string {
  if (messageText.trim().length) return messageText;
  if (!media) return "";
  switch (media.mediaType) {
    case "image":
      return "📷 Gambar";
    case "sticker":
      return "🏷️ Stiker";
    case "video":
      return "🎥 Video";
    case "audio":
      return "🎤 Audio";
    case "document":
      return `📄 ${media.mediaFilename ?? "Dokumen"}`;
    case "contact":
      return `👤 ${media.mediaFilename ?? "Kontak"}`;
    default:
      return "Media";
  }
}

async function persistWaMessage(
  userId: number,
  channelId: number,
  parsed: ParsedWaMessage,
  opts: { incrementUnread: boolean },
): Promise<{
  chat: typeof chatsTable.$inferSelect;
  inserted: boolean;
  messageId: number | null;
}> {
  const phoneNumber = parsed.isGroup ? parsed.jid : `+${parsed.rawNumber}`;
  const contactName = parsed.pushName || parsed.rawNumber;

  if (
    !parsed.isGroup &&
    parsed.lidRawNumber &&
    parsed.lidRawNumber !== parsed.rawNumber
  ) {
    const lidPhone = `+${parsed.lidRawNumber}`;
    // Best-effort reconciliation: a failure here must NEVER block persistence of
    // the current inbound message below. A throwing merge previously aborted the
    // whole handler and silently dropped the message (and every later one).
    try {
      await db.transaction(async (tx) => {
        const candidates = await tx
          .select()
          .from(chatsTable)
          .where(
            sql`${chatsTable.channelId} = ${channelId}
              AND ${chatsTable.phoneNumber} IN (${lidPhone}, ${phoneNumber})`,
          )
          .orderBy(chatsTable.phoneNumber)
          .for("update");

        const lidChat = candidates.find((c) => c.phoneNumber === lidPhone);
        if (!lidChat) return;
        const realChat = candidates.find((c) => c.phoneNumber === phoneNumber);

        if (realChat) {
          // Move the LID chat's messages onto the canonical chat, but ONLY the
          // ones whose wa_message_id isn't already present on the canonical chat.
          // The same WhatsApp message can land in both chats (once keyed by LID,
          // once by phone); a blind reassignment then violates the
          // (chat_id, wa_message_id) unique constraint, aborts the whole
          // transaction, and — because the LID chat is never deleted — makes
          // EVERY later message for this contact re-run the same failing merge
          // and get dropped. Leaving the colliding rows behind and deleting the
          // LID chat (FK cascade) discards only true duplicates.
          await tx
            .update(chatMessagesTable)
            .set({ chatId: realChat.id })
            .where(
              sql`${chatMessagesTable.chatId} = ${lidChat.id}
                AND (
                  ${chatMessagesTable.waMessageId} IS NULL
                  OR ${chatMessagesTable.waMessageId} NOT IN (
                    SELECT wa_message_id FROM chat_messages
                    WHERE chat_id = ${realChat.id} AND wa_message_id IS NOT NULL
                  )
                )`,
            );
          await tx.delete(chatsTable).where(eq(chatsTable.id, lidChat.id));
          await tx
            .update(chatsTable)
            .set({ isLid: false })
            .where(eq(chatsTable.id, realChat.id));
          logger.info(
            { lidPhone, phoneNumber },
            "Merged stale LID-keyed chat into canonical phone chat",
          );
        } else {
          await tx
            .update(chatsTable)
            .set({ phoneNumber, contactName, isLid: false })
            .where(eq(chatsTable.id, lidChat.id));
          logger.info(
            { lidPhone, phoneNumber },
            "Renamed stale LID-keyed chat to canonical phone",
          );
        }
      });
    } catch (err) {
      logger.warn(
        { err, lidPhone, phoneNumber, channelId },
        "LID chat reconciliation failed; persisting message to canonical chat anyway",
      );
    }
  }

  const isLidChat =
    !parsed.isGroup &&
    parsed.lidRawNumber !== null &&
    parsed.lidRawNumber === parsed.rawNumber;
  const chat = await getOrCreateChat(
    channelId,
    userId,
    phoneNumber,
    contactName,
    { isLid: isLidChat },
  );
  const direction = parsed.fromMe ? "outbound" : "inbound";

  const senderColumns = {
    senderJid: parsed.senderJid,
    senderPhoneDigits: parsed.senderPhoneDigits,
    senderName: parsed.senderName,
    mentionedPhoneDigits: parsed.mentionedPhoneDigits.length
      ? parsed.mentionedPhoneDigits
      : null,
  };

  // Resolve the local row this message replies to (if any) so the UI can link
  // back to it. We match on (chatId, quotedWaMessageId); the row may not exist
  // yet (e.g. quoting a very old message we never stored), in which case the
  // snapshot text alone still renders the reply bar. quotedSender is derived
  // from the resolved row's direction/sender.
  let quotedColumns: {
    quotedMessageId: number | null;
    quotedWaMessageId: string | null;
    quotedContent: string | null;
    quotedSender: string | null;
  } | null = null;
  if (parsed.quotedWaMessageId) {
    const [q] = await db
      .select({
        id: chatMessagesTable.id,
        direction: chatMessagesTable.direction,
        senderName: chatMessagesTable.senderName,
      })
      .from(chatMessagesTable)
      .where(
        and(
          eq(chatMessagesTable.chatId, chat.id),
          eq(chatMessagesTable.waMessageId, parsed.quotedWaMessageId),
        ),
      )
      .limit(1);
    const quotedSender = q
      ? q.direction === "outbound"
        ? "Anda"
        : (q.senderName ?? contactName)
      : null;
    quotedColumns = {
      quotedMessageId: q?.id ?? null,
      quotedWaMessageId: parsed.quotedWaMessageId,
      quotedContent: parsed.quotedContent,
      quotedSender,
    };
  }

  let inserted = true;
  let messageId: number | null = null;
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
        isForwarded: parsed.isForwarded,
        forwardingScore: parsed.forwardingScore,
        createdAt: parsed.timestamp,
        ...senderColumns,
        ...(quotedColumns ?? {}),
      })
      .onConflictDoNothing({
        target: [chatMessagesTable.chatId, chatMessagesTable.waMessageId],
      })
      .returning({ id: chatMessagesTable.id });
    inserted = result.length > 0;
    messageId = result[0]?.id ?? null;

    // Back-fill an already-persisted row when this pass finally has data
    // the original insert lacked. Two real-world cases:
    //   1) A history-sync chunk first stored the row with mediaUrl=null
    //      (download was disabled). A later resync now has the file.
    //   2) The initial insert was outbound or arrived before we captured
    //      sender info; a later prepend/append carries the participant.
    // We only fill NULLs (COALESCE) so we never clobber an already-good
    // value, and never touch immutable fields like content/timestamp.
    if (!inserted) {
      const fillSet: Record<string, unknown> = {};
      if (parsed.media?.mediaUrl) {
        fillSet.mediaUrl = sql`COALESCE(${chatMessagesTable.mediaUrl}, ${parsed.media.mediaUrl})`;
        if (parsed.media.mediaType) {
          fillSet.mediaType = sql`COALESCE(${chatMessagesTable.mediaType}, ${parsed.media.mediaType})`;
        }
        if (parsed.media.mediaMimeType) {
          fillSet.mediaMimeType = sql`COALESCE(${chatMessagesTable.mediaMimeType}, ${parsed.media.mediaMimeType})`;
        }
        if (parsed.media.mediaFilename) {
          fillSet.mediaFilename = sql`COALESCE(${chatMessagesTable.mediaFilename}, ${parsed.media.mediaFilename})`;
        }
      }
      if (parsed.senderJid) {
        fillSet.senderJid = sql`COALESCE(${chatMessagesTable.senderJid}, ${parsed.senderJid})`;
      }
      if (parsed.senderPhoneDigits) {
        fillSet.senderPhoneDigits = sql`COALESCE(${chatMessagesTable.senderPhoneDigits}, ${parsed.senderPhoneDigits})`;
      }
      if (parsed.senderName) {
        fillSet.senderName = sql`COALESCE(${chatMessagesTable.senderName}, ${parsed.senderName})`;
      }
      if (parsed.mentionedPhoneDigits.length) {
        // drizzle's `sql` tag spreads a JS array into an SQL tuple `($1,$2,…)`,
        // which is incompatible with a text[] column. Build an explicit
        // `ARRAY[$1,$2,…]::text[]` literal so a single param stays a 1-element
        // array and an N-element array stays N-element.
        const mentionedArr = sql`ARRAY[${sql.join(
          parsed.mentionedPhoneDigits.map((d) => sql`${d}`),
          sql`, `,
        )}]::text[]`;
        fillSet.mentionedPhoneDigits = sql`COALESCE(${chatMessagesTable.mentionedPhoneDigits}, ${mentionedArr})`;
      }
      if (Object.keys(fillSet).length > 0) {
        await db
          .update(chatMessagesTable)
          .set(fillSet)
          .where(
            and(
              eq(chatMessagesTable.chatId, chat.id),
              eq(chatMessagesTable.waMessageId, parsed.waMessageId),
            ),
          );
      }
    }
  } else {
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
        waMessageId: null,
        createdAt: parsed.timestamp,
        ...senderColumns,
        ...(quotedColumns ?? {}),
      })
      .returning({ id: chatMessagesTable.id });
    messageId = result[0]?.id ?? null;
  }

  if (!inserted) return { chat, inserted, messageId };

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

  return { chat, inserted, messageId };
}

// ---------- Chatbot flow engine ----------

function renderQuestion(node: FlowNode, overrideText?: string | null): string {
  const lines: string[] = [];
  const text = overrideText ?? node.data.text;
  if (text) lines.push(text);
  const opts = node.data.options ?? [];
  opts.forEach((o, i) => lines.push(`${i + 1}. ${o.label}`));
  return lines.join("\n");
}

// "AI Generate" on a question node: rephrase the question text (same meaning,
// varied natural wording) so it doesn't feel like a canned bot message. Only
// the lead text is rephrased — answer options are kept verbatim so pickOption's
// exact label/number matching keeps working. Best-effort: on any failure (or
// empty model output) we fall back to the original text and never block the
// flow. Token usage is attributed to the tenant owner.
async function rephraseFlowQuestionText(
  userId: number,
  channelId: number,
  text: string,
): Promise<string> {
  try {
    const { client, model, provider, ownerUserId } =
      await resolveAiClient(userId);
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: FLOW_REPHRASE_SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      max_tokens: 300,
      temperature: 1,
    });
    void recordAiUsage({
      ownerUserId,
      channelId,
      provider,
      model,
      usage: response.usage,
    });
    return cleanRephrasedText(response.choices[0]?.message?.content, text);
  } catch {
    return text;
  }
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Random human-like pause (ms) derived from the tenant's reply-delay bounds
// (stored in seconds). Mirrors the AI auto-reply jitter so the chatbot flow
// doesn't fire messages back-to-back in milliseconds — rapid-fire sends are a
// strong bot/spam signal that risks WhatsApp restricting the number.
function flowSendDelayMs(
  minSec: number | null | undefined,
  maxSec: number | null | undefined,
): number {
  const min = Math.max(0, (minSec ?? 1) * 1000);
  const max = Math.max(min, (maxSec ?? 3) * 1000);
  return Math.random() * (max - min) + min;
}

// Best-effort "typing…" indicator on a WhatsApp chat for the given duration,
// then mark it paused. Presence is decorative: any failure is swallowed so it
// can never block the actual message send.
async function typingPause(
  sock: WASocket,
  jid: string,
  ms: number,
): Promise<void> {
  try {
    await sock.presenceSubscribe(jid);
    await sock.sendPresenceUpdate("composing", jid);
  } catch {
    /* presence is best-effort */
  }
  await sleep(ms);
  try {
    await sock.sendPresenceUpdate("paused", jid);
  } catch {
    /* presence is best-effort */
  }
}

async function sendFlowMessage(
  userId: number,
  channelId: number,
  epoch: number,
  chatId: number,
  jid: string,
  text: string,
  imageUrl?: string | null,
  delayBounds?: { min?: number | null; max?: number | null },
): Promise<boolean> {
  const ctx = getCtxByChannel(channelId, userId);
  if (epoch !== ctx.epoch) return false;
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
      logger.warn(
        { err, imageUrl, chatId },
        "flow image load failed; sending text only",
      );
    }
  }

  // Human-like pacing before each flow send: show a "typing…" indicator and
  // pause for a random interval. Without this a flow step (especially a
  // Products node that sends many cards) fires several messages within
  // milliseconds — a strong bot/spam signal that risks WhatsApp bans. The
  // delay is applied per message, so multi-image Products nodes get a pause
  // between every product. Reuses the tenant's reply-delay bounds.
  if (delayBounds) {
    const waitMs = flowSendDelayMs(delayBounds.min, delayBounds.max);
    await typingPause(ctx.sock, jid, waitMs);
    // The pause is non-trivial; bail if the channel disconnected meanwhile
    // (epoch bump) or the socket was torn down during the wait.
    if (epoch !== ctx.epoch || !ctx.sock) return false;
  }

  // Tag every chatbot-flow send so the recipient can tell the reply was
  // produced by the automated flow (vs a human agent or the AI).
  const taggedText = text ? withTag(text, CHATBOT_TAG) : "";
  let sent;
  if (imageBuffer) {
    sent = await ctx.sock.sendMessage(jid, {
      image: imageBuffer,
      // Sign the caption even when the flow node had no text — the
      // image-only case still benefits from the "Chatbot" attribution.
      caption: taggedText || withTag("", CHATBOT_TAG),
    });
  } else if (taggedText) {
    sent = await ctx.sock.sendMessage(jid, { text: taggedText });
  } else {
    // Image-only node whose image failed to load — bail out instead of
    // sending an empty text message (which Baileys would reject anyway).
    return false;
  }
  const stored = taggedText || (imageBuffer ? "[gambar]" : "");
  await db
    .insert(chatMessagesTable)
    .values({
      chatId,
      direction: "outbound",
      content: stored,
      isAiGenerated: false,
      waMessageId: sent?.key?.id ?? null,
    })
    .onConflictDoNothing({
      target: [chatMessagesTable.chatId, chatMessagesTable.waMessageId],
    });
  await db
    .update(chatsTable)
    .set({
      lastMessage: stored,
      lastMessageAt: new Date(),
      status: "ai_handled",
    })
    .where(eq(chatsTable.id, chatId));
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
export async function loadImageBuffer(imageUrl: string): Promise<Buffer> {
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
          try {
            await reader.cancel();
          } catch {}
          throw new Error(
            `response exceeded ${MAX_EXTERNAL_IMAGE_BYTES} bytes`,
          );
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
  channelId: number,
  epoch: number,
  chatId: number,
  jid: string,
  flowId: number,
  graph: FlowGraph,
  startNodeId: string,
  cooldownMs: number,
): Promise<void> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  let cursorId: string | null = startNodeId;
  const visited = new Set<string>();

  // Reply-delay bounds are tenant-wide (shared with the AI auto-reply). Fetch
  // once per flow run and reuse for every send so each message gets its own
  // fresh random "typing…" pause.
  const tenant = await getOrCreateTenantSettings(userId);
  const delayBounds = { min: tenant.replyDelayMin, max: tenant.replyDelayMax };

  while (cursorId) {
    if (visited.has(cursorId)) break; // cycle guard
    visited.add(cursorId);
    const node = nodesById.get(cursorId);
    if (!node) break;

    if (node.type === "message") {
      if (node.data.text || node.data.imageUrl) {
        const ok = await sendFlowMessage(
          userId,
          channelId,
          epoch,
          chatId,
          jid,
          node.data.text ?? "",
          node.data.imageUrl ?? null,
          delayBounds,
        );
        if (!ok) return;
      }
      const next = graph.edges.find(
        (e) => e.source === cursorId && !e.sourceHandle,
      );
      cursorId = next?.target ?? null;
      continue;
    }

    if (node.type === "question") {
      let qText = node.data.text ?? "";
      if (node.data.aiRephrase && qText.trim()) {
        qText = await rephraseFlowQuestionText(userId, channelId, qText);
      }
      const text = renderQuestion(node, qText);
      const ok = await sendFlowMessage(
        userId,
        channelId,
        epoch,
        chatId,
        jid,
        text,
        node.data.imageUrl ?? null,
        delayBounds,
      );
      if (!ok) return;
      await db
        .update(chatsTable)
        .set({ flowState: { flowId, currentNodeId: node.id } })
        .where(eq(chatsTable.id, chatId));
      return;
    }

    if (node.type === "products") {
      const ids = (node.data.productIds ?? []).filter(
        (n) => Number.isInteger(n) && n > 0,
      );
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
          .where(
            and(
              eq(productsTable.userId, userId),
              inArray(productsTable.id, ids),
            ),
          );
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
            channelId,
            epoch,
            chatId,
            jid,
            caption,
            p.imageUrl ?? null,
            delayBounds,
          );
          if (!ok) return;
        }
      }
      const next = graph.edges.find(
        (e) => e.source === cursorId && !e.sourceHandle,
      );
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
        const ok = await sendFlowMessage(
          userId,
          channelId,
          epoch,
          chatId,
          jid,
          node.data.text,
          null,
          delayBounds,
        );
        if (!ok) return;
      }
      const handoffInstruction = (node.data.aiInstruction ?? "").trim();
      const handoffKnowledgeIds = (node.data.knowledgeIds ?? []).filter(
        (n) => Number.isInteger(n) && n > 0,
      );
      await db
        .update(chatsTable)
        .set({
          flowState: {
            defaultMutedUntil: Date.now() + cooldownMs,
            ...(handoffInstruction
              ? { aiInstruction: handoffInstruction }
              : {}),
            ...(handoffKnowledgeIds.length
              ? { knowledgeIds: handoffKnowledgeIds }
              : {}),
          },
        })
        .where(eq(chatsTable.id, chatId));
      return;
    }

    // Trigger or unknown — just follow first outgoing edge.
    const next = graph.edges.find(
      (e) => e.source === cursorId && !e.sourceHandle,
    );
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
  channelId: number,
  epoch: number,
  chat: typeof chatsTable.$inferSelect,
  jid: string,
  messageText: string,
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
  const state = (fresh?.flowState ?? null) as {
    flowId?: number;
    currentNodeId?: string;
    defaultMutedUntil?: number;
    aiInstruction?: string;
    knowledgeIds?: number[];
  } | null;
  // Cooldown after any flow exit before the Default trigger may re-fire.
  // Configurable business-wide in Settings (5/15/30/60/120 minutes), keyed
  // on the tenant owner.
  const tenant = await getOrCreateTenantSettings(userId);
  const cooldownMin = tenant.flowCooldownMinutes ?? 5;
  const cooldownMs = cooldownMin * 60 * 1000;
  const muteState = { defaultMutedUntil: Date.now() + cooldownMs };
  // Same human-like pacing the rest of the flow uses, for the strict-option
  // re-ask sends below (nudge + re-asked question).
  const delayBounds = { min: tenant.replyDelayMin, max: tenant.replyDelayMax };

  // Case A: chat is mid-flow at a question → try to advance.
  if (state && state.flowId && state.currentNodeId) {
    // Flows are owner-scoped now; a chat mid-flow keeps running its flow as
    // long as it still belongs to this owner (channel assignment can change
    // underneath an in-progress conversation without aborting it).
    const [flowRow] = await db
      .select()
      .from(chatbotFlowsTable)
      .where(
        and(
          eq(chatbotFlowsTable.id, state.flowId),
          eq(chatbotFlowsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!flowRow) {
      await db
        .update(chatsTable)
        .set({ flowState: muteState })
        .where(eq(chatsTable.id, chat.id));
      return false;
    }
    const graph = flowRow.graph as FlowGraph;
    const node = graph.nodes.find((n) => n.id === state.currentNodeId);
    if (!node || node.type !== "question") {
      await db
        .update(chatsTable)
        .set({ flowState: muteState })
        .where(eq(chatsTable.id, chat.id));
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
            channelId,
            epoch,
            chat.id,
            jid,
            retryMsg,
            null,
            delayBounds,
          );
          if (!okMsg) return false;
        }
        let reText = node.data.text ?? "";
        if (node.data.aiRephrase && reText.trim()) {
          reText = await rephraseFlowQuestionText(userId, channelId, reText);
        }
        const questionText = renderQuestion(node, reText);
        const ok = await sendFlowMessage(
          userId,
          channelId,
          epoch,
          chat.id,
          jid,
          questionText,
          node.data.imageUrl ?? null,
          delayBounds,
        );
        // If the re-ask failed to send, don't claim the flow handled the
        // message — fall through to AI so the customer isn't left in silence.
        return ok;
      }
      // Unrecognised reply → user is asking a free-form question, let AI handle it.
      await db
        .update(chatsTable)
        .set({ flowState: muteState })
        .where(eq(chatsTable.id, chat.id));
      return false;
    }

    const edge = graph.edges.find(
      (e) => e.source === node.id && e.sourceHandle === optId,
    );
    if (!edge) {
      // Picked an option that the flow author never wired up → AI takes over.
      await db
        .update(chatsTable)
        .set({ flowState: muteState })
        .where(eq(chatsTable.id, chat.id));
      return false;
    }
    await runFlowFrom(
      userId,
      channelId,
      epoch,
      chat.id,
      jid,
      flowRow.id,
      graph,
      edge.target,
      cooldownMs,
    );
    return true;
  }

  // Case B: not in a flow → try to match a trigger from the active flow that
  // applies to THIS channel. Flows are owner-scoped and assigned to channels
  // via chatbot_flow_channels (no rows = global / all channels). The activate
  // endpoint guarantees at most one active flow per channel; we still prefer a
  // flow explicitly assigned to this channel over a global one, defensively.
  const activeFlows = await db
    .select()
    .from(chatbotFlowsTable)
    .where(
      and(
        eq(chatbotFlowsTable.userId, userId),
        eq(chatbotFlowsTable.isActive, true),
      ),
    )
    // Deterministic order so that, even in the (invariant-guarded) edge case
    // where two active flows somehow apply to the same channel, the most
    // recently updated one wins consistently rather than by DB row order.
    .orderBy(desc(chatbotFlowsTable.updatedAt), desc(chatbotFlowsTable.id));
  let active: (typeof activeFlows)[number] | undefined;
  if (activeFlows.length > 0) {
    const ids = activeFlows.map((f) => f.id);
    const assignRows = await db
      .select({
        fid: chatbotFlowChannelsTable.flowId,
        cid: chatbotFlowChannelsTable.channelId,
      })
      .from(chatbotFlowChannelsTable)
      .where(inArray(chatbotFlowChannelsTable.flowId, ids));
    const byFlow = new Map<number, Set<number>>();
    for (const id of ids) byFlow.set(id, new Set());
    for (const r of assignRows) byFlow.get(r.fid)?.add(r.cid);
    active =
      activeFlows.find((f) => byFlow.get(f.id)!.has(channelId)) ??
      activeFlows.find((f) => byFlow.get(f.id)!.size === 0);
  }
  if (!active) return false;
  const graph = active.graph as FlowGraph;
  const lower = text.toLowerCase();

  // Only consider triggers that actually have an outgoing edge — an
  // orphan trigger (left behind during editing) must not block the flow.
  const hasOutgoing = (id: string) => graph.edges.some((e) => e.source === id);
  const triggers = graph.nodes.filter(
    (n) => n.type === "trigger" && hasOutgoing(n.id),
  );
  // Keyword triggers always win (explicit intent) and bypass the mute.
  const keywordHit = triggers.find(
    (n) =>
      (n.data.matchType ?? "keyword") === "keyword" &&
      (n.data.keywords ?? []).some((k) => k && lower.includes(k.toLowerCase())),
  );
  const defaultMuted =
    !!state?.defaultMutedUntil && Date.now() < state.defaultMutedUntil;
  const start =
    keywordHit ??
    (defaultMuted
      ? undefined
      : triggers.find((n) => n.data.matchType === "default"));
  if (!start) return false;

  const firstEdge = graph.edges.find((e) => e.source === start.id);
  if (!firstEdge) return false;

  // If the muted period expired and we're re-entering via Default, drop the
  // stale `defaultMutedUntil` marker so the chat state is clean going in.
  // (runFlowFrom will overwrite flowState with either question or
  // new mute on exit, but this keeps semantics tidy.)
  await runFlowFrom(
    userId,
    channelId,
    epoch,
    chat.id,
    jid,
    active.id,
    graph,
    firstEdge.target,
    cooldownMs,
  );
  return true;
}

async function maybeTriggerAutoReply(
  userId: number,
  channelId: number,
  epoch: number,
  chat: typeof chatsTable.$inferSelect,
  jid: string,
  messageText: string,
  triggerMessageId?: number,
) {
  if (chat.isHumanTakeover) return;
  if (!messageText.trim()) return;

  // Subscription gate: an expired/suspended tenant's bot goes silent (no flow,
  // no AI). The owner can still view chats and reply manually is also blocked
  // by the write enforcement, but inbound messages are still recorded.
  try {
    const owner = await resolveOwnerUserId(userId);
    if (await isOwnerReadOnly(owner)) return;
  } catch (err) {
    logger.error({ err, userId }, "auto-reply subscription gate failed");
    return;
  }

  // Try chatbot flow before AI. If a flow handled the message (matched a
  // trigger or advanced from a question), skip the AI auto-reply entirely.
  try {
    const handled = await tryRunFlow(
      userId,
      channelId,
      epoch,
      chat,
      jid,
      messageText,
    );
    if (handled) return;
  } catch (err) {
    logger.error({ err }, "Flow engine failed; falling back to AI");
  }

  const settingsRows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.channelId, channelId))
    .limit(1);
  const settings = settingsRows[0];
  if (!settings?.autoReplyEnabled) return;

  // Reply delay + fallback message are business-wide (tenant), not per-channel.
  const tenant = await getOrCreateTenantSettings(userId);
  const delayMin = (tenant.replyDelayMin ?? 1) * 1000;
  const delayMax = (tenant.replyDelayMax ?? 3) * 1000;
  const delay = Math.random() * (delayMax - delayMin) + delayMin;

  setTimeout(async () => {
    try {
      const ctx = getCtxByChannel(channelId, userId);
      // Cross-session safety per THIS channel: bail if disconnect (epoch
      // bump) happened during the delay.
      if (epoch !== ctx.epoch) return;

      // If we arrived here via an AI-node handoff, that node may carry a
      // per-node instruction stored in flowState. Apply it only while the
      // handoff window (defaultMutedUntil) is still active, so it expires
      // naturally with the cooldown and never lingers on later replies.
      const [freshChat] = await db
        .select({ flowState: chatsTable.flowState })
        .from(chatsTable)
        .where(eq(chatsTable.id, chat.id))
        .limit(1);
      const handoffState = (freshChat?.flowState ?? null) as {
        defaultMutedUntil?: number;
        aiInstruction?: string;
        knowledgeIds?: number[];
      } | null;
      const handoffActive =
        !!handoffState?.defaultMutedUntil &&
        Date.now() < handoffState.defaultMutedUntil;
      const aiInstructionOverride =
        handoffActive && handoffState?.aiInstruction
          ? handoffState.aiInstruction
          : null;
      const knowledgeIdsOverride =
        handoffActive && handoffState?.knowledgeIds?.length
          ? handoffState.knowledgeIds
          : null;

      const aiReply = await generateAiReply(
        channelId,
        userId,
        chat.id,
        messageText,
        triggerMessageId,
        aiInstructionOverride,
        knowledgeIdsOverride,
      );
      // Sign AI-generated replies with the "powered by AI" tag. The
      // configured fallbackMessage is a canned operator-authored string,
      // so we leave it unsigned to avoid misattributing it to the AI.
      const replyText = aiReply
        ? withTag(aiReply, AI_TAG)
        : tenant.fallbackMessage;

      if (epoch !== ctx.epoch) return;

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
          .onConflictDoNothing({
            target: [chatMessagesTable.chatId, chatMessagesTable.waMessageId],
          });

        await db
          .update(chatsTable)
          .set({
            lastMessage: replyText,
            lastMessageAt: new Date(),
            status: "ai_handled",
          })
          .where(eq(chatsTable.id, chat.id));
      }
    } catch (err) {
      logger.error({ err }, "Auto-reply failed");
    }
  }, delay);
}

async function startBaileys(userId: number, channelId: number) {
  const ctx = getCtxByChannel(channelId, userId);
  if (ctx.isConnecting || (ctx.sock && (ctx.sock as any).ws?.readyState === 1))
    return;
  ctx.isConnecting = true;
  const myEpoch = ++ctx.epoch;

  try {
    const {
      useMultiFileAuthState,
      makeWASocket,
      DisconnectReason,
      isJidGroup,
    } = await import("@whiskeysockets/baileys");

    const { Boom } = await import("@hapi/boom");
    const { default: NodeCache } = await import("node-cache");

    const authDir = authDirForChannel(userId, channelId);
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
        // Per-channel pairing state lives on the channels row.
        void syncChannelStatus(channelId, {
          status: "qr_ready",
          qrCode: dataUrl,
        });
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
                "WhatsApp number already paired to another account; rejecting connection",
              );
              ctx.ownerPhone = null;
              // Await so the channel row reflects 'disconnected' before
              // we tear down the socket — UI polling must not see a stale
              // qr_ready/connecting state after rejection.
              await syncChannelStatus(channelId, {
                status: "disconnected",
                qrCode: null,
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
              "Failed to persist user_whatsapp mapping; refusing to expose ownerPhone",
            );
            ctx.ownerPhone = null;
            await syncChannelStatus(channelId, {
              status: "disconnected",
              qrCode: null,
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
        // Keep channels.status / channels.owner_phone in lockstep with the
        // live ctx. The frontend switcher reads these to render per-channel
        // connectivity dots. connectedAt is persisted so the legacy
        // /whatsapp/status response shape stays accurate after E1.
        const ownerName = sock.user?.name ?? sock.user?.verifiedName ?? null;
        void syncChannelStatus(channelId, {
          status: "connected",
          ownerPhone: normalised,
          ownerName,
          qrCode: null,
          connectedAt: new Date().toISOString(),
        });
        ctx.isConnecting = false;
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as InstanceType<typeof Boom>)
          ?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        // Clear connectedAt so the legacy /whatsapp/status no longer
        // reports a stale connection time after a drop.
        // Channel mirror: socket dropped. We deliberately do NOT clear
        // channels.owner_phone here — the binding (this channel "owns"
        // this number) survives transient network drops, matching the
        // pre-migration behavior of user_whatsapp. Hard unpair is the
        // /disconnect endpoint, which also leaves owner_phone (see the
        // note there).
        void syncChannelStatus(channelId, {
          status: "disconnected",
          qrCode: null,
          connectedAt: null,
        });
        ctx.sock = null;
        ctx.isConnecting = false;
        ctx.ownerPhone = null;
        if (loggedOut) {
          // The session is dead — the number was logged out remotely (from
          // the phone or by WhatsApp) or the on-disk creds went stale. With
          // creds still on disk Baileys keeps trying to RESUME them on every
          // /connect and never emits a pairing QR, so the channel is stuck on
          // "disconnected" and the Connect button appears to do nothing. Wipe
          // the auth state and restart once so a fresh registration produces a
          // new QR — the same recovery /disconnect performs, but automatic so
          // re-pairing works from the Connect button alone.
          await fs
            .rm(authDirForChannel(userId, channelId), {
              recursive: true,
              force: true,
            })
            .catch((err) =>
              logger.warn(
                { err, channelId },
                "Failed to wipe auth dir after logout",
              ),
            );
          setTimeout(
            () => startBaileys(userId, channelId).catch(() => {}),
            1000,
          );
        } else {
          // Transient drop (network, restart-required, etc.): resume with the
          // existing creds rather than forcing a re-pair.
          setTimeout(
            () => startBaileys(userId, channelId).catch(() => {}),
            3000,
          );
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

    // Map a privacy LID (@lid) group author back to their real phone-number
    // JID via Baileys' LID store, so "Balas pribadi" / "Kirim pesan" resolve
    // to the actual contact instead of an unreachable LID number. Only
    // successful resolutions are cached — a miss is left uncached so a later
    // message re-checks once Baileys has learned the mapping (the lookup is a
    // cheap local store read), avoiding a permanently-stuck "unknown number".
    const lidPnCache = new Map<string, string>();
    const resolveLidToPn = async (lidJid: string): Promise<string | null> => {
      const cached = lidPnCache.get(lidJid);
      if (cached) return cached;
      try {
        const store = (sock as any)?.signalRepository?.lidMapping;
        const pn =
          store && typeof store.getPNForLID === "function"
            ? await store.getPNForLID(lidJid)
            : null;
        if (typeof pn === "string" && pn.endsWith("@s.whatsapp.net")) {
          lidPnCache.set(lidJid, pn);
          return pn;
        }
      } catch {
        // fall through to null
      }
      return null;
    };

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (myEpoch !== ctx.epoch) return;
      const ownerPhone = ctx.ownerPhone;
      if (!ownerPhone) return;
      const ownerJid = sock.user?.id ?? "";
      logger.info(
        {
          type,
          count: messages.length,
          jids: messages.map((m) => m.key.remoteJid),
        },
        "messages.upsert received",
      );
      // Process all real message-event types. Baileys emits:
      //   - "notify"   = brand-new live message
      //   - "append"   = catch-up message during sync
      //   - "prepend"  = older message being backfilled after history sync
      //   - "replace"  = edited/replacement message
      // Previously we only accepted notify/append, which silently dropped
      // backfilled history chunks ("putus chat" in MaxiChat while the
      // message was still present on the phone).
      if (
        type !== "notify" &&
        type !== "append" &&
        type !== "prepend" &&
        type !== "replace"
      ) {
        return;
      }

      for (const msg of messages) {
        try {
          // Don't bail out of the whole batch if the connection epoch
          // changes mid-loop — we already captured ownerPhone, so each
          // surviving message can still be persisted safely. A `return`
          // here used to silently lose the tail of every batch when the
          // socket flickered, because Baileys won't re-emit those events.
          if (msg.key?.remoteJid === "status@broadcast") {
            await persistWaStatus(
              channelId,
              ownerJid,
              msg,
              downloadMediaMessage,
              true,
            ).catch((err) =>
              logger.error({ err }, "Failed to persist live status"),
            );
            continue;
          }
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            true,
            resolveGroupName,
            resolveLidToPn,
          );
          if (!parsed) continue;

          const { chat, inserted, messageId } = await persistWaMessage(
            userId,
            channelId,
            parsed,
            {
              incrementUnread: true,
            },
          );
          if (!inserted) continue;
          if (parsed.fromMe) continue;
          if (parsed.isGroup) continue;
          // Auto-reply is the only place where a stale epoch genuinely
          // matters (we shouldn't reply on behalf of a disconnected
          // socket). Persistence above is safe even after a reconnect.
          if (myEpoch !== ctx.epoch) continue;

          await maybeTriggerAutoReply(
            userId,
            channelId,
            myEpoch,
            chat,
            parsed.jid,
            parsed.messageContent,
            messageId ?? undefined,
          );
        } catch (err) {
          logger.error({ err }, "Failed to process incoming message");
        }
      }
    });

    // Contact reactions. Baileys emits an array of { key, reaction } where `key`
    // is the reacted-to message's key and `reaction.text` is the emoji (empty
    // string == reaction removed). We locate the target row by its WA id within
    // this channel and store the contact's reaction in the non-fromMe slot
    // (operator reactions are written separately by the /react endpoint with
    // fromMe=true, so we never clobber them here).
    sock.ev.on("messages.reaction", async (reactions) => {
      if (myEpoch !== ctx.epoch) return;
      for (const item of reactions) {
        try {
          const targetId = item.key?.id;
          if (!targetId) continue;
          const emoji = (item.reaction?.text ?? "").trim();
          const [target] = await db
            .select({
              id: chatMessagesTable.id,
              reactions: chatMessagesTable.reactions,
            })
            .from(chatMessagesTable)
            .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
            .where(
              and(
                eq(chatsTable.channelId, channelId),
                eq(chatMessagesTable.waMessageId, targetId),
              ),
            )
            .limit(1);
          if (!target) continue;

          const existing = Array.isArray(target.reactions)
            ? (target.reactions as Array<Record<string, unknown>>)
            : [];
          // Keep the operator's own reaction; replace the single contact slot.
          const mine = existing.filter((r) => r.fromMe);
          const next = emoji ? [...mine, { emoji, fromMe: false }] : mine;
          await db
            .update(chatMessagesTable)
            .set({ reactions: next })
            .where(eq(chatMessagesTable.id, target.id));
        } catch (err) {
          logger.error({ err }, "Failed to process reaction");
        }
      }
    });

    sock.ev.on("messaging-history.set", async (payload) => {
      if (myEpoch !== ctx.epoch) return;
      const ownerPhone = ctx.ownerPhone;
      if (!ownerPhone) return;
      const ownerJid = sock.user?.id ?? "";
      const {
        chats = [],
        messages = [],
        isLatest,
        syncType,
      } = payload as {
        chats?: Array<{ id: string; name?: string | null }>;
        messages?: any[];
        isLatest?: boolean;
        syncType?: number;
      };
      logger.info(
        { chats: chats.length, messages: messages.length, isLatest, syncType },
        "messaging-history.set received",
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
              c.name?.trim() ||
              (await resolveGroupName(c.id)) ||
              c.id.split("@")[0];
            await getOrCreateChat(channelId, userId, c.id, groupName);
            key = c.id;
          } else {
            if (!c.id.endsWith("@s.whatsapp.net")) continue;
            const rawNumber = c.id.split("@")[0].split(":")[0];
            const phoneNumber = `+${rawNumber}`;
            const contactName = c.name?.trim() || rawNumber;
            await getOrCreateChat(channelId, userId, phoneNumber, contactName);
            key = phoneNumber;
          }
          await applyChatListMeta(channelId, key, c);
        } catch (err) {
          logger.error({ err, chatId: c?.id }, "Failed to seed history chat");
        }
      }

      let ingested = 0;
      for (const msg of messages) {
        try {
          // Use `continue`, not `return`: a mid-batch epoch flip used
          // to silently drop the tail of every history sync (= missing
          // older chats in MaxiChat that were still visible on the
          // phone). Captured ownerPhone keeps writes isolated correctly.
          if (msg.key?.remoteJid === "status@broadcast") {
            await persistWaStatus(
              channelId,
              ownerJid,
              msg,
              downloadMediaMessage,
              false,
            ).catch((err) =>
              logger.error({ err }, "Failed to persist history status"),
            );
            continue;
          }
          // Download media for historical messages too — otherwise the
          // operator sees the chat history but every PDF / image / video
          // shows as a placeholder with mediaUrl=null. Downloads are
          // sequential here (we await each one) so we don't fan out a
          // huge fetch storm; individual failures are logged inside
          // parseWaMessage and we still persist the row with metadata.
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            true,
            resolveGroupName,
            resolveLidToPn,
          );
          if (!parsed) continue;
          const { inserted } = await persistWaMessage(
            userId,
            channelId,
            parsed,
            {
              incrementUnread: false,
            },
          );
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
      }>,
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
              sql`${chatsTable.channelId} = ${channelId} AND ${chatsTable.phoneNumber} = ${phoneNumber}`,
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
    const handleChatMeta = async (
      updates: Array<{ id?: string } & Record<string, unknown>>,
    ) => {
      if (myEpoch !== ctx.epoch) return;
      for (const c of updates) {
        try {
          if (!c?.id) continue;
          const key = keyForChatId(c.id);
          if (!key) continue;
          await applyChatListMeta(channelId, key, c);
        } catch (err) {
          logger.error({ err, id: c?.id }, "Failed to apply chat metadata");
        }
      }
    };
    sock.ev.on("chats.upsert", handleChatMeta);
    sock.ev.on("chats.update", handleChatMeta);

    // Live group-subject sync. When a group is renamed on WhatsApp, Baileys
    // emits groups.update with the new subject (and groups.upsert for groups
    // that just became known). Without this, MaxiChat kept showing the old
    // name until the socket session restarted. We refresh both the in-session
    // name cache and the stored chat row so the new name shows immediately.
    const handleGroupsMeta = async (
      updates: Array<{ id?: string; subject?: string }>,
    ) => {
      if (myEpoch !== ctx.epoch) return;
      for (const g of updates) {
        try {
          if (!g?.id || !g.id.endsWith("@g.us")) continue;
          const subject = typeof g.subject === "string" ? g.subject.trim() : "";
          if (!subject) continue;
          groupNameCache.set(g.id, subject);
          await db
            .update(chatsTable)
            .set({ contactName: subject })
            .where(
              sql`${chatsTable.channelId} = ${channelId} AND ${chatsTable.phoneNumber} = ${g.id}`,
            );
        } catch (err) {
          logger.error(
            { err, id: g?.id },
            "Failed to apply group subject update",
          );
        }
      }
    };
    sock.ev.on("groups.update", handleGroupsMeta);
    sock.ev.on("groups.upsert", handleGroupsMeta);
  } catch (err) {
    ctx.isConnecting = false;
    ctx.sock = null;
    // Await so callers observing /whatsapp/status right after a thrown
    // startBaileys don't see stale connecting/qr_ready state.
    await syncChannelStatus(channelId, {
      status: "disconnected",
      qrCode: null,
      connectedAt: null,
    });
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
        {
          set: (setRes as any).rowCount ?? null,
          cleared: (clearRes as any).rowCount ?? null,
        },
        "is_lid backfill done",
      );
    } catch (err) {
      logger.warn({ err }, "is_lid backfill failed (non-fatal)");
    }

    // One-shot legacy authDir migration: pre-Phase-B layout stored creds
    // at `<AUTH_ROOT>/<userId>/` (single channel per user). New layout
    // nests under the channel id: `<AUTH_ROOT>/<userId>/<channelId>/`.
    // For each existing user dir that contains creds.json directly, move
    // every loose file into the user's primary channel subdir. Idempotent —
    // a re-run after migration sees no loose files and skips.
    try {
      const entries = await fs.readdir(AUTH_ROOT).catch(() => [] as string[]);
      for (const entry of entries) {
        const userIdNum = Number(entry);
        if (!Number.isInteger(userIdNum) || userIdNum <= 0) continue;
        const userDir = path.join(AUTH_ROOT, entry);
        const stat = await fs.stat(userDir).catch(() => null);
        if (!stat?.isDirectory()) continue;
        const credsPath = path.join(userDir, "creds.json");
        const hasLooseCreds = await fs
          .stat(credsPath)
          .then((s) => s.isFile())
          .catch(() => false);
        if (!hasLooseCreds) continue;
        const primaryChannelId =
          await ensurePrimaryWhatsappChannelForUser(userIdNum);
        const targetDir = path.join(userDir, String(primaryChannelId));
        await fs.mkdir(targetDir, { recursive: true });
        const looseFiles = await fs
          .readdir(userDir)
          .catch(() => [] as string[]);
        for (const f of looseFiles) {
          // Skip subdirectories (channel folders, including the one we just
          // created); only loose files are legacy artifacts.
          const src = path.join(userDir, f);
          const fst = await fs.stat(src).catch(() => null);
          if (!fst?.isFile()) continue;
          await fs.rename(src, path.join(targetDir, f)).catch(() => {});
        }
        logger.info(
          { userId: userIdNum, primaryChannelId },
          "migrated legacy auth dir to channel layout",
        );
      }
    } catch (err) {
      logger.warn({ err }, "legacy authDir migration failed (non-fatal)");
    }

    // Auto-reconnect each previously-connected CHANNEL. We iterate the
    // channels table (post-Phase-B source of truth) instead of the legacy
    // whatsapp_session table, so a user with N paired numbers gets N
    // sockets restored. Channels that have never paired (status =
    // 'disconnected' with no ownerPhone) are skipped — they require a
    // fresh QR via /api/channels/:id/pair (Phase C).
    // Filter on STATUS not ownerPhone: a channel that the user explicitly
    // unpaired (/unpair or DELETE) clears its auth dir but intentionally
    // leaves ownerPhone in place as the binding marker (so re-pairing
    // the same number reuses the channel row). Reconnecting those here
    // would resurrect a session the user just torn down — only resume
    // channels whose status was live or mid-pair when we last shut down.
    const channelRows = await db
      .select({
        id: channelsTable.id,
        userId: channelsTable.userId,
        status: channelsTable.status,
        ownerPhone: channelsTable.ownerPhone,
      })
      .from(channelsTable)
      .where(
        and(
          eq(channelsTable.kind, "whatsapp"),
          sql`${channelsTable.status} IN ('connected', 'connecting', 'qr_ready')`,
        ),
      );
    for (const row of channelRows) {
      // Best-effort: if no creds on disk we'll just produce a QR (harmless).
      void syncChannelStatus(row.id, { status: "connecting" });
      startBaileys(row.userId, row.id).catch((err) =>
        logger.error(
          { err, userId: row.userId, channelId: row.id },
          "Auto-reconnect failed",
        ),
      );
    }
  } catch {}
}

const router = Router();

// Read the primary WhatsApp channel and project it onto the legacy
// WhatsappStatus shape. The whatsapp_session table is gone — channels is
// now the single source of truth for per-channel pairing state.
async function readChannelStatus(channelId: number): Promise<{
  status: string;
  qrCode: string | null;
  phoneNumber: string | null;
  connectedAt: string | null;
}> {
  const [row] = await db
    .select({
      status: channelsTable.status,
      ownerPhone: channelsTable.ownerPhone,
      metadata: channelsTable.metadata,
      updatedAt: channelsTable.updatedAt,
    })
    .from(channelsTable)
    .where(eq(channelsTable.id, channelId))
    .limit(1);
  const meta = (row?.metadata as Record<string, unknown> | null) ?? {};
  const qrCode =
    typeof meta.qrCode === "string" ? (meta.qrCode as string) : null;
  const status = row?.status ?? "disconnected";
  const isConnected = status === "connected";
  // Preserve legacy contract: phoneNumber + connectedAt only when actually
  // connected. (Pre-E1 `whatsapp_session` cleared both on disconnect.)
  // connectedAt is stored on channels.metadata.connectedAt by the
  // connection.open handler so it survives non-status `updatedAt` bumps.
  const connectedAtRaw =
    typeof meta.connectedAt === "string" ? (meta.connectedAt as string) : null;
  return {
    status,
    qrCode,
    phoneNumber: isConnected ? (row?.ownerPhone ?? null) : null,
    connectedAt: isConnected ? connectedAtRaw : null,
  };
}

const DISCONNECTED_STATUS = {
  status: "disconnected" as const,
  qrCode: null,
  phoneNumber: null,
  connectedAt: null,
};

// Resolve the channel the connection widgets (Dashboard card + sidebar badge)
// should reflect for THIS request: the switcher's selected channel
// (X-Channel-Id), falling back to the caller's primary ALLOWED channel. For
// supervisor/agent this is scoped by user_channel_access, so each member sees
// the number THEY are assigned — not the owner's primary number. Returns null
// when the caller has no channel in scope.
async function resolveWidgetChannelId(req: Request): Promise<number | null> {
  const sel = await resolveActiveChannel(req);
  // Only a WhatsApp channel is meaningful for the WhatsApp widgets. If the
  // switcher has a WhatsApp channel selected, use it directly.
  if (sel?.kind === "channel" && sel.channel.kind === "whatsapp") {
    return sel.channel.id;
  }
  // Otherwise (a non-WhatsApp channel selected, "All channels", or no
  // selection) fall back to the caller's primary ALLOWED WhatsApp channel so
  // the single-value widgets still show the right number — never a Telegram
  // (or other-kind) row.
  const owned = await listOwnedChannels(req);
  const wa = owned.find((c) => c.kind === "whatsapp");
  return wa?.id ?? null;
}

router.get("/status", async (req, res): Promise<void> => {
  try {
    requireUserId(req);
    // Per-channel display: reflect the channel this member is allowed to see
    // (switcher selection or their primary assigned channel), NOT the owner's
    // primary. Fixes invited members seeing the owner's number on the
    // dashboard card and sidebar badge.
    const channelId = await resolveWidgetChannelId(req);
    if (channelId == null) {
      res.json(DISCONNECTED_STATUS);
      return;
    }
    res.json(await readChannelStatus(channelId));
  } catch (err) {
    req.log.error({ err }, "Failed to get WhatsApp status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/connect", async (req, res): Promise<void> => {
  try {
    requireUserId(req);
    // Connect/disconnect act on the SELECTED channel (switcher header),
    // scoped by user_channel_access via resolveActiveChannel. An invited
    // member can only (re)pair the channel(s) assigned to them — never the
    // owner's other numbers — and the action targets the SAME channel the
    // widget displays, so the button never connects/disconnects a different
    // number than the one shown.
    const sel = await resolveActiveChannel(req);
    if (!sel) {
      res.status(403).json({
        error: "Tidak ada channel WhatsApp yang bisa kamu kelola.",
      });
      return;
    }
    if (sel.kind === "all") {
      res.status(400).json({
        error: "Pilih channel WhatsApp dulu sebelum menghubungkan.",
      });
      return;
    }
    const channel = sel.channel;
    if (channel.kind !== "whatsapp") {
      res.status(400).json({
        error: `Pairing belum tersedia untuk channel ${channel.kind}.`,
      });
      return;
    }
    const current = await readChannelStatus(channel.id);
    if (current.status === "connected") {
      res.json(current);
      return;
    }
    void syncChannelStatus(channel.id, { status: "connecting" });
    startBaileys(channel.userId, channel.id).catch((err) =>
      req.log.error({ err }, "Baileys start failed"),
    );
    res.json({
      status: "connecting",
      qrCode: null,
      phoneNumber: null,
      connectedAt: null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to connect WhatsApp");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/profile/bio", async (req, res): Promise<void> => {
  try {
    const userId = requireUserId(req);
    const ownerUserId = await resolveOwnerUserId(userId);
    const ownerPhone = await getCurrentOwnerPhone(ownerUserId);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const result = await fetchOwnBio(ownerUserId);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch own bio");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/profile/bio", async (req, res): Promise<void> => {
  try {
    const userId = requireUserId(req);
    if (!(await isWhatsappOwner(userId))) {
      res.status(403).json({
        error: "Hanya pemilik akun yang dapat mengubah bio WhatsApp.",
      });
      return;
    }
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

router.post("/disconnect", async (req, res): Promise<void> => {
  try {
    requireUserId(req);
    // Disconnect targets the SELECTED channel (switcher header), scoped by
    // user_channel_access via resolveActiveChannel. An invited member can
    // only disconnect the channel(s) assigned to them — never the owner's
    // other numbers — and only the channel currently shown on the widget.
    const sel = await resolveActiveChannel(req);
    if (!sel) {
      res.status(403).json({
        error: "Tidak ada channel WhatsApp yang bisa kamu kelola.",
      });
      return;
    }
    if (sel.kind === "all") {
      res.status(400).json({
        error: "Pilih channel WhatsApp dulu sebelum memutuskan.",
      });
      return;
    }
    if (sel.channel.kind !== "whatsapp") {
      res.status(400).json({
        error: `Pemutusan belum tersedia untuk channel ${sel.channel.kind}.`,
      });
      return;
    }
    // Channels are owned by the tenant's super_admin, so channel.userId is the
    // owner id — the same key startBaileys/ctx use, regardless of which team
    // member triggers the disconnect.
    const channelId = sel.channel.id;
    const ownerUid = sel.channel.userId;
    const ctx = getCtxByChannel(channelId, ownerUid);
    // Bump THIS channel's epoch FIRST so any in-flight handler callbacks
    // abort before they try to persist into chats we're about to clear.
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
    // Wipe THIS channel's local auth credentials so the next /connect starts
    // a fresh pairing flow (QR). Other channels' auth dirs are untouched.
    await fs
      .rm(authDirForChannel(ownerUid, channelId), {
        recursive: true,
        force: true,
      })
      .catch((err) => {
        req.log.warn({ err }, "Failed to wipe WhatsApp auth dir");
      });
    // Per-channel isolation: do NOT delete chats. Each chat row is scoped by
    // channel_id, so once we clear this channel's connected phone below the
    // dashboard returns an empty list. When the SAME number scans QR again,
    // its history reappears; a DIFFERENT number sees its own clean slate.
    ctx.ownerPhone = null;
    // Surface the disconnect on the channels table. Matches the
    // pre-migration behavior of leaving the owner_phone binding in place
    // (see the note on the connection.close handler) — a re-pair of the
    // SAME number reuses the same channel without re-creating it; pairing
    // a DIFFERENT number on this channel will update ownerPhone via
    // syncChannelStatus in connection.open.
    await syncChannelStatus(channelId, {
      status: "disconnected",
      qrCode: null,
      connectedAt: null,
    });
    res.json({
      status: "disconnected",
      qrCode: null,
      phoneNumber: null,
      connectedAt: null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to disconnect WhatsApp");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
