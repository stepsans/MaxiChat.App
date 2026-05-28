import { Router } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { getCurrentOwnerPhone } from "./whatsapp";
import { requirePermission } from "../lib/role-permissions";

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

// Per-owner settings: each WhatsApp account gets its own AI persona
// (system prompt), auto-reply flag, delay range, and fallback message.
// On the first call for a brand-new owner we lazily insert a row with the
// shared defaults so the operator immediately has a working AI persona.
export async function getOrCreateSettings(ownerPhone: string) {
  const rows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.ownerPhone, ownerPhone))
    .limit(1);
  if (rows.length > 0) return rows[0];

  // ON CONFLICT guards against the (rare) race where two requests arrive
  // for the same brand-new owner at the same time — composite unique index
  // on owner_phone makes the second insert a no-op and we fall back to a
  // re-read.
  const [created] = await db
    .insert(settingsTable)
    .values({
      ownerPhone,
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
    .where(eq(settingsTable.ownerPhone, ownerPhone))
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
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.json(defaultSettingsResponse());
      return;
    }
    const settings = await getOrCreateSettings(ownerPhone);
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

    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menyimpan pengaturan." });
      return;
    }

    const current = await getOrCreateSettings(ownerPhone);
    const [updated] = await db
      .update(settingsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(settingsTable.id, current.id), eq(settingsTable.ownerPhone, ownerPhone)))
      .returning();

    res.json(serializeSettings(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
