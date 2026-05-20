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
import { eq } from "drizzle-orm";
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
) {
  if (!sock) throw new Error("WhatsApp is not connected");
  const buffer = await fs.readFile(filepath);
  if (mediaType === "image") {
    await sock.sendMessage(jid, { image: buffer, caption, mimetype: mimeType });
  } else if (mediaType === "video") {
    await sock.sendMessage(jid, { video: buffer, caption, mimetype: mimeType });
  } else if (mediaType === "audio") {
    await sock.sendMessage(jid, { audio: buffer, mimetype: mimeType, ptt: false });
  } else {
    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: mimeType,
      fileName: filename ?? path.basename(filepath),
      caption,
    });
  }
}

export async function sendContactToJid(
  jid: string,
  contactName: string,
  contactPhone: string
) {
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
  await sock.sendMessage(jid, {
    contacts: {
      displayName: contactName,
      contacts: [{ vcard }],
    },
  });
}

type WASocket = Awaited<ReturnType<typeof makeWASocketType>>;

let sock: WASocket | null = null;
let isConnecting = false;

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

async function getOrCreateChat(phoneNumber: string, contactName: string) {
  const existing = await db
    .select()
    .from(chatsTable)
    .where(eq(chatsTable.phoneNumber, phoneNumber))
    .limit(1);

  if (existing.length > 0) return existing[0];

  const [created] = await db
    .insert(chatsTable)
    .values({
      phoneNumber,
      contactName,
      status: "ai_handled",
      tag: "none",
      isHumanTakeover: false,
      unreadCount: 0,
    })
    .returning();
  return created;
}

async function generateAiReply(chatId: number, userMessage: string): Promise<string | null> {
  try {
    const settingsRows = await db.select().from(settingsTable).limit(1);
    const settings = settingsRows[0];
    if (!settings?.autoReplyEnabled) return null;

    const knowledgeEntries = await db.select().from(knowledgeTable);
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

async function handleIncomingMessage(
  jid: string,
  messageText: string,
  pushName: string,
  rawNumber: string,
  media?: IncomingMedia
) {
  const phoneNumber = `+${rawNumber}`;
  const contactName = pushName || rawNumber;

  const chat = await getOrCreateChat(phoneNumber, contactName);

  // Build a human-readable preview for the chat list
  const preview = messageText.trim().length
    ? messageText
    : media
      ? media.mediaType === "image"
        ? "📷 Gambar"
        : media.mediaType === "video"
          ? "🎥 Video"
          : media.mediaType === "audio"
            ? "🎤 Audio"
            : media.mediaType === "document"
              ? `📄 ${media.mediaFilename ?? "Dokumen"}`
              : media.mediaType === "contact"
                ? `👤 ${media.mediaFilename ?? "Kontak"}`
                : "Media"
      : "";

  await db.insert(chatMessagesTable).values({
    chatId: chat.id,
    direction: "inbound",
    content: messageText,
    isAiGenerated: false,
    mediaType: media?.mediaType ?? null,
    mediaUrl: media?.mediaUrl ?? null,
    mediaMimeType: media?.mediaMimeType ?? null,
    mediaFilename: media?.mediaFilename ?? null,
  });

  await db
    .update(chatsTable)
    .set({
      lastMessage: preview,
      lastMessageAt: new Date(),
      unreadCount: (chat.unreadCount ?? 0) + 1,
    })
    .where(eq(chatsTable.id, chat.id));

  if (chat.isHumanTakeover) return;
  // Don't auto-reply to pure media messages without text
  if (!messageText.trim()) return;

  const settingsRows = await db.select().from(settingsTable).limit(1);
  const settings = settingsRows[0];
  if (!settings?.autoReplyEnabled) return;

  const delayMin = (settings.replyDelayMin ?? 1) * 1000;
  const delayMax = (settings.replyDelayMax ?? 3) * 1000;
  const delay = Math.random() * (delayMax - delayMin) + delayMin;

  setTimeout(async () => {
    try {
      const aiReply = await generateAiReply(chat.id, messageText);
      const replyText = aiReply ?? settings.fallbackMessage;

      if (sock && replyText) {
        await sock.sendMessage(jid, { text: replyText });

        await db.insert(chatMessagesTable).values({
          chatId: chat.id,
          direction: "outbound",
          content: replyText,
          isAiGenerated: !!aiReply,
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
    } catch {
    }
  }, delay);
}

async function startBaileys(sessionId: number) {
  if (isConnecting || (sock && (sock as any).ws?.readyState === 1)) return;
  isConnecting = true;

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
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const dataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 1 });
        await setStatus(sessionId, "qr_ready", { qrCode: dataUrl });
      }

      if (connection === "open") {
        const phoneNumber = sock?.user?.id?.split(":")[0] ?? null;
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
        if (shouldReconnect) {
          setTimeout(() => startBaileys(sessionId), 3000);
        }
      }
    });

    const { downloadMediaMessage } = await import("@whiskeysockets/baileys");

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      logger.info(
        { type, count: messages.length, jids: messages.map((m) => m.key.remoteJid) },
        "messages.upsert received"
      );
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        try {
          if (!msg.message) {
            logger.info({ key: msg.key }, "skip: no message body");
            continue;
          }
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;

          // Skip groups, broadcasts, status & newsletter JIDs. Accept both
          // standard phone JIDs (@s.whatsapp.net) and LID JIDs (@lid) which
          // WhatsApp uses for privacy on direct messages.
          if (isJidGroup(jid)) continue;
          if (
            jid.endsWith("@broadcast") ||
            jid.endsWith("@newsletter") ||
            jid === "status@broadcast"
          ) {
            logger.info({ jid }, "skip: broadcast/status/newsletter");
            continue;
          }
          if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) {
            logger.info({ jid }, "skip: unsupported jid type");
            continue;
          }

          // Recursively unwrap ephemeral / viewOnce wrappers
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

          const messageContent =
            inner.conversation ||
            inner.extendedTextMessage?.text ||
            inner.imageMessage?.caption ||
            inner.videoMessage?.caption ||
            inner.documentMessage?.caption ||
            inner.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            "";

          // Detect media
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
              logger.error({ err }, "Failed to download incoming media");
            }
          } else if (inner.contactMessage || inner.contactsArrayMessage) {
            // Contact card — store the vCard text in mediaUrl as a data: URI is overkill; just keep displayName
            const contact = inner.contactMessage ?? inner.contactsArrayMessage?.contacts?.[0];
            const displayName = contact?.displayName ?? "Kontak";
            media = {
              mediaType: "contact",
              mediaUrl: null,
              mediaMimeType: "text/vcard",
              mediaFilename: displayName,
            };
          }

          if (!messageContent.trim() && !media) continue;

          // Extract clean phone number — strip @domain and :device suffix
          const rawNumber = jid.split("@")[0].split(":")[0];
          const pushName = msg.pushName || rawNumber;
          await handleIncomingMessage(jid, messageContent, pushName, rawNumber, media);
        } catch (err) {
          logger.error({ err }, "Failed to process incoming message");
        }
      }
    });
  } catch (err) {
    isConnecting = false;
    await setStatus(sessionId, "disconnected");
    throw err;
  }
}

export async function initWhatsapp() {
  try {
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
    if (sock) {
      await sock.logout().catch(() => {});
      sock = null;
    }
    isConnecting = false;
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
