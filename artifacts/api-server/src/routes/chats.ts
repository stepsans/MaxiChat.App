import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import dns from "node:dns/promises";
import dnsCallback from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import type { Request, Response } from "express";
import { db } from "@workspace/db";
import {
  chatsTable,
  chatMessagesTable,
  productsTable,
  channelsTable,
  chatLabelsTable,
  customerLabelsTable,
  textShortcutsTable,
} from "@workspace/db";
import {
  sendMessage as tgSendMessage,
  sendDocument as tgSendDocument,
  sendPhoto as tgSendPhoto,
  deleteMessage as tgDeleteMessage,
} from "../lib/telegram";
import { buildQuotationPdf, type QuotationItem } from "../lib/quotation-pdf";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { withTag, resolveAgentTag } from "../lib/sender-tag.js";
import {
  ListChatsQueryParams,
  UpdateChatBody,
  SendManualReplyBody,
  TakeoverChatBody,
  GetChatParams,
  UpdateChatParams,
  SendManualReplyParams,
  TakeoverChatParams,
  OpenChatByPhoneBody,
  SetChatLabelsBody,
  SetMessageStarBody,
  AddGroupParticipantsBody,
} from "@workspace/api-zod";
import { resolveOwnerUserId } from "../lib/seed";
import {
  MEDIA_DIR,
  sendMediaToJid,
  sendContactToJid,
  getActiveSocket,
  getSockForChannel,
  getOrCreateChat,
  refreshChatProfilePic,
} from "./whatsapp";
import {
  resolveChannelScope,
  requireConnectedChannel,
  requireOwnerUserId,
} from "../lib/channel-context";
import { loadChannelIdsBatch } from "../lib/channel-assignments";

const router = Router();

// Multer storage — write directly into the media dir with a UUID filename
const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(MEDIA_DIR, { recursive: true });
      } catch {}
      cb(null, MEDIA_DIR);
    },
    filename: (_req, file, cb) => {
      // Derive extension from declared MIME (trusted by Multer) and never
      // from the user-controlled original filename — that prevents stored
      // .html/.svg/.js files from being served as active content.
      const ext = mime.extension(file.mimetype || "");
      cb(null, `${randomUUID()}${ext ? "." + ext : ""}`);
    },
  }),
  limits: { fileSize: 64 * 1024 * 1024 }, // 64MB
});

// SSRF guard: allow only globally-routable unicast IPs. Uses ipaddr.js for
// canonical parsing so alternate IPv6 forms (e.g. "0:0:0:0:0:0:0:1",
// "::ffff:7f00:1") are normalized before classification. Any IP whose range is
// not "unicast" (loopback / private / linkLocal / uniqueLocal / multicast /
// reserved / unspecified / broadcast / carrierGradeNat) is rejected, plus
// IPv4-mapped IPv6 addresses are re-checked against IPv4 ranges.
function isPrivateIp(ip: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(ip);
  } catch {
    return true; // unparseable → treat as unsafe
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isPrivateIp(v6.toIPv4Address().toString());
    }
  }
  const range = parsed.range();
  return range !== "unicast";
}

// Undici dispatcher that re-validates the resolved IP at connect time. This
// closes the DNS-rebinding TOCTOU gap left by a pure pre-check: even if a
// hostname's DNS answer changes between the pre-check and the socket connect,
// the connect call itself rejects any private IP.
const safeImageDispatcher = new Agent({
  connect: {
    lookup: (hostname: string, optsOrCb: any, maybeCb?: any) => {
      // Normalize signatures. Undici 8 calls this with options that include
      // `{ all: true }`, which means dns.lookup returns an array of
      // {address, family} and the caller expects the same array shape back.
      const cb: (err: NodeJS.ErrnoException | null, ...rest: any[]) => void =
        typeof optsOrCb === "function" ? optsOrCb : maybeCb;
      const opts =
        typeof optsOrCb === "function" || optsOrCb == null ? {} : optsOrCb;
      const wantAll = opts.all === true;
      dnsCallback.lookup(
        hostname,
        {
          family: typeof opts.family === "number" ? opts.family : 0,
          hints: opts.hints,
          verbatim: true,
          all: true,
        },
        (err, addresses) => {
          if (err) return cb(err);
          const list = Array.isArray(addresses) ? addresses : [];
          if (list.length === 0) {
            return cb(new Error(`DNS lookup returned no address for ${hostname}`));
          }
          const safe = list.filter((a) => !isPrivateIp(a.address));
          if (safe.length === 0) {
            return cb(
              new Error(
                `Host resolves only to private IPs at connect time: ${hostname}`
              )
            );
          }
          if (wantAll) {
            cb(null, safe);
          } else {
            cb(null, safe[0].address, safe[0].family);
          }
        }
      );
    },
  },
});

// Convert a "flyer" user input (which may be a raw http(s) URL or a pasted
// `<iframe src="..."></iframe>` embed — typically from Google Drive's "Embed
// item" dialog) into a direct image URL that fetchRemoteImageSafe can pull
// bytes from. For Google Drive file IDs we use the thumbnail endpoint, which
// returns a JPEG of the document (works for shared images and PDF previews).
// Returns null if no usable URL can be derived.
function flyerInputToImageUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Extract a src URL: either from an <iframe ... src="..."> snippet, or
  // treat the whole input as a URL.
  let candidate: string | null = null;
  const iframeMatch = trimmed.match(
    /<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/i
  );
  if (iframeMatch) {
    candidate = iframeMatch[1];
  } else if (/^https?:\/\//i.test(trimmed)) {
    candidate = trimmed;
  }
  if (!candidate) return null;

  // Try to pull a Google Drive file id from common URL shapes — only when
  // the host is actually a Google Drive domain, so we don't mis-route
  // unrelated URLs (e.g. some other site's /file/d/foo path) into Drive's
  // thumbnail endpoint.
  //   /file/d/<id>/...     (preview/view/edit pages, iframe src)
  //   ?id=<id>             (open?id=, uc?id=, thumbnail?id=)
  let driveId: string | null = null;
  try {
    const u = new URL(candidate);
    const host = u.hostname.toLowerCase();
    const isDriveHost =
      host === "drive.google.com" ||
      host === "docs.google.com" ||
      host.endsWith(".drive.google.com") ||
      host.endsWith(".docs.google.com");
    if (isDriveHost) {
      const pathMatch = u.pathname.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (pathMatch) {
        driveId = pathMatch[1];
      } else {
        const idParam = u.searchParams.get("id");
        if (idParam && /^[a-zA-Z0-9_-]+$/.test(idParam)) driveId = idParam;
      }
    }
  } catch {
    // not a parseable URL — fall through to plain-URL passthrough
  }
  if (driveId) {
    // sz=w2000 = max 2000px wide; comfortably above the 8MB cap and big
    // enough for a flyer to look sharp in WhatsApp.
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(
      driveId
    )}&sz=w2000`;
  }
  // Not a Drive URL — pass through if it's a plain http(s) URL.
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return null;
}

// Fetch a remote image URL safely:
//   - block SSRF by resolving the hostname and rejecting private IPs (pre-check
//     + connect-time re-check via the dispatcher above)
//   - disable redirects so an attacker can't redirect into an internal host
//   - stream-read the body with a hard 8MB cap (abort early if exceeded)
//   - verify magic bytes match JPEG / PNG / WebP / GIF
async function fetchRemoteImageSafe(
  urlStr: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const MAX_BYTES = 8 * 1024 * 1024;
  const TIMEOUT_MS = 10_000;
  const url = new URL(urlStr);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  const host = url.hostname;
  // Resolve hostname — reject literal private IPs and any DNS result that
  // points at a private IP.
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Blocked private IP: ${host}`);
  } else {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (records.length === 0) throw new Error(`No DNS record for ${host}`);
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new Error(`Host resolves to private IP: ${host} → ${r.address}`);
      }
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Allow redirects (up to undici's default of 5 hops). Each new connection
    // goes through `safeImageDispatcher`, which re-validates the resolved IP
    // at connect time — so a redirect target on a private network is still
    // blocked. This is required for endpoints like Google Drive thumbnails
    // that 302 to lh3.googleusercontent.com.
    const resp = await undiciFetch(urlStr, {
      signal: controller.signal,
      redirect: "follow",
      dispatcher: safeImageDispatcher,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ctype.startsWith("image/")) {
      throw new Error(`Not an image: content-type=${ctype || "(none)"}`);
    }
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new Error(`Image too large (>${MAX_BYTES} bytes)`);
        }
        chunks.push(value);
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)), total);

    // Magic-byte sniff. Reject anything that isn't a real raster image
    // (e.g. SVG/XML is rejected — it would be served as image/svg+xml but
    // can carry script).
    let mimeType: string;
    if (
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff
    ) {
      mimeType = "image/jpeg";
    } else if (
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    ) {
      mimeType = "image/png";
    } else if (
      buffer.length >= 12 &&
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP"
    ) {
      mimeType = "image/webp";
    } else if (
      buffer.length >= 6 &&
      (buffer.toString("ascii", 0, 6) === "GIF87a" ||
        buffer.toString("ascii", 0, 6) === "GIF89a")
    ) {
      mimeType = "image/gif";
    } else {
      throw new Error("Unsupported image format (expected JPEG/PNG/WebP/GIF)");
    }
    return { buffer, mimeType };
  } finally {
    clearTimeout(timer);
  }
}

