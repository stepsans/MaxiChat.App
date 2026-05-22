import { Router } from "express";
import { db, textShortcutsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import { getCurrentOwnerPhone } from "./whatsapp";

const router = Router();

function rowToDto(r: typeof textShortcutsTable.$inferSelect) {
  return { id: r.id, shortcut: r.shortcut, replacement: r.replacement };
}

router.get("/", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.json([]);
      return;
    }
    const rows = await db
      .select()
      .from(textShortcutsTable)
      .where(sql`${textShortcutsTable.ownerPhone} = ${ownerPhone}`)
      .orderBy(desc(textShortcutsTable.updatedAt));
    res.json(rows.map(rowToDto));
  } catch (err) {
    req.log.error({ err }, "Failed to list shortcuts");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const shortcut = String(req.body?.shortcut ?? "").trim();
    const replacement = String(req.body?.replacement ?? "").trimEnd();
    if (!shortcut || shortcut.length > 64) {
      res.status(400).json({ error: "Shortcut must be 1-64 characters" });
      return;
    }
    if (!replacement || replacement.length > 4000) {
      res.status(400).json({ error: "Replacement must be 1-4000 characters" });
      return;
    }
    try {
      const [row] = await db
        .insert(textShortcutsTable)
        .values({ ownerPhone, shortcut, replacement })
        .returning();
      res.json(rowToDto(row));
    } catch (err: any) {
      // 23505 = unique violation (per-owner, lower(shortcut)).
      if (err?.code === "23505") {
        res.status(409).json({ error: "Shortcut sudah ada" });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const shortcut = String(req.body?.shortcut ?? "").trim();
    const replacement = String(req.body?.replacement ?? "").trimEnd();
    if (!shortcut || shortcut.length > 64 || !replacement || replacement.length > 4000) {
      res.status(400).json({ error: "Invalid shortcut or replacement" });
      return;
    }
    try {
      const [row] = await db
        .update(textShortcutsTable)
        .set({ shortcut, replacement, updatedAt: new Date() })
        .where(
          sql`${textShortcutsTable.id} = ${id} AND ${textShortcutsTable.ownerPhone} = ${ownerPhone}`
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: "Shortcut not found" });
        return;
      }
      res.json(rowToDto(row));
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "Shortcut sudah ada" });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .delete(textShortcutsTable)
      .where(
        sql`${textShortcutsTable.id} = ${id} AND ${textShortcutsTable.ownerPhone} = ${ownerPhone}`
      );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
