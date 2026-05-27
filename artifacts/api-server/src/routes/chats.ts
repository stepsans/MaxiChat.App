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
import { db } from "@workspace/db";
import { chatsTable, chatMessagesTable, productsTable } from "@workspace/db";
import { eq, desc, and, sql } from "drizzle-orm";
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
} from "@workspace/api-zod";
import {
  getCurrentOwnerPhone,
  MEDIA_DIR,
  sendMediaToJid,
  sendContactToJid,
  getActiveSocket,
  refreshChatProfilePic,
} from "./whatsapp";

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
//   * ownerPhone (cross-tenant isolation — must always apply)
//   * for the "agent" role, additionally require assigned_user_id = userId,
//     so a guessed/leaked chat id from a different conversation looks like
//     "not found" instead of leaking the row.
async function authorizedChatWhere(userId: number, chatId: number) {
  const ownerPhone = await getCurrentOwnerPhone(userId);
  if (!ownerPhone) return null;
  const teamRole = await getEffectiveTeamRole(userId);
  const base = sql`${chatsTable.id} = ${chatId} AND ${chatsTable.ownerPhone} = ${ownerPhone}`;
  return teamRole === "agent"
    ? sql`${base} AND ${chatsTable.assignedUserId} = ${userId}`
    : base;
}

async function jidForChat(userId: number, chatId: number): Promise<{ chat: typeof chatsTable.$inferSelect; jid: string } | null> {
  // Scope by current owner + (for agents) by assignment — see
  // authorizedChatWhere. Returning null on any failure lets callers reply 404
  // without leaking whether the chat exists for another role.
  const where = await authorizedChatWhere(userId, chatId);
  if (!where) return null;
  const [chat] = await db.select().from(chatsTable).where(where);
  if (!chat) return null;
  // Groups: phoneNumber column already holds the full "<id>@g.us" JID.
  if (chat.phoneNumber.includes("@")) {
    return { chat, jid: chat.phoneNumber };
  }
  const cleaned = chat.phoneNumber.replace(/[^\d]/g, "");
  return { chat, jid: `${cleaned}@s.whatsapp.net` };
}

// Centralised ownership-aware loader: returns the chat row only if it
// belongs to the currently linked WhatsApp account AND (for agents) is
// assigned to the calling user. Null otherwise (which every caller treats
// as 404 — indistinguishable from "doesn't exist" to avoid leaking that
// another account's chat exists).
async function loadOwnedChat(userId: number, chatId: number) {
  const where = await authorizedChatWhere(userId, chatId);
  if (!where) return null;
  const [chat] = await db.select().from(chatsTable).where(where);
  return chat ?? null;
}