function classifyMediaType(
  mime: string
): "image" | "video" | "audio" | "document" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

// Resolve the effective team role from the DB rather than trusting the
// session cache. A super_admin who demotes an agent mid-session must lose
// the elevated view immediately, not after the next /auth/me poll.
async function getEffectiveTeamRole(
  userId: number
): Promise<"super_admin" | "supervisor" | "agent"> {
  const { usersTable } = await import("@workspace/db");
  const [row] = await db
    .select({ teamRole: usersTable.teamRole })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const tr = row?.teamRole;
  return tr === "supervisor" || tr === "agent" ? tr : "super_admin";
}

// Build the WHERE fragment used by every per-chat lookup. Layers two scopes:
//   * channelId IN (...user's owned channels) — cross-tenant isolation
//   * for the "agent" role, additionally require assigned_user_id = userId,
//     so a guessed/leaked chat id from a different conversation looks like
//     "not found" instead of leaking the row.
//
// By-id routes always sweep across ALL channels owned by the user (not just
// the active one) so that the "All channels" view can open any chat detail
// regardless of the X-Channel-Id header. The channel filter alone is enough
// for tenant isolation — the chat's own channel_id pins it to one account.
async function authorizedChatWhere(req: Request, res: Response, chatId: number) {
  const scope = await resolveChannelScope(req, res);
  if (!scope) return null; // already sent a 401
  if (scope.channelIds.length === 0) return { scope, where: null };
  const userId = req.session.userId!;
  const teamRole = await getEffectiveTeamRole(userId);
  // Per-user channel allow-list (chat-only scope). Intersect with the
  // tenant scope so a leaked chat id from a forbidden channel reads as
  // "not found" rather than 403 — symmetrical with the existing tenant
  // isolation behaviour above.
  const { getAllowedChannelIds } = await import("../lib/user-channel-access");
  const allowed = await getAllowedChannelIds(userId);
  const allowedIds = scope.channelIds.filter((id) => allowed.has(id));
  if (allowedIds.length === 0) return { scope, where: null };
  // Cast to any[] so Drizzle generates `channel_id = ANY($1)` (single param
  // expansion) regardless of how many ids are in scope.
  const base = and(
    eq(chatsTable.id, chatId),
    inArray(chatsTable.channelId, allowedIds)
  )!;
  const where =
    teamRole === "agent"
      ? sql`${base} AND ${chatsTable.assignedUserId} = ${userId}`
      : base;
  return { scope, where };
}

async function jidForChat(
  req: Request,
  res: Response,
  chatId: number
): Promise<{ chat: typeof chatsTable.$inferSelect; jid: string } | null> {
  // Scope by user's channels + (for agents) by assignment — see
  // authorizedChatWhere. Returning null on any failure lets callers reply 404
  // without leaking whether the chat exists for another role.
  const az = await authorizedChatWhere(req, res, chatId);
  if (!az || !az.where) return null;
  const [chat] = await db.select().from(chatsTable).where(az.where);
  if (!chat) return null;
  // Groups: phoneNumber column already holds the full "<id>@g.us" JID.
  if (chat.phoneNumber.includes("@")) {
    return { chat, jid: chat.phoneNumber };
  }
  const cleaned = chat.phoneNumber.replace(/[^\d]/g, "");
  return { chat, jid: `${cleaned}@s.whatsapp.net` };
}

// Centralised ownership-aware loader: returns the chat row only if it
// belongs to one of the user's owned channels AND (for agents) is assigned
// to the calling user. Null otherwise (which every caller treats as 404 —
// indistinguishable from "doesn't exist" to avoid leaking that another
// account's chat exists).
async function loadOwnedChat(req: Request, res: Response, chatId: number) {
  const az = await authorizedChatWhere(req, res, chatId);
  if (!az || !az.where) return null;
  const [chat] = await db.select().from(chatsTable).where(az.where);
  return chat ?? null;
}

export type SerializedLabel = {
  id: number;
  name: string;
  color: string;
  createdAt: string;
};

// Batch-load the customer labels attached to each chat. Returns a map keyed
// by chatId so list/detail serializers can attach a `labels` array without an
// N+1 query. Labels are ordered by name for stable rendering.
async function fetchLabelsForChats(
  chatIds: number[]
): Promise<Map<number, SerializedLabel[]>> {
  const map = new Map<number, SerializedLabel[]>();
  if (chatIds.length === 0) return map;
  const rows = await db
    .select({
      chatId: chatLabelsTable.chatId,
      id: customerLabelsTable.id,
      name: customerLabelsTable.name,
      color: customerLabelsTable.color,
      createdAt: customerLabelsTable.createdAt,
    })
    .from(chatLabelsTable)
    .innerJoin(
      customerLabelsTable,
      eq(chatLabelsTable.labelId, customerLabelsTable.id)
    )
    .where(inArray(chatLabelsTable.chatId, chatIds))
    .orderBy(customerLabelsTable.name);
  for (const r of rows) {
    const list = map.get(r.chatId) ?? [];
    list.push({
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: r.createdAt.toISOString(),
    });
    map.set(r.chatId, list);
  }
  return map;
}

