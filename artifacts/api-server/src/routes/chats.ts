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
} from "@workspace/api-zod";
import {
  MEDIA_DIR,
  sendMediaToJid,
  sendContactToJid,
  getActiveSocket,
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
    lookup: (hostname, options, cb) => {
      dnsCallback.lookup(
        hostname,
        { ...options, all: false, verbatim: true },
        (err, address, family) => {
          if (err) return cb(err, "", 0);
          if (isPrivateIp(address)) {
            return cb(
              new Error(
                `Host resolved to private IP at connect time: ${hostname} → ${address}`
              ),
              "",
              0
            );
          }
          cb(null, address, family);
        }
      );
    },
  },
});

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
    const resp = await undiciFetch(urlStr, {
      signal: controller.signal,
      redirect: "manual",
      dispatcher: safeImageDispatcher,
    });
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`Redirect not allowed (HTTP ${resp.status})`);
    }
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

async function jidForChat(chatId: number): Promise<{ chat: typeof chatsTable.$inferSelect; jid: string } | null> {
  const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.id, chatId));
  if (!chat) return null;
  // Groups: phoneNumber column already holds the full "<id>@g.us" JID.
  if (chat.phoneNumber.includes("@")) {
    return { chat, jid: chat.phoneNumber };
  }
  const cleaned = chat.phoneNumber.replace(/[^\d]/g, "");
  return { chat, jid: `${cleaned}@s.whatsapp.net` };
}

router.get("/", async (req, res) => {
  try {
    const parsed = ListChatsQueryParams.safeParse(req.query);
    const status = parsed.success ? parsed.data.status : undefined;
    const tag = parsed.success ? parsed.data.tag : undefined;

    // Sort: (1) pinned chats first (most recently pinned at top),
    // (2) non-archived next, (3) by last message time desc with chats that
    // have any history above empty ones, (4) finally createdAt as tiebreaker.
    let query = db
      .select()
      .from(chatsTable)
      .orderBy(
        sql`(${chatsTable.pinnedAt} IS NOT NULL) DESC,
            ${chatsTable.pinnedAt} DESC NULLS LAST,
            ${chatsTable.isArchived} ASC,
            (${chatsTable.lastMessageAt} IS NOT NULL) DESC,
            ${chatsTable.lastMessageAt} DESC NULLS LAST,
            ${chatsTable.createdAt} DESC`
      );
    const results = await query;

    let filtered = results;
    if (status && status !== "all") {
      filtered = filtered.filter((c) => c.status === status);
    }
    if (tag && tag !== "all") {
      filtered = filtered.filter((c) => c.tag === tag);
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

router.get("/:id", async (req, res) => {
  try {
    const parsed = GetChatParams.safeParse({ id: Number(req.params.id) });
    if (!parsed.success) return res.status(400).json({ error: "Invalid id" });

    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.id, parsed.data.id));
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

    const [updated] = await db
      .update(chatsTable)
      .set(bodyParsed.data)
      .where(eq(chatsTable.id, idParsed.data.id))
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

    const [existing] = await db.select().from(chatsTable).where(eq(chatsTable.id, id));
    if (!existing) return res.status(404).json({ error: "Chat not found" });

    await db.delete(chatsTable).where(eq(chatsTable.id, id));

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

    const [chat] = await db.select().from(chatsTable).where(eq(chatsTable.id, idParsed.data.id));
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

    await db
      .update(chatsTable)
      .set({ lastMessage: bodyParsed.data.content, lastMessageAt: new Date() })
      .where(eq(chatsTable.id, idParsed.data.id));

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

    const [updated] = await db
      .update(chatsTable)
      .set({
        isHumanTakeover: bodyParsed.data.takeover,
        status: bodyParsed.data.takeover ? "needs_human" : "ai_handled",
      })
      .where(eq(chatsTable.id, idParsed.data.id))
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

    if (!getActiveSocket()) {
      // Clean up the file we just saved
      await fs.unlink(req.file.path).catch(() => {});
      return res.status(503).json({ error: "WhatsApp belum terhubung" });
    }

    const target = await jidForChat(id);
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
      .where(eq(chatsTable.id, id));

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

    if (!getActiveSocket()) {
      return res.status(503).json({ error: "WhatsApp belum terhubung" });
    }

    const target = await jidForChat(id);
    if (!target) return res.status(404).json({ error: "Chat not found" });

    let waMessageId: string | null = null;
    try {
      waMessageId = await sendContactToJid(target.jid, name, phone);
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
      .where(eq(chatsTable.id, id));

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

    if (!getActiveSocket()) {
      return res.status(503).json({ error: "WhatsApp belum terhubung" });
    }

    const target = await jidForChat(id);
    if (!target) return res.status(404).json({ error: "Chat not found" });

    const [product] = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, productId));
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
      try {
        const fetched = await fetchRemoteImageSafe(product.imageUrl);
        imageBuffer = fetched.buffer;
        imageMimeType = fetched.mimeType;
      } catch (err) {
        req.log.warn(
          { err, productId, url: product.imageUrl },
          "Failed to fetch remote product image, falling back to text"
        );
      }
    }

    let waMessageId: string | null = null;
    if (imageBuffer && imageMimeType) {
      const sock = getActiveSocket();
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
      const sock = getActiveSocket();
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

    // Send link follow-ups: productUrl, then each videoUrl. Each as its own
    // message so WhatsApp generates a link preview thumbnail per URL.
    // link-preview-js (installed) makes Baileys auto-fetch the preview when
    // we call sendMessage({ text: <url> }). A small delay between sends keeps
    // ordering deterministic on the WA side and gives the preview fetch time.
    const sock = getActiveSocket();
    const followUps: string[] = [];
    if (product.productUrl && product.productUrl.length > 0) {
      followUps.push(product.productUrl);
    }
    if (Array.isArray(product.videoUrls)) {
      for (const v of product.videoUrls) {
        if (v && v.length > 0) followUps.push(v);
      }
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let lastSentUrl: string | null = null;
    for (const url of followUps) {
      if (!sock) break;
      try {
        // 800ms throttle between link sends — gives WA time to resolve the
        // preview server-side before the next message arrives.
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
        lastSentUrl = url;
      } catch (err) {
        // Non-fatal: log and continue with remaining URLs.
        req.log.warn({ err, productId, url }, "Failed to send product link follow-up");
      }
    }

    // Reflect the actual last message in the chat list summary. If any link
    // follow-up was sent, the link itself is the latest outbound message;
    // otherwise show the product preview.
    const preview = lastSentUrl ?? `🛍️ ${product.name} — ${priceFmt}`;
    await db
      .update(chatsTable)
      .set({ lastMessage: preview, lastMessageAt: new Date() })
      .where(eq(chatsTable.id, id));

    res.json({ ...message, createdAt: message.createdAt.toISOString() });
  } catch (err) {
    req.log.error({ err }, "Failed to send product");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
