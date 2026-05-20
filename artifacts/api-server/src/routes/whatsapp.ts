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

interface ParsedWaMessage {
  jid: string;
  rawNumber: string;
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
  downloadMedia: boolean
): Promise<ParsedWaMessage | null> {
  if (!msg?.message) return null;
  const jid: string | undefined = msg.key?.remoteJid;
  if (!jid) return null;

  // Skip groups, broadcasts, status, newsletters
  if (isJidGroup(jid)) return null;
  if (
    jid.endsWith("@broadcast") ||
    jid.endsWith("@newsletter") ||
    jid === "status@broadcast"
  ) {
    return null;
  }
  if (!jid.endsWith("@s.whatsapp.net") && !jid.endsWith("@lid")) return null;

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

  const rawNumber = jid.split("@")[0].split(":")[0];
  const pushName: string = msg.pushName || rawNumber;
  const waMessageId: string | null = msg.key?.id ?? null;
  const fromMe = !!msg.key?.fromMe;
  const timestamp = new Date(toEpochMs(msg.messageTimestamp));

  return { jid, rawNumber, pushName, waMessageId, fromMe, timestamp, messageContent, media };
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
  parsed: ParsedWaMessage,
  opts: { incrementUnread: boolean }
): Promise<{ chat: typeof chatsTable.$inferSelect; inserted: boolean }> {
  const phoneNumber = `+${parsed.rawNumber}`;
  const contactName = parsed.pushName || parsed.rawNumber;
  const chat = await getOrCreateChat(phoneNumber, contactName);
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
  chat: typeof chatsTable.$inferSelect,
  jid: string,
  messageText: string
) {
  if (chat.isHumanTakeover) return;
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
        const sent = await sock.sendMessage(jid, { text: replyText });

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
          .where(eq(chatsTable.id, chat.id));
      }
    } catch (err) {
      logger.error({ err }, "Auto-reply failed");
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

    // Live messages — full processing including media download + AI auto-reply
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      logger.info(
        { type, count: messages.length, jids: messages.map((m) => m.key.remoteJid) },
        "messages.upsert received"
      );
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        try {
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            true
          );
          if (!parsed) continue;

          const { chat, inserted } = await persistWaMessage(parsed, {
            incrementUnread: true,
          });
          if (!inserted) continue;
          if (parsed.fromMe) continue;

          await maybeTriggerAutoReply(chat, parsed.jid, parsed.messageContent);
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
          if ((isJidGroup as (j: string) => boolean)(c.id)) continue;
          if (
            c.id.endsWith("@broadcast") ||
            c.id.endsWith("@newsletter") ||
            c.id === "status@broadcast"
          )
            continue;
          if (!c.id.endsWith("@s.whatsapp.net") && !c.id.endsWith("@lid")) continue;
          const rawNumber = c.id.split("@")[0].split(":")[0];
          const phoneNumber = `+${rawNumber}`;
          const contactName = c.name?.trim() || rawNumber;
          await getOrCreateChat(phoneNumber, contactName);
        } catch (err) {
          logger.error({ err, chatId: c?.id }, "Failed to seed history chat");
        }
      }

      let ingested = 0;
      for (const msg of messages) {
        try {
          const parsed = await parseWaMessage(
            msg,
            isJidGroup as (j: string) => boolean,
            downloadMediaMessage,
            false
          );
          if (!parsed) continue;
          const { inserted } = await persistWaMessage(parsed, { incrementUnread: false });
          if (inserted) ingested++;
        } catch (err) {
          logger.error({ err }, "Failed to ingest history message");
        }
      }
      logger.info({ ingested }, "messaging-history.set done");
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
    // Wipe local auth credentials so the next /connect starts a fresh
    // pairing flow (QR code). Without this, useMultiFileAuthState reads the
    // now-invalidated creds.json and WhatsApp immediately rejects with
    // DisconnectReason.loggedOut — so no QR is ever generated.
    await fs.rm(AUTH_DIR, { recursive: true, force: true }).catch((err) => {
      req.log.warn({ err }, "Failed to wipe WhatsApp auth dir");
    });
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
