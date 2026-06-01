import { Router } from "express";
import { CreateGroupBody } from "@workspace/api-zod";
import { getPrimaryChannelForUser, getOrCreateChat } from "./whatsapp";

const router = Router();

function phoneToJid(phone: string): string {
  return `${String(phone).replace(/[^0-9]/g, "")}@s.whatsapp.net`;
}

// POST /groups — create a brand-new WhatsApp group on the owner's primary
// channel. This creates a REAL group on the connected account. The resulting
// group is persisted as a local chat so it shows up in the chat list.
router.post("/", async (req, res): Promise<void> => {
  try {
    const parsed = CreateGroupBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }

    const primary = await getPrimaryChannelForUser(req.session.userId!);
    if (!primary?.sock) { res.status(409).json({ error: "WhatsApp not connected" }); return; }

    const jids = parsed.data.phones
      .map((p) => p.replace(/[^0-9]/g, ""))
      .filter(Boolean)
      .map(phoneToJid);
    if (jids.length === 0) { res.status(400).json({ error: "No valid phone numbers" }); return; }

    const meta = await primary.sock.groupCreate(parsed.data.subject, jids);
    const chat = await getOrCreateChat(
      primary.channelId,
      req.session.userId!,
      meta.id,
      meta.subject ?? parsed.data.subject
    );
    res.json({
      chatId: chat?.id ?? null,
      groupJid: meta.id,
      subject: meta.subject ?? parsed.data.subject,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create group");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
