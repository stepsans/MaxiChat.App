import { Router } from "express";
import { db } from "@workspace/db";
import { whatsappSessionTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

async function getOrCreateSession() {
  const sessions = await db.select().from(whatsappSessionTable).limit(1);
  if (sessions.length > 0) return sessions[0];
  const [created] = await db
    .insert(whatsappSessionTable)
    .values({ status: "disconnected" })
    .returning();
  return created;
}

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
    // Simulate QR code generation (real integration would use Baileys)
    const mockQrData = `https://wa.me/qr/${Date.now()}`;
    const [updated] = await db
      .update(whatsappSessionTable)
      .set({ status: "qr_ready", qrCode: mockQrData, updatedAt: new Date() })
      .where(eq(whatsappSessionTable.id, session.id))
      .returning();
    res.json({
      status: updated.status,
      qrCode: updated.qrCode ?? null,
      phoneNumber: updated.phoneNumber ?? null,
      connectedAt: updated.connectedAt?.toISOString() ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to connect WhatsApp");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/disconnect", async (req, res) => {
  try {
    const session = await getOrCreateSession();
    const [updated] = await db
      .update(whatsappSessionTable)
      .set({ status: "disconnected", qrCode: null, phoneNumber: null, connectedAt: null, updatedAt: new Date() })
      .where(eq(whatsappSessionTable.id, session.id))
      .returning();
    res.json({
      status: updated.status,
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
