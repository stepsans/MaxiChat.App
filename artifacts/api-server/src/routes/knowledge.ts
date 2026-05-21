import { Router } from "express";
import { db } from "@workspace/db";
import { knowledgeTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateKnowledgeBody,
  UpdateKnowledgeBody,
  UpdateKnowledgeParams,
  DeleteKnowledgeParams,
} from "@workspace/api-zod";
import { normalizeSheetUrlToCsv, parseCsv, fetchSheetCsv } from "../lib/sheet-sync";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const entries = await db.select().from(knowledgeTable).orderBy(knowledgeTable.createdAt);
    res.json(
      entries.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list knowledge");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateKnowledgeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const [entry] = await db
      .insert(knowledgeTable)
      .values(parsed.data)
      .returning();

    res.status(201).json({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const idParsed = UpdateKnowledgeParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = UpdateKnowledgeBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const [updated] = await db
      .update(knowledgeTable)
      .set({ ...bodyParsed.data, updatedAt: new Date() })
      .where(eq(knowledgeTable.id, idParsed.data.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Entry not found" });

    res.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const idParsed = DeleteKnowledgeParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const deleted = await db
      .delete(knowledgeTable)
      .where(eq(knowledgeTable.id, idParsed.data.id))
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Entry not found" });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Google Sheet sync ---

const VALID_TYPES = new Set(["product", "faq", "script", "testimonial", "website"]);

// Simple in-process single-flight lock to prevent concurrent syncs racing on
// delete+insert (which would otherwise produce duplicate or partial rows).
let syncInFlight = false;

router.post("/sync-google-sheet", async (req, res) => {
  if (syncInFlight) {
    return res
      .status(409)
      .json({ success: false, count: 0, error: "Sync sedang berjalan, tunggu sebentar." });
  }
  syncInFlight = true;
  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    const sheetUrl = settings?.googleSheetCsvUrl?.trim();
    if (!sheetUrl) {
      return res
        .status(400)
        .json({ success: false, count: 0, error: "Google Sheet URL belum diatur di Settings" });
    }

    const csvUrl = normalizeSheetUrlToCsv(sheetUrl);
    if (!csvUrl) {
      const errMsg = "Format URL Google Sheet tidak dikenali";
      if (settings) {
        await db
          .update(settingsTable)
          .set({
            googleSheetLastSyncAt: new Date(),
            googleSheetLastSyncError: errMsg,
            googleSheetLastSyncCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(settingsTable.id, settings.id));
      }
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    let csvText: string;
    try {
      csvText = await fetchSheetCsv(csvUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gagal mengambil sheet";
      await db
        .update(settingsTable)
        .set({
          googleSheetLastSyncAt: new Date(),
          googleSheetLastSyncError: msg,
          googleSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings!.id));
      return res.status(400).json({ success: false, count: 0, error: msg });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      const errMsg = "Sheet kosong atau tidak punya data (selain header)";
      await db
        .update(settingsTable)
        .set({
          googleSheetLastSyncAt: new Date(),
          googleSheetLastSyncError: errMsg,
          googleSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings!.id));
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    // Skip header row
    const dataRows = rows.slice(1);
    const entries: { type: string; title: string; content: string; source: string }[] = [];
    for (const r of dataRows) {
      const rawType = (r[0] ?? "").trim().toLowerCase();
      const title = (r[1] ?? "").trim();
      const content = (r[2] ?? "").trim();
      if (!title || !content) continue;
      const type = VALID_TYPES.has(rawType) ? rawType : "faq";
      entries.push({ type, title, content, source: "google_sheet" });
    }

    if (entries.length === 0) {
      const errMsg =
        "Tidak ada baris valid. Format kolom: A=type, B=title, C=content (baris 1 = header)";
      await db
        .update(settingsTable)
        .set({
          googleSheetLastSyncAt: new Date(),
          googleSheetLastSyncError: errMsg,
          googleSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings!.id));
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    // Replace all prior sheet-synced entries, keep manual entries untouched
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.source, "google_sheet"));
      await tx.insert(knowledgeTable).values(entries);
    });

    await db
      .update(settingsTable)
      .set({
        googleSheetLastSyncAt: new Date(),
        googleSheetLastSyncError: null,
        googleSheetLastSyncCount: entries.length,
        updatedAt: new Date(),
      })
      .where(eq(settingsTable.id, settings!.id));

    res.json({ success: true, count: entries.length });
  } catch (err) {
    req.log.error({ err }, "Failed to sync google sheet");
    res.status(500).json({ success: false, count: 0, error: "Internal server error" });
  } finally {
    syncInFlight = false;
  }
});

export default router;