router.get("/", async (req, res): Promise<void> => {
  try {
    const parsed = ListChatsQueryParams.safeParse(req.query);
    const status = parsed.success ? parsed.data.status : undefined;
    const tag = parsed.success ? parsed.data.tag : undefined;

    // Per-channel isolation. When the user has no channels yet (fresh
    // signup before any pairing) the list is empty so the UI shows no
    // history. Supports the "All channels" aggregate view via
    // X-Channel-Id: all (resolveChannelScope returns every owned channel).
    const scope = await resolveChannelScope(req, res);
    if (!scope) return;
    const userId = req.session.userId!;
    if (scope.channelIds.length === 0) {
      res.json([]);
      return;
    }
    // Per-user channel allow-list — intersect with tenant scope. Empty
    // intersection means this user can't see chats in any of the channels
    // currently in view, so return an empty list (matches the existing
    // "no channels paired yet" behaviour above).
    const { getAllowedChannelIds } = await import("../lib/user-channel-access");
    const allowed = await getAllowedChannelIds(userId);
    const allowedScopeIds = scope.channelIds.filter((id) => allowed.has(id));
    if (allowedScopeIds.length === 0) {
      res.json([]);
      return;
    }

    // Role-aware filter: agents only see chats explicitly assigned to them;
    // supervisors and the super_admin see everything under the channel scope.
    const teamRole = req.session.teamRole ?? "super_admin";
    const channelFilter = inArray(chatsTable.channelId, allowedScopeIds);
    const baseWhere =
      teamRole === "agent"
        ? and(channelFilter, eq(chatsTable.assignedUserId, userId))!
        : channelFilter;

    // Sort: (1) pinned chats first (most recently pinned at top),
    // (2) non-archived next, (3) by last message time desc with chats that
    // have any history above empty ones, (4) finally createdAt as tiebreaker.
    const results = await db
      .select()
      .from(chatsTable)
      .where(baseWhere)
      .orderBy(
        sql`(${chatsTable.pinnedAt} IS NOT NULL) DESC,
            ${chatsTable.pinnedAt} DESC NULLS LAST,
            ${chatsTable.isArchived} ASC,
            (${chatsTable.lastMessageAt} IS NOT NULL) DESC,
            ${chatsTable.lastMessageAt} DESC NULLS LAST,
            ${chatsTable.createdAt} DESC`
      );

    let filtered = results;
    if (status && status !== "all") {
      filtered = filtered.filter((c) => c.status === status);
    }
    if (tag && tag !== "all") {
      filtered = filtered.filter((c) => c.tag === tag);
    }

    // Opportunistically refresh missing profile pictures in the background
    // (throttled by PROFILE_PIC_TTL_MS inside the helper), so the UI gets
    // them on the next poll without blocking this response.
    for (const c of filtered) {
      if (!c.profilePicUrl) {
        void refreshChatProfilePic(req.session.userId!, c).catch(() => {});
      }
    }

    const labelMap = await fetchLabelsForChats(filtered.map((c) => c.id));
    res.json(
      filtered.map((c) => ({
        ...c,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
        labels: labelMap.get(c.id) ?? [],
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list chats");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Normalise a user-typed phone number to a digits-only E.164-ish string with
 * Indonesian-friendly defaults. Mirrors the frontend's normaliser so the user
 * sees the same result regardless of which side runs it.
 *   "08123…"  → "628123…"
 *   "+62…"    → "62…"
 *   "8123…"   → "628123…"  (bare local mobile prefix → assume ID)
 *   "62…" / other international numbers are left alone.
 */
function normalisePhoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return "62" + digits.slice(1);
  if (digits.startsWith("8") && digits.length >= 9 && digits.length <= 13) {
    return "62" + digits;
  }
  return digits;
}

router.post("/open-by-phone", async (req, res): Promise<void> => {
  try {
    const parsed = OpenChatByPhoneBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const digits = normalisePhoneDigits(parsed.data.phoneNumber);
    if (digits.length < 8 || digits.length > 15) {
      res.status(400).json({ error: "Invalid phone number" });
      return;
    }
    // Personal chats are stored as "+<digits>"; group jids use "@g.us" and
    // are not creatable from this UI.
    const phoneNumber = "+" + digits;

    // open-by-phone always creates the chat under the *active* channel.
    // In "All channels" mode this is ambiguous, so the route requires a
    // single connected channel.
    const channel = await requireConnectedChannel(req, res);
    if (!channel) return;

    // Per-user channel allow-list. Without this, a restricted supervisor/
    // agent could pass X-Channel-Id for a channel they don't have chat
    // access to and create a brand-new chat there — bypassing the read-
    // side filter on list/detail. Mirror the same 404-style refusal so we
    // don't leak which channels exist.
    const uid = req.session.userId!;
    const { getAllowedChannelIds: _getAllowed } = await import(
      "../lib/user-channel-access"
    );
    const allowed = await _getAllowed(uid);
    if (!allowed.has(channel.id)) {
      res.status(404).json({ error: "channel_not_accessible" });
      return;
    }

    // Deterministic "open-or-create": try INSERT … ON CONFLICT DO NOTHING. If
    // RETURNING gives us a row, we created it. Otherwise the unique
    // (channel_id, phone_number) row already existed and we re-select its id.
    const contactName = parsed.data.contactName?.trim() || digits;
    const inserted = await db
      .insert(chatsTable)
      .values({
        channelId: channel.id,
        phoneNumber,
        contactName,
        status: "ai_handled",
        tag: "none",
        isHumanTakeover: false,
        unreadCount: 0,
        isLid: false,
      })
      .onConflictDoNothing({
        target: [chatsTable.channelId, chatsTable.phoneNumber],
      })
      .returning({ id: chatsTable.id });

    if (inserted[0]) {
      res.json({ chatId: inserted[0].id, created: true, phoneNumber });
      return;
    }

    const [existing] = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(
        sql`${chatsTable.channelId} = ${channel.id} AND ${chatsTable.phoneNumber} = ${phoneNumber}`
      )
      .limit(1);

    if (!existing) {
      // Should be impossible: insert was a no-op, so a row must exist.
      res.status(500).json({ error: "Failed to open chat" });
      return;
    }
    res.json({ chatId: existing.id, created: false, phoneNumber });
    return;
  } catch (err) {
    req.log.error({ err }, "Failed to open chat by phone");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/refresh-avatar", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const url = await refreshChatProfilePic(req.session.userId!, chat, {
      force: true,
    });
    res.json({ profilePicUrl: url });
    return;
  } catch (err) {
    req.log.error({ err }, "Failed to refresh chat avatar");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Group / attachment / star helpers (WhatsApp-mobile feature parity)
// ---------------------------------------------------------------------------

// Digits-only phone parsed from a JID, when it is a real phone number
// (…@s.whatsapp.net). Returns null for LID JIDs and anything non-numeric.
function jidDigits(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const local = jid.split("@")[0].split(":")[0];
  return /^[0-9]+$/.test(local) ? local : null;
}

function phoneToJid(phone: string): string {
  return `${String(phone).replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}

const ATTACHMENT_LINK_RE = /\bhttps?:\/\/[^\s<>()]+/gi;

type ChatMessageRow = typeof chatMessagesTable.$inferSelect;

function serializeChatMessage(m: ChatMessageRow) {
  return {
    ...m,
    createdAt: m.createdAt.toISOString(),
    mentionedPhoneDigits: m.mentionedPhoneDigits ?? [],
    isStarred: m.isStarred ?? false,
  };
}

function serializeAttachmentItem(m: ChatMessageRow) {
  return {
    id: m.id,
    mediaType: m.mediaType ?? null,
    mediaUrl: m.mediaUrl ?? null,
    mediaMimeType: m.mediaMimeType ?? null,
    mediaFilename: m.mediaFilename ?? null,
    content: m.content ?? "",
    direction: m.direction,
    createdAt: m.createdAt.toISOString(),
    senderName: m.senderName ?? null,
  };
}

// GET /:id/group-info — live group metadata + members + invite link.
router.get("/:id/group-info", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }
    if (!chat.phoneNumber.endsWith("@g.us")) {
      res.status(400).json({ error: "Not a group chat" });
      return;
    }
    const sock = getSockForChannel(chat.channelId);
    if (!sock) { res.status(409).json({ error: "WhatsApp not connected" }); return; }

    const meta = await sock.groupMetadata(chat.phoneNumber);
    let inviteLink: string | null = null;
    try {
      const code = await sock.groupInviteCode(chat.phoneNumber);
      if (code) inviteLink = `https://chat.whatsapp.com/${code}`;
    } catch {
      // Only group admins can read the invite code — leave null otherwise.
    }
    const participants = (meta.participants ?? []).map((p) => {
      const pp = p as { id: string; admin?: string | null; name?: string | null; notify?: string | null };
      return {
        jid: pp.id,
        phone: jidDigits(pp.id),
        name: pp.name ?? pp.notify ?? null,
        isAdmin: pp.admin === "admin" || pp.admin === "superadmin",
        isSuperAdmin: pp.admin === "superadmin",
      };
    });
    res.json({
      subject: meta.subject ?? chat.contactName ?? "",
      description: meta.desc ?? null,
      ownerJid: meta.owner ?? null,
      creationAt: meta.creation ? new Date(meta.creation * 1000).toISOString() : null,
      size: meta.size ?? participants.length,
      inviteLink,
      participants,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get group info");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/attachments — shared media, documents and links for a chat.
router.get("/:id/attachments", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const rows = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chat.id))
      .orderBy(desc(chatMessagesTable.createdAt));

    const CAP = 300;
    const media: ReturnType<typeof serializeAttachmentItem>[] = [];
    const docs: ReturnType<typeof serializeAttachmentItem>[] = [];
    const links: { messageId: number; url: string; createdAt: string; senderName: string | null }[] = [];
    for (const m of rows) {
      if (m.mediaType === "image" || m.mediaType === "video") {
        if (media.length < CAP) media.push(serializeAttachmentItem(m));
      } else if (m.mediaType === "document") {
        if (docs.length < CAP) docs.push(serializeAttachmentItem(m));
      }
      if (m.content && links.length < CAP) {
        const matches = m.content.match(ATTACHMENT_LINK_RE);
        if (matches) {
          for (const url of matches) {
            if (links.length >= CAP) break;
            links.push({
              messageId: m.id,
              url,
              createdAt: m.createdAt.toISOString(),
              senderName: m.senderName ?? null,
            });
          }
        }
      }
    }
    res.json({ media, docs, links });
  } catch (err) {
    req.log.error({ err }, "Failed to get chat attachments");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/starred — MaxiChat-internal starred messages for a chat.
router.get("/:id/starred", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const rows = await db
      .select()
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.chatId, chat.id), eq(chatMessagesTable.isStarred, true)))
      .orderBy(desc(chatMessagesTable.createdAt));
    res.json({ messages: rows.map(serializeChatMessage) });
  } catch (err) {
    req.log.error({ err }, "Failed to get starred messages");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/messages/:messageId/star — star/unstar a single message.
router.post("/:id/messages/:messageId/star", async (req, res): Promise<void> => {
  try {
    const chatId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(chatId) || !Number.isInteger(messageId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const bodyParsed = SetMessageStarBody.safeParse(req.body);
    if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

    const chat = await loadOwnedChat(req, res, chatId);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const [updated] = await db
      .update(chatMessagesTable)
      .set({ isStarred: bodyParsed.data.starred })
      .where(and(eq(chatMessagesTable.id, messageId), eq(chatMessagesTable.chatId, chat.id)))
      .returning();
    if (!updated) { res.status(404).json({ error: "Message not found" }); return; }
    res.json({ isStarred: updated.isStarred ?? false });
  } catch (err) {
    req.log.error({ err }, "Failed to set message star");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id/messages/:messageId — "delete for me": remove the message row
// from MaxiChat only. The message stays on the contact's device / WhatsApp.
router.delete("/:id/messages/:messageId", async (req, res): Promise<void> => {
  try {
    const chatId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(chatId) || !Number.isInteger(messageId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const chat = await loadOwnedChat(req, res, chatId);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const [deleted] = await db
      .delete(chatMessagesTable)
      .where(and(eq(chatMessagesTable.id, messageId), eq(chatMessagesTable.chatId, chat.id)))
      .returning({ id: chatMessagesTable.id });
    if (!deleted) { res.status(404).json({ error: "Message not found" }); return; }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete message for me");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/messages/:messageId/revoke — "delete for everyone": recall the
// message on the underlying channel, then drop the local row. WhatsApp and
// Telegram only allow recalling our OWN (outbound) messages, within a time
// window, so inbound messages are rejected with 400.
router.post("/:id/messages/:messageId/revoke", async (req, res): Promise<void> => {
  try {
    const chatId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    if (!Number.isInteger(chatId) || !Number.isInteger(messageId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const chat = await loadOwnedChat(req, res, chatId);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const [message] = await db
      .select()
      .from(chatMessagesTable)
      .where(and(eq(chatMessagesTable.id, messageId), eq(chatMessagesTable.chatId, chat.id)))
      .limit(1);
    if (!message) { res.status(404).json({ error: "Message not found" }); return; }

    if (message.direction !== "outbound") {
      res.status(400).json({
        error: "Hanya pesan yang Anda kirim yang bisa dihapus untuk semua orang.",
      });
      return;
    }
    if (!message.waMessageId) {
      res.status(400).json({
        error: "Pesan ini tidak punya ID dari WhatsApp/Telegram, tidak bisa ditarik.",
      });
      return;
    }

    const [channel] = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, chat.channelId))
      .limit(1);

    if (channel?.kind === "telegram") {
      const meta =
        (channel.metadata as Record<string, unknown> | null)?.["telegram"] as
          | { botToken?: string }
          | undefined;
      // Outbound telegram rows store waMessageId as `tg:<chatId>:<messageId>`.
      const parts = message.waMessageId.split(":");
      const tgChatId = Number.parseInt(parts[1] ?? "", 10);
      const tgMessageId = Number.parseInt(parts[2] ?? "", 10);
      if (!meta?.botToken || !Number.isFinite(tgChatId) || !Number.isFinite(tgMessageId)) {
        res.status(400).json({ error: "Channel Telegram tidak valid untuk hapus pesan." });
        return;
      }
      try {
        await tgDeleteMessage(meta.botToken, tgChatId, tgMessageId);
      } catch (err) {
        req.log.error({ err, chatId, messageId }, "Telegram revoke failed");
        res.status(400).json({
          error: "Gagal menarik pesan di Telegram (mungkin sudah terlalu lama).",
        });
        return;
      }
    } else {
      const sock = getSockForChannel(chat.channelId);
      if (!sock) { res.status(409).json({ error: "WhatsApp tidak terhubung" }); return; }
      const jid = chat.phoneNumber.includes("@")
        ? chat.phoneNumber
        : `${chat.phoneNumber.replace(/[^\d]/g, "")}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, {
          delete: {
            remoteJid: jid,
            fromMe: true,
            id: message.waMessageId,
            // Groups need the original sender's JID; for our own message that
            // is the connected account. Omitted for 1:1 chats.
            ...(jid.endsWith("@g.us") && sock.user?.id
              ? { participant: sock.user.id }
              : {}),
          },
        });
      } catch (err) {
        req.log.error({ err, chatId, messageId }, "WhatsApp revoke failed");
        res.status(400).json({
          error: "Gagal menarik pesan di WhatsApp (mungkin sudah terlalu lama).",
        });
        return;
      }
    }

    await db
      .delete(chatMessagesTable)
      .where(and(eq(chatMessagesTable.id, messageId), eq(chatMessagesTable.chatId, chat.id)));
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to revoke message");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id/common-groups — groups shared with a 1:1 contact.
router.get("/:id/common-groups", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }
    if (chat.phoneNumber.endsWith("@g.us")) {
      res.status(400).json({ error: "Chat is a group" });
      return;
    }
    const sock = getSockForChannel(chat.channelId);
    if (!sock) { res.status(409).json({ error: "WhatsApp not connected" }); return; }

    const target = chat.phoneNumber.replace(/[^0-9]/g, "");
    const all = await sock.groupFetchAllParticipating();
    const found: { groupJid: string; subject: string }[] = [];
    for (const g of Object.values(all)) {
      const isMember = (g.participants ?? []).some((p) => jidDigits((p as { id: string }).id) === target);
      if (isMember) found.push({ groupJid: g.id, subject: g.subject ?? "" });
    }

    // Resolve which of these groups already exist as local chats so the UI can
    // deep-link into them.
    const chatIdByJid = new Map<string, number>();
    if (found.length > 0) {
      const localRows = await db
        .select({ id: chatsTable.id, phoneNumber: chatsTable.phoneNumber })
        .from(chatsTable)
        .where(
          and(
            eq(chatsTable.channelId, chat.channelId),
            inArray(chatsTable.phoneNumber, found.map((f) => f.groupJid))
          )
        );
      for (const r of localRows) chatIdByJid.set(r.phoneNumber, r.id);
    }
    res.json({
      groups: found.map((f) => ({
        groupJid: f.groupJid,
        subject: f.subject,
        chatId: chatIdByJid.get(f.groupJid) ?? null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get common groups");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /:id/participants — add members to a group (mutates the real group).
router.post("/:id/participants", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }
    const bodyParsed = AddGroupParticipantsBody.safeParse(req.body);
    if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }
    if (!chat.phoneNumber.endsWith("@g.us")) {
      res.status(400).json({ error: "Not a group chat" });
      return;
    }
    const sock = getSockForChannel(chat.channelId);
    if (!sock) { res.status(409).json({ error: "WhatsApp not connected" }); return; }

    const phones = bodyParsed.data.phones.map((p) => p.replace(/[^0-9]/g, "")).filter(Boolean);
    if (phones.length === 0) {
      res.status(400).json({ error: "No valid phone numbers" });
      return;
    }
    const jids = phones.map(phoneToJid);
    const raw = await sock.groupParticipantsUpdate(chat.phoneNumber, jids, "add");
    const statusByJid = new Map<string, string>();
    for (const r of raw) {
      if (r.jid) statusByJid.set(r.jid, String(r.status));
    }
    res.json({
      results: jids.map((jid) => ({
        phone: jidDigits(jid) ?? jid,
        jid,
        status: statusByJid.get(jid) ?? "unknown",
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to add group participants");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res): Promise<void> => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

    const chat = await loadOwnedChat(req, res, parsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    const messages = await db
      .select()
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chat.id))
      .orderBy(chatMessagesTable.createdAt);

    if ((chat.unreadCount ?? 0) > 0) {
      db.update(chatsTable)
        .set({ unreadCount: 0 })
        .where(eq(chatsTable.id, chat.id))
        .catch(() => {});
    }

    if (!chat.profilePicUrl) {
      void refreshChatProfilePic(req.session.userId!, chat).catch(() => {});
    }

    const labelMap = await fetchLabelsForChats([chat.id]);
    res.json({
      ...chat,
      unreadCount: 0,
      lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
      createdAt: chat.createdAt.toISOString(),
      labels: labelMap.get(chat.id) ?? [],
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
        // Normalize the nullable text[] column to an empty array so the
        // OpenAPI contract (mentionedPhoneDigits: string[]) holds for
        // every row — clients never see a stray null here.
        mentionedPhoneDigits: m.mentionedPhoneDigits ?? [],
        isStarred: m.isStarred ?? false,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res): Promise<void> => {
  try {
    const idParsed = UpdateChatParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

    const bodyParsed = UpdateChatBody.safeParse(req.body);
    if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

    // Load-then-update so the WHERE for the UPDATE itself can pin to the
    // chat's actual channel_id. Sweeping by the user's full channel set is
    // expensive on a per-row UPDATE; loadOwnedChat already proves
    // ownership.
    const existing = await loadOwnedChat(req, res, idParsed.data.id);
    if (!existing) { res.status(404).json({ error: "Chat not found" }); return; }

    const [updated] = await db
      .update(chatsTable)
      .set(bodyParsed.data)
      .where(
        sql`${chatsTable.id} = ${idParsed.data.id} AND ${chatsTable.channelId} = ${existing.channelId}`
      )
      .returning();

    if (!updated) { res.status(404).json({ error: "Chat not found" }); return; }

    const labelMap = await fetchLabelsForChats([updated.id]);
    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      labels: labelMap.get(updated.id) ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Replace the full set of customer labels attached to a chat. Body:
// { labelIds: number[] }. Only labels owned by the caller's owner are
// accepted; unknown/foreign ids are silently dropped so a stale client can't
// attach another tenant's label. Returns the updated label list.
router.put("/:id/labels", async (req, res): Promise<void> => {
  try {
    const chatId = Number(req.params.id);
    if (!Number.isInteger(chatId) || chatId <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = SetChatLabelsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const chat = await loadOwnedChat(req, res, chatId);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    const requested = Array.from(new Set(parsed.data.labelIds));
    // Keep only label ids that actually belong to this owner.
    const valid =
      requested.length === 0
        ? []
        : (
            await db
              .select({ id: customerLabelsTable.id })
              .from(customerLabelsTable)
              .where(
                and(
                  eq(customerLabelsTable.ownerUserId, ownerUserId),
                  inArray(customerLabelsTable.id, requested)
                )
              )
          ).map((r) => r.id);

    await db.transaction(async (tx) => {
      await tx.delete(chatLabelsTable).where(eq(chatLabelsTable.chatId, chatId));
      if (valid.length > 0) {
        await tx
          .insert(chatLabelsTable)
          .values(valid.map((labelId) => ({ chatId, labelId })))
          .onConflictDoNothing();
      }
    });

    const labelMap = await fetchLabelsForChats([chatId]);
    res.json({ labels: labelMap.get(chatId) ?? [] });
  } catch (err) {
    req.log.error({ err }, "Failed to set chat labels");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const existing = await loadOwnedChat(req, res, id);
    if (!existing) { res.status(404).json({ error: "Chat not found" }); return; }

    // Re-scope the delete itself by channel, so a session swap between the
    // load and the delete still leaves the previous channel's row intact.
    await db
      .delete(chatsTable)
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${existing.channelId}`
      );

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/reply", async (req, res): Promise<void> => {
  try {
    const idParsed = SendManualReplyParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

    const bodyParsed = SendManualReplyBody.safeParse(req.body);
    if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

    const chat = await loadOwnedChat(req, res, idParsed.data.id);
    if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

    // Append the human agent's signature so the recipient can tell who on
    // the team replied. See lib/sender-tag.ts for the format.
    const agentTag = await resolveAgentTag(req.session.userId!);
    const taggedContent = withTag(bodyParsed.data.content, agentTag);

    // For Telegram we must actively push the message — there is no
    // inbound echo loop (unlike Baileys messages.upsert which echoes
    // outbound sends back through our handler). For WhatsApp the
    // outbound send is handled elsewhere (e.g. sendMediaToJid for media,
    // or the socket echo for text via the existing flow).
    const [channel] = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, chat.channelId))
      .limit(1);
    let tgDedupeKey: string | null = null;
    if (channel?.kind === "telegram") {
      const meta =
        (channel.metadata as Record<string, unknown> | null)?.["telegram"] as
          | { botToken?: string }
          | undefined;
      // chat.phoneNumber for telegram is `tg:<chat_id>` (see
      // parseTelegramMessage). We keep the chat_id around so the
      // outbound dedupe key can include it — message_id is per-chat in
      // Telegram and wa_message_id is globally unique in our schema.
      const tgChatId = chat.phoneNumber.startsWith("tg:")
        ? Number.parseInt(chat.phoneNumber.slice(3), 10)
        : NaN;
      if (!meta?.botToken || !Number.isFinite(tgChatId)) {
        res.status(400).json({
          error: "Channel Telegram belum terhubung. Hubungkan bot dulu.",
        });
        return;
      }
      try {
        const sent = await tgSendMessage(meta.botToken, tgChatId, taggedContent);
        tgDedupeKey = `tg:${tgChatId}:${sent.messageId}`;
      } catch (err) {
        req.log.error({ err, chatId: idParsed.data.id }, "telegram reply failed");
        res.status(502).json({ error: "Gagal kirim ke Telegram" });
        return;
      }
    }

    const [message] = await db
      .insert(chatMessagesTable)
      .values({
        chatId: idParsed.data.id,
        direction: "outbound",
        content: taggedContent,
        isAiGenerated: false,
        waMessageId: tgDedupeKey,
      })
      .returning();

    // Channel-atomic: include channelId in WHERE so a channel /unpair that
    // happens between loadOwnedChat and this update can't write into a
    // chat that no longer belongs to that channel.
    // Also stamp firstAgentReplyAt on the first human reply after assignment
    // so KPI reports can compute first-response-time per agent.
    await db
      .update(chatsTable)
      .set({
        lastMessage: taggedContent,
        lastMessageAt: new Date(),
        firstAgentReplyAt: sql`COALESCE(${chatsTable.firstAgentReplyAt}, NOW())`,
      })
      .where(
        sql`${chatsTable.id} = ${idParsed.data.id} AND ${chatsTable.channelId} = ${chat.channelId}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send reply");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/takeover", async (req, res): Promise<void> => {
  try {
    const idParsed = TakeoverChatParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) { res.status(400).json({ error: "Invalid id" }); return; }

    const bodyParsed = TakeoverChatBody.safeParse(req.body);
    if (!bodyParsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

    // Same authz scope as the rest of the chat routes: agents may only
    // toggle takeover on chats assigned to them.
    const az = await authorizedChatWhere(req, res, idParsed.data.id);
    if (!az || !az.where) { res.status(404).json({ error: "Chat not found" }); return; }

    const [updated] = await db
      .update(chatsTable)
      .set({
        isHumanTakeover: bodyParsed.data.takeover,
        status: bodyParsed.data.takeover ? "needs_human" : "ai_handled",
      })
      .where(az.where)
      .returning();

    if (!updated) { res.status(404).json({ error: "Chat not found" }); return; }

    const labelMap = await fetchLabelsForChats([updated.id]);
    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      labels: labelMap.get(updated.id) ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to toggle takeover");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /chats/:id/assign — supervisor / super_admin only. Body:
// { userId: number | null }. Assigning to null clears the assignment.
// The candidate user must belong to the same team (parent_user_id matches
// the effective owner, or is the owner themselves).
router.patch("/:id/assign", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const teamRole = req.session.teamRole ?? "super_admin";
    if (teamRole === "agent") {
      res.status(403).json({ error: "Agen tidak dapat melakukan assign" });
      return;
    }
    const userId = req.session.userId!;
    const existing = await loadOwnedChat(req, res, id);
    if (!existing) { res.status(404).json({ error: "Chat not found" }); return; }

    const raw = (req.body ?? {}) as { userId?: number | null };
    const targetUserId =
      raw.userId === null || raw.userId === undefined
        ? null
        : Number(raw.userId);
    if (targetUserId !== null) {
      const tu = targetUserId as number;
      if (!Number.isInteger(tu) || tu <= 0) {
        res.status(400).json({ error: "userId tidak valid" });
        return;
      }
      // Validate the candidate belongs to the same team as the current user.
      const { isAssignableUnderOwner } = await import("./agents");
      const { getEffectiveOwnerUserId } = await import("../lib/auth");
      const ownerId = await getEffectiveOwnerUserId(userId);
      if (ownerId === null) {
        res.status(403).json({ error: "Tidak ada owner aktif" });
        return;
      }
      const ok = await isAssignableUnderOwner(ownerId, tu);
      if (!ok) {
        res.status(400).json({ error: "User bukan anggota tim Anda" });
        return;
      }
    }

    // Stamp firstAssignedAt the first time a chat is assigned (manual or
    // round-robin). COALESCE keeps the original timestamp on re-assignment
    // so KPI reports still measure "time-to-first-touch".
    const [updated] = await db
      .update(chatsTable)
      .set({
        assignedUserId: targetUserId,
        firstAssignedAt:
          targetUserId == null
            ? undefined
            : sql`COALESCE(${chatsTable.firstAssignedAt}, NOW())`,
      })
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${existing.channelId}`
      )
      .returning();
    if (!updated) { res.status(404).json({ error: "Chat not found" }); return; }
    const labelMap = await fetchLabelsForChats([updated.id]);
    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
      labels: labelMap.get(updated.id) ?? [],
    });
  } catch (err) {
    req.log.error({ err }, "Failed to assign chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send media (image/video/audio/document) via WhatsApp
router.post("/:id/media", upload.single("file"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }

    if (!(await getActiveSocket(req.session.userId!))) {
      // Clean up the file we just saved
      await fs.unlink(req.file.path).catch(() => {});
      res.status(503).json({ error: "WhatsApp belum terhubung" });
      return;
    }

    const target = await jidForChat(req, res, id);
    if (!target) {
      await fs.unlink(req.file.path).catch(() => {});
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const rawCaption = (req.body?.caption as string | undefined)?.trim() || undefined;
    const agentTag = await resolveAgentTag(req.session.userId!);
    // Always sign — even media without a caption gets the agent's tag so
    // the recipient can tell who on the team sent the file.
    const caption = withTag(rawCaption ?? "", agentTag);
    const mimeType = req.file.mimetype || "application/octet-stream";
    const mediaType = classifyMediaType(mimeType);
    const originalName = req.file.originalname;

    let waMessageId: string | null = null;
    try {
      waMessageId = await sendMediaToJid(
        req.session.userId!,
        target.jid,
        req.file.path,
        mimeType,
        mediaType,
        caption,
        originalName
      );
    } catch (err) {
      req.log.error({ err }, "Failed to send media via WhatsApp");
      await fs.unlink(req.file.path).catch(() => {});
      res.status(500).json({ error: "Failed to send media" });
      return;
    }

    const mediaUrl = `/api/media/${path.basename(req.file.path)}`;
    const previewByType = {
      image: "📷 Gambar",
      video: "🎥 Video",
      audio: "🎤 Audio",
      document: `📄 ${originalName}`,
    } as const;
    const preview = caption || previewByType[mediaType];

    // Tag the row with the WA message id so the echo from messages.upsert
    // (which uses onConflictDoNothing on wa_message_id) does NOT create a
    // duplicate row.
    const inserted = await db
      .insert(chatMessagesTable)
      .values({
        chatId: id,
        direction: "outbound",
        content: caption ?? "",
        isAiGenerated: false,
        mediaType,
        mediaUrl,
        mediaMimeType: mimeType,
        mediaFilename: originalName,
        waMessageId,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId })
      .returning();
    const [message] = inserted.length
      ? inserted
      : await db
          .select()
          .from(chatMessagesTable)
          .where(eq(chatMessagesTable.waMessageId, waMessageId!))
          .limit(1);

    await db
      .update(chatsTable)
      .set({ lastMessage: preview, lastMessageAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${target.chat.channelId}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send media");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Generate a quotation PDF for the given products and deliver it to this
// chat over its channel (WhatsApp document or Telegram document). Mirrors the
// dual-channel structure of POST /:id/reply.
router.post("/:id/quotation", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const rawIds = (req.body as { productIds?: unknown })?.productIds;
    const productIds = Array.isArray(rawIds)
      ? rawIds
          .map((v) => Number(v))
          .filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (productIds.length === 0 || productIds.length > 200) {
      res.status(400).json({ error: "Pilih minimal satu produk." });
      return;
    }

    const chat = await loadOwnedChat(req, res, id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    // Build the quotation items from the owner's catalog, preserving the
    // order the client selected them in.
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const uniqueIds = [...new Set(productIds)];
    const items: QuotationItem[] = uniqueIds
      .map((pid) => byId.get(pid))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({
        name: r.name,
        code: r.code,
        price: r.price ?? 0,
        imageUrl: r.imageUrl ?? null,
      }));
    if (items.length === 0) {
      res.status(404).json({ error: "Produk tidak ditemukan." });
      return;
    }

    const pdf = await buildQuotationPdf(items);

    // Persist the PDF as a media file so the recorded message can reference it
    // (same convention as POST /:id/media).
    await fs.mkdir(MEDIA_DIR, { recursive: true });
    const storedName = `${randomUUID()}.pdf`;
    const filepath = path.join(MEDIA_DIR, storedName);
    await fs.writeFile(filepath, Buffer.from(pdf));
    // File name format: YYMMDD-HHMM-Nama.pdf (Nama = customer name, sanitized).
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp =
      `${String(now.getFullYear()).slice(2)}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    const rawName =
      chat.nickname?.trim() ||
      chat.contactName?.trim() ||
      (chat.phoneNumber.startsWith("tg:") ? "" : chat.phoneNumber) ||
      "Customer";
    const safeName =
      rawName
        .replace(/[^\p{L}\p{N}]+/gu, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "Customer";
    const displayName = `${stamp}-${safeName}.pdf`;
    const mimeType = "application/pdf";

    const agentTag = await resolveAgentTag(req.session.userId!);
    const caption = withTag(`Penawaran harga (${items.length} produk)`, agentTag);

    const [channel] = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, chat.channelId))
      .limit(1);

    let dedupeKey: string | null = null;
    if (channel?.kind === "telegram") {
      const meta = (channel.metadata as Record<string, unknown> | null)?.[
        "telegram"
      ] as { botToken?: string } | undefined;
      const tgChatId = chat.phoneNumber.startsWith("tg:")
        ? Number.parseInt(chat.phoneNumber.slice(3), 10)
        : NaN;
      if (!meta?.botToken || !Number.isFinite(tgChatId)) {
        await fs.unlink(filepath).catch(() => {});
        res.status(400).json({
          error: "Channel Telegram belum terhubung. Hubungkan bot dulu.",
        });
        return;
      }
      try {
        const sent = await tgSendDocument(
          meta.botToken,
          tgChatId,
          pdf,
          displayName,
          caption,
          mimeType
        );
        dedupeKey = `tg:${tgChatId}:${sent.messageId}`;
      } catch (err) {
        req.log.error({ err, chatId: id }, "telegram quotation send failed");
        await fs.unlink(filepath).catch(() => {});
        res.status(502).json({ error: "Gagal kirim ke Telegram" });
        return;
      }
    } else {
      if (!(await getActiveSocket(req.session.userId!))) {
        await fs.unlink(filepath).catch(() => {});
        res.status(503).json({ error: "WhatsApp belum terhubung" });
        return;
      }
      const target = await jidForChat(req, res, id);
      if (!target) {
        await fs.unlink(filepath).catch(() => {});
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      try {
        dedupeKey = await sendMediaToJid(
          req.session.userId!,
          target.jid,
          filepath,
          mimeType,
          "document",
          caption,
          displayName
        );
      } catch (err) {
        req.log.error({ err, chatId: id }, "whatsapp quotation send failed");
        await fs.unlink(filepath).catch(() => {});
        res.status(500).json({ error: "Gagal kirim ke WhatsApp" });
        return;
      }
    }

    const mediaUrl = `/api/media/${storedName}`;
    const inserted = await db
      .insert(chatMessagesTable)
      .values({
        chatId: id,
        direction: "outbound",
        content: caption,
        isAiGenerated: false,
        mediaType: "document",
        mediaUrl,
        mediaMimeType: mimeType,
        mediaFilename: displayName,
        waMessageId: dedupeKey,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId })
      .returning();
    const [message] = inserted.length
      ? inserted
      : dedupeKey
        ? await db
            .select()
            .from(chatMessagesTable)
            .where(eq(chatMessagesTable.waMessageId, dedupeKey))
            .limit(1)
        : [];

    await db
      .update(chatsTable)
      .set({ lastMessage: `📄 ${displayName}`, lastMessageAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${chat.channelId}`
      );

    res.json(
      message
        ? { ...message, createdAt: message.createdAt.toISOString() }
        : { ok: true }
    );
  } catch (err) {
    req.log.error({ err }, "Failed to send quotation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send contact card via WhatsApp
router.post("/:id/contact", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const name = (req.body?.name as string | undefined)?.trim();
    const phone = (req.body?.phone as string | undefined)?.trim();
    if (!name || !phone) {
      res.status(400).json({ error: "Name and phone are required" });
      return;
    }

    if (!(await getActiveSocket(req.session.userId!))) {
      res.status(503).json({ error: "WhatsApp belum terhubung" });
      return;
    }

    const target = await jidForChat(req, res, id);
    if (!target) { res.status(404).json({ error: "Chat not found" }); return; }

    let waMessageId: string | null = null;
    try {
      waMessageId = await sendContactToJid(req.session.userId!, target.jid, name, phone);
    } catch (err) {
      req.log.error({ err }, "Failed to send contact via WhatsApp");
      res.status(500).json({ error: "Failed to send contact" });
      return;
    }

    const preview = `👤 ${name}`;
    const insertedRows = await db
      .insert(chatMessagesTable)
      .values({
        chatId: id,
        direction: "outbound",
        content: `${name} (${phone})`,
        isAiGenerated: false,
        mediaType: "contact",
        mediaUrl: null,
        mediaMimeType: "text/vcard",
        mediaFilename: name,
        waMessageId,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId })
      .returning();
    const [message] = insertedRows.length
      ? insertedRows
      : await db
          .select()
          .from(chatMessagesTable)
          .where(eq(chatMessagesTable.waMessageId, waMessageId!))
          .limit(1);

    await db
      .update(chatsTable)
      .set({ lastMessage: preview, lastMessageAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${target.chat.channelId}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send contact");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send a product (image + caption) from the catalog to a chat
router.post("/:id/product", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const productId = Number(req.body?.productId);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!Number.isFinite(productId) || productId <= 0) {
      res.status(400).json({ error: "Invalid productId" });
      return;
    }

    if (!(await getActiveSocket(req.session.userId!))) {
      res.status(503).json({ error: "WhatsApp belum terhubung" });
      return;
    }

    const target = await jidForChat(req, res, id);
    if (!target) { res.status(404).json({ error: "Chat not found" }); return; }

    // User-scoped product lookup: products are shared per-user (not
    // per-channel) post-T003, so any product belonging to the same user as
    // the chat's channel is sendable. We resolve the user id via the chat's
    // channel — never via the session, so an agent on someone else's chat
    // can't accidentally send a foreign catalog item.
    // channel_id is still nullable in the schema during the T002 transition
    // (NOT NULL is applied in T009 Phase E once every row is backfilled);
    // treat a NULL here as a tenant-isolation failure and 404 rather than
    // joining against `NULL`.
    if (target.chat.channelId == null) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    const { channelsTable } = await import("@workspace/db");
    const [chatChannel] = await db
      .select({ userId: channelsTable.userId })
      .from(channelsTable)
      .where(eq(channelsTable.id, target.chat.channelId));
    if (!chatChannel) { res.status(404).json({ error: "Chat not found" }); return; }
    const [product] = await db
      .select()
      .from(productsTable)
      .where(
        and(
          eq(productsTable.id, productId),
          eq(productsTable.userId, chatChannel.userId)
        )
      );
    if (!product) { res.status(404).json({ error: "Product not found" }); return; }

    const priceFmt = new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(product.price);

    // Only public/customer-facing fields are sent. Internal pricing
    // tiers (silver/gold/platinum/reseller/distributor) are NEVER shared.
    const captionLines = [
      `*${product.name}*`,
      `Kode: ${product.code}`,
      `Harga: ${priceFmt}`,
    ];
    const rawCaption = captionLines.join("\n");
    const productAgentTag = await resolveAgentTag(req.session.userId!);
    const caption = withTag(rawCaption, productAgentTag);

    let mediaType: "image" | null = null;
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let mediaFilename: string | null = null;

    // Resolve product image source:
    //   - "/api/media/..."  → read from local disk
    //   - "http(s)://..."   → fetch the bytes server-side and send the actual
    //                         jpg/png to WhatsApp (so customers receive the
    //                         photo, not a link). Capped at 8MB.
    // Missing/unreachable images fall back to text-only caption.
    let imageBuffer: Buffer | null = null;
    let imageMimeType: string | null = null;
    if (product.imageUrl && product.imageUrl.startsWith("/api/media/")) {
      const filename = path.basename(product.imageUrl);
      const candidate = path.join(MEDIA_DIR, filename);
      try {
        imageBuffer = await fs.readFile(candidate);
        imageMimeType = mime.lookup(filename) || "image/jpeg";
      } catch (err) {
        req.log.warn(
          { err, productId },
          "Product image missing on disk, falling back to text"
        );
      }
    } else if (
      product.imageUrl &&
      (product.imageUrl.startsWith("http://") ||
        product.imageUrl.startsWith("https://"))
    ) {
      // Route through flyerInputToImageUrl so Google Drive share links
      // (e.g. drive.google.com/open?id=...) are auto-converted to the
      // thumbnail endpoint that returns actual image bytes. Plain image
      // URLs pass through unchanged.
      const resolvedUrl =
        flyerInputToImageUrl(product.imageUrl) ?? product.imageUrl;
      try {
        const fetched = await fetchRemoteImageSafe(resolvedUrl);
        imageBuffer = fetched.buffer;
        imageMimeType = fetched.mimeType;
      } catch (err) {
        req.log.warn(
          { err, productId, url: product.imageUrl, resolvedUrl },
          "Failed to fetch remote product image, falling back to text"
        );
      }
    }

    let waMessageId: string | null = null;
    if (imageBuffer && imageMimeType) {
      const sock = await getActiveSocket(req.session.userId!);
      if (!sock) { res.status(503).json({ error: "WhatsApp belum terhubung" }); return; }
      try {
        const sent = await sock.sendMessage(target.jid, {
          image: imageBuffer,
          caption,
          mimetype: imageMimeType,
        });
        waMessageId = sent?.key?.id ?? null;
        mediaType = "image";
        mediaUrl = product.imageUrl;
        mediaMimeType = imageMimeType;
        mediaFilename = product.name;
      } catch (err) {
        req.log.error({ err, productId }, "Failed to send product image");
        res.status(500).json({ error: "Failed to send product image" });
        return;
      }
    } else {
      const sock = await getActiveSocket(req.session.userId!);
      if (!sock) { res.status(503).json({ error: "WhatsApp belum terhubung" }); return; }
      try {
        const sent = await sock.sendMessage(target.jid, { text: caption });
        waMessageId = sent?.key?.id ?? null;
      } catch (err) {
        req.log.error({ err, productId }, "Failed to send product as text");
        res.status(500).json({ error: "Failed to send product" });
        return;
      }
    }

    // Dedupe against the echo from messages.upsert via the WA message id.
    const insertedRows = await db
      .insert(chatMessagesTable)
      .values({
        chatId: id,
        direction: "outbound",
        content: caption,
        isAiGenerated: false,
        mediaType,
        mediaUrl,
        mediaMimeType,
        mediaFilename,
        waMessageId,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId })
      .returning();
    const [message] = insertedRows.length
      ? insertedRows
      : await db
          .select()
          .from(chatMessagesTable)
          .where(eq(chatMessagesTable.waMessageId, waMessageId!))
          .limit(1);

    // Follow-up sequence per UX spec:
    //   2) flyer image (extracted from flyerUrl iframe/URL, sent as image)
    //   3) productUrl (text, WA renders link preview)
    //   4+) each videoUrl (text, WA renders link preview)
    // Each as its own message. 800ms throttle between sends keeps ordering
    // deterministic and gives WhatsApp time to resolve link previews.
    const sock = await getActiveSocket(req.session.userId!);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lastSentDescription: string | null = null;

    // Step 2: flyer image.
    if (sock && product.flyerUrl && product.flyerUrl.length > 0) {
      const flyerImageUrl = flyerInputToImageUrl(product.flyerUrl);
      if (!flyerImageUrl) {
        req.log.warn(
          { productId, flyerUrl: product.flyerUrl },
          "Flyer input did not contain a usable URL/iframe src — skipping"
        );
      } else {
        try {
          await sleep(800);
          const fetched = await fetchRemoteImageSafe(flyerImageUrl);
          const sent = await sock.sendMessage(target.jid, {
            image: fetched.buffer,
            mimetype: fetched.mimeType,
          });
          const flyerWaId = sent?.key?.id ?? null;
          if (flyerWaId) {
            await db
              .insert(chatMessagesTable)
              .values({
                chatId: id,
                direction: "outbound",
                content: "",
                isAiGenerated: false,
                mediaType: "image",
                mediaUrl: flyerImageUrl,
                mediaMimeType: fetched.mimeType,
                mediaFilename: `${product.name} - Flyer`,
                waMessageId: flyerWaId,
              })
              .onConflictDoNothing({ target: chatMessagesTable.waMessageId });
          }
          lastSentDescription = "📄 Flyer";
        } catch (err) {
          req.log.warn(
            { err, productId, flyerUrl: product.flyerUrl, flyerImageUrl },
            "Failed to send product flyer — skipping"
          );
        }
      }
    }

    // Steps 3+: link follow-ups (productUrl, then videoUrls).
    const followUps: string[] = [];
    if (product.productUrl && product.productUrl.length > 0) {
      followUps.push(product.productUrl);
    }
    if (Array.isArray(product.videoUrls)) {
      for (const v of product.videoUrls) {
        if (v && v.length > 0) followUps.push(v);
      }
    }
    for (const url of followUps) {
      if (!sock) break;
      try {
        await sleep(800);
        const sent = await sock.sendMessage(target.jid, { text: url });
        const followWaId = sent?.key?.id ?? null;
        // Skip route-side insert when WA didn't return an id — letting the
        // messages.upsert echo persist the row prevents duplicate logical
        // rows (the unique index treats NULL waMessageId as distinct).
        if (followWaId) {
          await db
            .insert(chatMessagesTable)
            .values({
              chatId: id,
              direction: "outbound",
              content: url,
              isAiGenerated: false,
              mediaType: null,
              mediaUrl: null,
              mediaMimeType: null,
              mediaFilename: null,
              waMessageId: followWaId,
            })
            .onConflictDoNothing({ target: chatMessagesTable.waMessageId });
        }
        lastSentDescription = url;
      } catch (err) {
        req.log.warn({ err, productId, url }, "Failed to send product link follow-up");
      }
    }

    // Reflect the actual last message in the chat list summary. Owner-scoped
    // so the long-running multi-step product send (with 800ms throttle between
    // each flyer/link) can't write into another account's chat if the operator
    // disconnects + reconnects mid-flight.
    const preview = lastSentDescription ?? `🛍️ ${product.name} — ${priceFmt}`;
    await db
      .update(chatsTable)
      .set({ lastMessage: preview, lastMessageAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${target.chat.channelId}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send product");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send a text shortcut to a chat. If the shortcut carries a `link` (an image
// URL), the image is delivered as a photo with `replacement` as the caption;
// otherwise `replacement` is sent as plain text. Dual-channel: WhatsApp via the
// active socket, Telegram via the Bot API.
router.post("/:id/shortcut", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    const shortcutId = Number(req.body?.shortcutId);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    if (!Number.isFinite(shortcutId) || shortcutId <= 0) {
      res.status(400).json({ error: "Invalid shortcutId" });
      return;
    }

    const chat = await loadOwnedChat(req, res, id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }
    // channel_id is nullable during the tenancy transition — treat NULL as a
    // tenant-isolation failure rather than joining against NULL.
    if (chat.channelId == null) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    // Shortcuts are owner-scoped (keyed by the owning super_admin user). Resolve
    // the owner via the chat's channel — never via the session — so an agent on
    // someone else's chat can't send a foreign tenant's shortcut.
    const [channel] = await db
      .select()
      .from(channelsTable)
      .where(eq(channelsTable.id, chat.channelId))
      .limit(1);
    if (!channel) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const [shortcut] = await db
      .select()
      .from(textShortcutsTable)
      .where(
        and(
          eq(textShortcutsTable.id, shortcutId),
          eq(textShortcutsTable.userId, channel.userId)
        )
      )
      .limit(1);
    if (!shortcut) {
      res.status(404).json({ error: "Shortcut not found" });
      return;
    }

    // Channel-scope consistency: a shortcut with NO channel assignments is
    // global (sendable on any of the owner's channels); one WITH assignments is
    // restricted to those channels only. Mirror the same scoping the resource
    // CRUD enforces so a channel-A-only shortcut can't leak into channel B.
    const assignedChannelIds =
      (await loadChannelIdsBatch("shortcut", [shortcut.id])).get(shortcut.id) ??
      [];
    if (
      assignedChannelIds.length > 0 &&
      !assignedChannelIds.includes(chat.channelId)
    ) {
      res.status(404).json({ error: "Shortcut not found" });
      return;
    }

    const agentTag = await resolveAgentTag(req.session.userId!);
    const caption = withTag(shortcut.replacement, agentTag);

    // Resolve the image bytes when a link is present. Google Drive share links
    // are routed through flyerInputToImageUrl. A fetch failure falls back to a
    // text-only send so the agent's message still goes out.
    let imageBuffer: Buffer | null = null;
    let imageMimeType: string | null = null;
    // Local served URL for the persisted copy. The raw `shortcut.link` (often a
    // Google Drive share link) is NOT directly renderable in an <img>, so we
    // persist the fetched bytes under MEDIA_DIR and record that path instead —
    // otherwise the thumbnail/preview won't show in the MaxiChat conversation.
    let mediaStoredUrl: string | null = null;
    if (
      shortcut.link &&
      (shortcut.link.startsWith("http://") ||
        shortcut.link.startsWith("https://"))
    ) {
      const resolvedUrl =
        flyerInputToImageUrl(shortcut.link) ?? shortcut.link;
      try {
        const fetched = await fetchRemoteImageSafe(resolvedUrl);
        imageBuffer = fetched.buffer;
        imageMimeType = fetched.mimeType;
        await fs.mkdir(MEDIA_DIR, { recursive: true });
        const ext = mime.extension(imageMimeType) || "jpg";
        const storedName = `${randomUUID()}.${ext}`;
        await fs.writeFile(path.join(MEDIA_DIR, storedName), imageBuffer);
        mediaStoredUrl = `/api/media/${storedName}`;
      } catch (err) {
        req.log.warn(
          { err, shortcutId, url: shortcut.link, resolvedUrl },
          "Failed to fetch shortcut image, falling back to text"
        );
        imageBuffer = null;
        imageMimeType = null;
        mediaStoredUrl = null;
      }
    }

    let dedupeKey: string | null = null;
    let mediaType: "image" | null = null;
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let mediaFilename: string | null = null;

    if (channel.kind === "telegram") {
      const meta = (channel.metadata as Record<string, unknown> | null)?.[
        "telegram"
      ] as { botToken?: string } | undefined;
      const tgChatId = chat.phoneNumber.startsWith("tg:")
        ? Number.parseInt(chat.phoneNumber.slice(3), 10)
        : NaN;
      if (!meta?.botToken || !Number.isFinite(tgChatId)) {
        res.status(400).json({
          error: "Channel Telegram belum terhubung. Hubungkan bot dulu.",
        });
        return;
      }
      try {
        if (imageBuffer && imageMimeType) {
          const sent = await tgSendPhoto(
            meta.botToken,
            tgChatId,
            imageBuffer,
            `${shortcut.shortcut}.jpg`,
            caption,
            imageMimeType
          );
          dedupeKey = `tg:${tgChatId}:${sent.messageId}`;
          mediaType = "image";
          mediaUrl = mediaStoredUrl;
          mediaMimeType = imageMimeType;
          mediaFilename = shortcut.shortcut;
        } else {
          const sent = await tgSendMessage(meta.botToken, tgChatId, caption);
          dedupeKey = `tg:${tgChatId}:${sent.messageId}`;
        }
      } catch (err) {
        req.log.error({ err, chatId: id, shortcutId }, "telegram shortcut send failed");
        res.status(502).json({ error: "Gagal kirim ke Telegram" });
        return;
      }
    } else {
      const sock = await getActiveSocket(req.session.userId!);
      if (!sock) {
        res.status(503).json({ error: "WhatsApp belum terhubung" });
        return;
      }
      const target = await jidForChat(req, res, id);
      if (!target) {
        res.status(404).json({ error: "Chat not found" });
        return;
      }
      try {
        if (imageBuffer && imageMimeType) {
          const sent = await sock.sendMessage(target.jid, {
            image: imageBuffer,
            caption,
            mimetype: imageMimeType,
          });
          dedupeKey = sent?.key?.id ?? null;
          mediaType = "image";
          mediaUrl = mediaStoredUrl;
          mediaMimeType = imageMimeType;
          mediaFilename = shortcut.shortcut;
        } else {
          const sent = await sock.sendMessage(target.jid, { text: caption });
          dedupeKey = sent?.key?.id ?? null;
        }
      } catch (err) {
        req.log.error({ err, chatId: id, shortcutId }, "Failed to send shortcut");
        res.status(500).json({ error: "Failed to send shortcut" });
        return;
      }
    }

    // Dedupe against the WA echo from messages.upsert via the WA message id.
    const insertedRows = await db
      .insert(chatMessagesTable)
      .values({
        chatId: id,
        direction: "outbound",
        content: caption,
        isAiGenerated: false,
        mediaType,
        mediaUrl,
        mediaMimeType,
        mediaFilename,
        waMessageId: dedupeKey,
      })
      .onConflictDoNothing({ target: chatMessagesTable.waMessageId })
      .returning();
    const [message] = insertedRows.length
      ? insertedRows
      : await db
          .select()
          .from(chatMessagesTable)
          .where(eq(chatMessagesTable.waMessageId, dedupeKey!))
          .limit(1);

    const preview = mediaType === "image" ? `🖼️ ${caption}` : caption;
    await db
      .update(chatsTable)
      .set({ lastMessage: preview.slice(0, 200), lastMessageAt: new Date() })
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.channelId} = ${chat.channelId}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