router.get("/", async (req, res) => {
  try {
    const parsed = ListChatsQueryParams.safeParse(req.query);
    const status = parsed.success ? parsed.data.status : undefined;
    const tag = parsed.success ? parsed.data.tag : undefined;

    // Per-phone isolation: when nobody is logged in, the list is empty (so
    // a freshly-opened browser before QR pairing shows no history). Once a
    // number connects, only its own chats become visible.
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      return res.json([]);
    }

    // Role-aware filter: agents only see chats explicitly assigned to them;
    // supervisors and the super_admin see everything under the owner phone.
    const teamRole = req.session.teamRole ?? "super_admin";
    const baseWhere =
      teamRole === "agent"
        ? sql`${chatsTable.ownerPhone} = ${ownerPhone} AND ${chatsTable.assignedUserId} = ${userId}`
        : sql`${chatsTable.ownerPhone} = ${ownerPhone}`;

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

    res.json(
      filtered.map((c) => ({
        ...c,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
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

router.post("/open-by-phone", async (req, res) => {
  try {
    const parsed = OpenChatByPhoneBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid body" });
    }
    const digits = normalisePhoneDigits(parsed.data.phoneNumber);
    if (digits.length < 8 || digits.length > 15) {
      return res.status(400).json({ error: "Invalid phone number" });
    }
    // Personal chats are stored as "+<digits>"; group jids use "@g.us" and
    // are not creatable from this UI.
    const phoneNumber = "+" + digits;

    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(409)
        .json({ error: "WhatsApp belum terhubung. Pair akun WhatsApp terlebih dulu." });
    }

    // Deterministic "open-or-create": try INSERT … ON CONFLICT DO NOTHING. If
    // RETURNING gives us a row, we created it. Otherwise the unique
    // (ownerPhone, phoneNumber) row already existed and we re-select its id.
    const contactName = parsed.data.contactName?.trim() || digits;
    const inserted = await db
      .insert(chatsTable)
      .values({
        ownerPhone,
        phoneNumber,
        contactName,
        status: "ai_handled",
        tag: "none",
        isHumanTakeover: false,
        unreadCount: 0,
        isLid: false,
      })
      .onConflictDoNothing({
        target: [chatsTable.ownerPhone, chatsTable.phoneNumber],
      })
      .returning({ id: chatsTable.id });

    if (inserted[0]) {
      return res.json({ chatId: inserted[0].id, created: true, phoneNumber });
    }

    const [existing] = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(
        sql`${chatsTable.ownerPhone} = ${ownerPhone} AND ${chatsTable.phoneNumber} = ${phoneNumber}`
      )
      .limit(1);

    if (!existing) {
      // Should be impossible: insert was a no-op, so a row must exist.
      return res.status(500).json({ error: "Failed to open chat" });
    }
    return res.json({ chatId: existing.id, created: false, phoneNumber });
  } catch (err) {
    req.log.error({ err }, "Failed to open chat by phone");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/refresh-avatar", async (req, res) => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const chat = await loadOwnedChat(req.session.userId!, parsed.data.id);
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const url = await refreshChatProfilePic(req.session.userId!, chat, {
      force: true,
    });
    return res.json({ profilePicUrl: url });
  } catch (err) {
    req.log.error({ err }, "Failed to refresh chat avatar");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const chat = await loadOwnedChat(req.session.userId!, parsed.data.id);
    if (!chat) return res.status(404).json({ error: "Chat not found" });

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

    res.json({
      ...chat,
      unreadCount: 0,
      lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
      createdAt: chat.createdAt.toISOString(),
      messages: messages.map((m) => ({
        ...m,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const idParsed = UpdateChatParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = UpdateChatBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) return res.status(404).json({ error: "Chat not found" });

    const [updated] = await db
      .update(chatsTable)
      .set(bodyParsed.data)
      .where(
        sql`${chatsTable.id} = ${idParsed.data.id} AND ${chatsTable.ownerPhone} = ${ownerPhone}`
      )
      .returning();

    if (!updated) return res.status(404).json({ error: "Chat not found" });

    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const existing = await loadOwnedChat(req.session.userId!, id);
    if (!existing) return res.status(404).json({ error: "Chat not found" });

    // Re-scope the delete itself by owner, so a session swap between the
    // load and the delete still leaves the previous owner's row intact.
    await db
      .delete(chatsTable)
      .where(
        sql`${chatsTable.id} = ${id} AND ${chatsTable.ownerPhone} = ${existing.ownerPhone}`
      );

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete chat");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/reply", async (req, res) => {
  try {
    const idParsed = SendManualReplyParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = SendManualReplyBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const chat = await loadOwnedChat(req.session.userId!, idParsed.data.id);
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const [message] = await db
      .insert(chatMessagesTable)
      .values({
        chatId: idParsed.data.id,
        direction: "outbound",
        content: bodyParsed.data.content,
        isAiGenerated: false,
      })
      .returning();

    // Owner-atomic: include ownerPhone in WHERE so a /disconnect that
    // happens between loadOwnedChat and this update can't write into a
    // chat that no longer belongs to the current session.
    // Also stamp firstAgentReplyAt on the first human reply after assignment
    // so KPI reports can compute first-response-time per agent.
    await db
      .update(chatsTable)
      .set({
        lastMessage: bodyParsed.data.content,
        lastMessageAt: new Date(),
        firstAgentReplyAt: sql`COALESCE(${chatsTable.firstAgentReplyAt}, NOW())`,
      })
      .where(
        sql`${chatsTable.id} = ${idParsed.data.id} AND ${chatsTable.ownerPhone} = ${chat.ownerPhone}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send reply");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/:id/takeover", async (req, res) => {
  try {
    const idParsed = TakeoverChatParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = TakeoverChatBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    // Same authz scope as the rest of the chat routes: agents may only
    // toggle takeover on chats assigned to them.
    const where = await authorizedChatWhere(req.session.userId!, idParsed.data.id);
    if (!where) return res.status(404).json({ error: "Chat not found" });

    const [updated] = await db
      .update(chatsTable)
      .set({
        isHumanTakeover: bodyParsed.data.takeover,
        status: bodyParsed.data.takeover ? "needs_human" : "ai_handled",
      })
      .where(where)
      .returning();

    if (!updated) return res.status(404).json({ error: "Chat not found" });

    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
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
router.patch("/:id/assign", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0)
      return res.status(400).json({ error: "Invalid id" });
    const teamRole = req.session.teamRole ?? "super_admin";
    if (teamRole === "agent") {
      return res.status(403).json({ error: "Agen tidak dapat melakukan assign" });
    }
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) return res.status(404).json({ error: "Chat not found" });

    const raw = (req.body ?? {}) as { userId?: number | null };
    const targetUserId =
      raw.userId === null || raw.userId === undefined
        ? null
        : Number(raw.userId);
    if (targetUserId !== null && (!Number.isInteger(targetUserId) || targetUserId <= 0)) {
      return res.status(400).json({ error: "userId tidak valid" });
    }

    // Validate the candidate belongs to the same team as the current user.
    if (targetUserId !== null) {
      const { isAssignableUnderOwner } = await import("./agents");
      const { getEffectiveOwnerUserId } = await import("../lib/auth");
      const ownerId = await getEffectiveOwnerUserId(userId);
      const ok = await isAssignableUnderOwner(ownerId, targetUserId);
      if (!ok) {
        return res.status(400).json({ error: "User bukan anggota tim Anda" });
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
        sql`${chatsTable.id} = ${id} AND ${chatsTable.ownerPhone} = ${ownerPhone}`
      )
      .returning();
    if (!updated) return res.status(404).json({ error: "Chat not found" });
    res.json({
      ...updated,
      lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
      createdAt: updated.createdAt.toISOString(),
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
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Missing file" });
    }

    if (!getActiveSocket(req.session.userId!)) {
      // Clean up the file we just saved
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(503).json({ error: "WhatsApp belum terhubung" });
    }

    const target = await jidForChat(req.session.userId!, id);
    if (!target) {
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(404).json({ error: "Chat not found" });
    }

    const caption = (req.body?.caption as string | undefined)?.trim() || undefined;
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
      return res.status(500).json({ error: "Failed to send media" });
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
        sql`${chatsTable.id} = ${id} AND ${chatsTable.ownerPhone} = ${target.chat.ownerPhone}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send media");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send contact card via WhatsApp
router.post("/:id/contact", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const name = (req.body?.name as string | undefined)?.trim();
    const phone = (req.body?.phone as string | undefined)?.trim();
    if (!name || !phone) {
      return res.status(400).json({ error: "Name and phone are required" });
    }

    if (!getActiveSocket(req.session.userId!)) {
      return res.status(503).json({ error: "WhatsApp belum terhubung" });
    }

    const target = await jidForChat(req.session.userId!, id);
    if (!target) return res.status(404).json({ error: "Chat not found" });

    let waMessageId: string | null = null;
    try {
      waMessageId = await sendContactToJid(req.session.userId!, target.jid, name, phone);
    } catch (err) {
      req.log.error({ err }, "Failed to send contact via WhatsApp");
      return res.status(500).json({ error: "Failed to send contact" });
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
        sql`${chatsTable.id} = ${id} AND ${chatsTable.ownerPhone} = ${target.chat.ownerPhone}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send contact");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Send a product (image + caption) from the catalog to a chat
router.post("/:id/product", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const productId = Number(req.body?.productId);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    if (!Number.isFinite(productId) || productId <= 0) {
      return res.status(400).json({ error: "Invalid productId" });
    }

    if (!getActiveSocket(req.session.userId!)) {
      return res.status(503).json({ error: "WhatsApp belum terhubung" });
    }

    const target = await jidForChat(req.session.userId!, id);
    if (!target) return res.status(404).json({ error: "Chat not found" });

    // Owner-scoped product lookup: an operator can only send products from
    // their own catalog. Even a leaked product id from another account
    // returns 404 here.
    const [product] = await db
      .select()
      .from(productsTable)
      .where(
        and(
          eq(productsTable.id, productId),
          eq(productsTable.ownerPhone, target.chat.ownerPhone)
        )
      );
    if (!product) return res.status(404).json({ error: "Product not found" });

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
    const caption = captionLines.join("\n");

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
      const sock = getActiveSocket(req.session.userId!);
      if (!sock) return res.status(503).json({ error: "WhatsApp belum terhubung" });
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
        return res.status(500).json({ error: "Failed to send product image" });
      }
    } else {
      const sock = getActiveSocket(req.session.userId!);
      if (!sock) return res.status(503).json({ error: "WhatsApp belum terhubung" });
      try {
        const sent = await sock.sendMessage(target.jid, { text: caption });
        waMessageId = sent?.key?.id ?? null;
      } catch (err) {
        req.log.error({ err, productId }, "Failed to send product as text");
        return res.status(500).json({ error: "Failed to send product" });
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
    const sock = getActiveSocket(req.session.userId!);
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
        sql`${chatsTable.id} = ${id} AND ${chatsTable.ownerPhone} = ${target.chat.ownerPhone}`
      );

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send product");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
