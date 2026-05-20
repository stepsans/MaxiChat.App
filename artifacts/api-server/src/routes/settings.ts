import { Router } from "express";
import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";

const router = Router();

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

async function getOrCreateSettings() {
  const rows = await db.select().from(settingsTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db
    .insert(settingsTable)
    .values({
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      autoReplyEnabled: true,
      replyDelayMin: 1,
      replyDelayMax: 3,
      fallbackMessage: "Aku bantu cek dulu ya kak, nanti admin kami bantu jawab lebih detail 🙏",
    })
    .returning();
  return created;
}

function serializeSettings(s: typeof settingsTable.$inferSelect) {
  return {
    ...s,
    updatedAt: s.updatedAt.toISOString(),
    googleSheetLastSyncAt: s.googleSheetLastSyncAt ? s.googleSheetLastSyncAt.toISOString() : null,
  };
}

router.get("/", async (req, res) => {
  try {
    const settings = await getOrCreateSettings();
    res.json(serializeSettings(settings));
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/", async (req, res) => {
  try {
    const parsed = UpdateSettingsBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const current = await getOrCreateSettings();
    const [updated] = await db
      .update(settingsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(settingsTable.id, current.id))
      .returning();

    res.json(serializeSettings(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
