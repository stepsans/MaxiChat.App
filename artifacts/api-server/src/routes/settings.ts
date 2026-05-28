import { Router } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { requirePermission } from "../lib/role-permissions";
import {
  requireOwnedChannelLoose,
  requireConnectedChannel,
  type ChannelRow,
} from "../lib/channel-context";

const router = Router();

// Settings read is open to anyone signed in (the page shows current AI
// behavior even to agents); writes go through the matrix.
router.put("/", requirePermission("settings", "edit"));

const DEFAULT_SYSTEM_PROMPT = `Kamu adalah customer service profesional yang ramah, cepat, dan membantu closing.

Gunakan gaya bahasa:
- Santai tapi sopan
- Gunakan emoji secukupnya
- Jawaban singkat, jelas, dan tidak bertele-tele
- Maksimal 2-4 kalimat

Tugas kamu:
- Jawab pertanyaan dengan jelas berdasarkan knowledge base
- Jika memungkinkan, arahkan ke pembelian
- Gunakan bahasa natural seperti manusia
- Jangan jawab di luar knowledge
- Jika tidak tahu, sampaikan dengan sopan bahwa admin akan membantu`;

const DEFAULT_FALLBACK =
  "Aku bantu cek dulu ya kak, nanti admin kami bantu jawab lebih detail 🙏";

// Per-channel settings. Filter by channel_id (the source of truth post-T002);
// owner_phone is still populated on insert as a transitional column required
// by the legacy NOT NULL + unique-index, but reads never depend on it.
export async function getOrCreateSettings(channel: ChannelRow) {
  const rows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.channelId, channel.id))
    .limit(1);
  if (rows.length > 0) return rows[0];

  // Only callable for connected channels (ownerPhone is guaranteed by the
  // requireConnectedChannel gate in the writer route below). The reader
  // route also passes a connected channel; an unpaired channel never
  // reaches this function.
  if (!channel.ownerPhone) {
    throw new Error("getOrCreateSettings called with unpaired channel");
  }

  const [created] = await db
    .insert(settingsTable)
    .values({
      ownerPhone: channel.ownerPhone,
      channelId: channel.id,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      autoReplyEnabled: true,
      replyDelayMin: 1,
      replyDelayMax: 3,
      fallbackMessage: DEFAULT_FALLBACK,
      flowCooldownMinutes: 5,
    })
    .onConflictDoNothing({ target: settingsTable.ownerPhone })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.channelId, channel.id))
    .limit(1);
  return existing;
}

function serializeSettings(s: typeof settingsTable.$inferSelect) {
  return {
    ...s,
    updatedAt: s.updatedAt.toISOString(),
  };
}

// When no WhatsApp account is connected, we still respond with a sensible
// read-only default so the Settings UI doesn't error out — but we don't
// persist anything and PUT is blocked with 503.
function defaultSettingsResponse() {
  const now = new Date();
  return {
    id: 0,
    ownerPhone: "",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    autoReplyEnabled: true,
    replyDelayMin: 1,
    replyDelayMax: 3,
    fallbackMessage: DEFAULT_FALLBACK,
    flowCooldownMinutes: 5,
    updatedAt: now.toISOString(),
  };
}

router.get("/", async (req, res): Promise<void> => {
  try {
    // GET is reachable pre-pairing so the UI can render defaults; we just
    // require a single channel selected (not "all").
    const channel = await requireOwnedChannelLoose(req, res);
    if (!channel) return;
    if (!channel.ownerPhone) {
      res.json(defaultSettingsResponse());
      return;
    }
    const settings = await getOrCreateSettings(channel);
    res.json(serializeSettings(settings));
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/", async (req, res): Promise<void> => {
  try {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }

    const channel = await requireConnectedChannel(req, res);
    if (!channel) return;

    const current = await getOrCreateSettings(channel);
    const [updated] = await db
      .update(settingsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(settingsTable.id, current.id), eq(settingsTable.channelId, channel.id)))
      .returning();

    res.json(serializeSettings(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
