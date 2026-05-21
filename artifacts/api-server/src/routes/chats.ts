import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
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

    try {
      await sendMediaToJid(
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

    const [message] = await db
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
      })
      .returning();

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

    try {
      await sendContactToJid(target.jid, name, phone);
    } catch (err) {
      req.log.error({ err }, "Failed to send contact via WhatsApp");
      return res.status(500).json({ error: "Failed to send contact" });
    }

    const preview = `👤 ${name}`;
    const [message] = await db
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
      })
      .returning();

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

    const captionLines = [
      `*${product.name}*`,
      `Kode: ${product.code}`,
      `Harga: ${priceFmt}`,
    ];
    if (product.description?.trim()) {
      captionLines.push("", product.description.trim());
    }
    const caption = captionLines.join("\n");

    let mediaType: "image" | null = null;
    let mediaUrl: string | null = null;
    let mediaMimeType: string | null = null;
    let mediaFilename: string | null = null;

    // If product has an image, try to resolve it on disk first. Missing files
    // are recoverable (fall back to text). Send failures are NOT recoverable.
    let imageFilePath: string | null = null;
    let imageMimeType: string | null = null;
    if (product.imageUrl && product.imageUrl.startsWith("/api/media/")) {
      const filename = path.basename(product.imageUrl);
      const candidate = path.join(MEDIA_DIR, filename);
      try {
        await fs.access(candidate);
        imageFilePath = candidate;
        imageMimeType = mime.lookup(filename) || "image/jpeg";
      } catch (err) {
        req.log.warn(
          { err, productId },
          "Product image missing on disk, falling back to text"
        );
      }
    }

    if (imageFilePath && imageMimeType) {
      try {
        await sendMediaToJid(
          target.jid,
          imageFilePath,
          imageMimeType,
          "image",
          caption,
          product.name
        );
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
        await sock.sendMessage(target.jid, { text: caption });
      } catch (err) {
        req.log.error({ err, productId }, "Failed to send product as text");
        return res.status(500).json({ error: "Failed to send product" });
      }
    }

    const [message] = await db
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
      })
      .returning();

    const preview = `🛍️ ${product.name} — ${priceFmt}`;
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
