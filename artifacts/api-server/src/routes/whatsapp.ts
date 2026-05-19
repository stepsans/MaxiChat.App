import { Router } from "express";
import type makeWASocketType from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import path from "path";
import { db } from "@workspace/db";
import { whatsappSessionTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

async function startBaileys(sessionId: number) {
  if (isConnecting || (sock && (sock as any).ws?.readyState === 1)) return;
  isConnecting = true;

  try {
    const {
      useMultiFileAuthState,
      makeWASocket,
      DisconnectReason,
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
        await setStatus(sessionId, "disconnected", { qrCode: null, phoneNumber: null, connectedAt: null });
        sock = null;
        isConnecting = false;
        if (shouldReconnect) {
          setTimeout(() => startBaileys(sessionId), 3000);
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
