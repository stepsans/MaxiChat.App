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
import ExcelJS from "exceljs";

const router = Router();

const EXPORT_COLUMNS = ["id", "type", "title", "content", "source", "createdAt", "updatedAt"] as const;

function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? neutralizeFormula(value) : String(value);
  if (/[",\r\n]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

function safeCell(value: unknown): unknown {
  if (typeof value === "string") return neutralizeFormula(value);
  return value;
}

function exportFilename(ext: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `knowledge-base-${stamp}.${ext}`;
}

router.get("/export.csv", async (req, res) => {
  try {
    const entries = await db.select().from(knowledgeTable).orderBy(knowledgeTable.id);
    const lines: string[] = [EXPORT_COLUMNS.join(",")];
    for (const e of entries) {
      const row: Record<string, unknown> = {
        ...e,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      };
      lines.push(EXPORT_COLUMNS.map((c) => csvEscape(row[c])).join(","));
    }
    const body = "\uFEFF" + lines.join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename("csv")}"`);
    res.send(body);
  } catch (err) {
    req.log.error({ err }, "Failed to export knowledge as CSV");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/export.xlsx", async (req, res) => {
  try {
    const entries = await db.select().from(knowledgeTable).orderBy(knowledgeTable.id);
    const wb = new ExcelJS.Workbook();
    wb.creator = "Maxipro Assistant";
    wb.created = new Date();
    const ws = wb.addWorksheet("Knowledge Base");
    ws.columns = [
      { header: "id", key: "id", width: 6 },
      { header: "type", key: "type", width: 14 },
      { header: "title", key: "title", width: 36 },
      { header: "content", key: "content", width: 80 },
      { header: "source", key: "source", width: 14 },
      { header: "createdAt", key: "createdAt", width: 22 },
      { header: "updatedAt", key: "updatedAt", width: 22 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const e of entries) {
      ws.addRow({
        id: e.id,
        type: safeCell(e.type),
        title: safeCell(e.title),
        content: safeCell(e.content),
        source: safeCell(e.source),
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      });
    }
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.alignment = { vertical: "top", wrapText: true };
    });
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${exportFilename("xlsx")}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    req.log.error({ err }, "Failed to export knowledge as XLSX");
    res.status(500).json({ error: "Internal server error" });
  }
});

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

router.delete("/manual", async (req, res) => {
  try {
    const deleted = await db
      .delete(knowledgeTable)
      .where(eq(knowledgeTable.source, "manual"))
      .returning();
    res.json({ deleted: deleted.length });
  } catch (err) {
    req.log.error({ err }, "Failed to delete manual knowledge entries");
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
