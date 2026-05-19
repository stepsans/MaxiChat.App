import { Router } from "express";
import type makeWASocketType from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import path from "path";
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

const AUTH_DIR = path.join(process.cwd(), ".whatsapp-auth");

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

async function handleIncomingMessage(
  jid: string,
  messageText: string,
  pushName: string
) {
  const phoneNumber = jid.split("@")[0];
  const contactName = pushName || phoneNumber;

  const chat = await getOrCreateChat(`+${phoneNumber}`, contactName);

  await db.insert(chatMessagesTable).values({
    chatId: chat.id,
    direction: "inbound",
    content: messageText,
    isAiGenerated: false,
  });

  await db
    .update(chatsTable)
    .set({
      lastMessage: messageText,
      lastMessageAt: new Date(),
      unreadCount: (chat.unreadCount ?? 0) + 1,
    })
    .where(eq(chatsTable.id, chat.id));

  if (chat.isHumanTakeover) return;

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
      logger: (await import("pino")).default({ level: "silent" }),
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

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          if (msg.key.fromMe) continue;

          const jid = msg.key.remoteJid;
          if (!jid) continue;
          if (isJidGroup(jid)) continue;

          const messageContent =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            "";

          if (!messageContent.trim()) continue;

          const pushName = msg.pushName || jid.split("@")[0];
          await handleIncomingMessage(jid, messageContent, pushName);
        } catch {
        }
      }
    });
  } catch (err) {
    isConnecting = false;
    await setStatus(sessionId, "disconnected");
    throw err;
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
