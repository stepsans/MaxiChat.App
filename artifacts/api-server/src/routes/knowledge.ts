import { Router } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { knowledgeTable, knowledgeTypesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ensureKnowledgeTypesSeed } from "./knowledge-types";
import { getCurrentOwnerPhone } from "./whatsapp";
import {
  CreateKnowledgeBody,
  UpdateKnowledgeBody,
  UpdateKnowledgeParams,
  DeleteKnowledgeParams,
} from "@workspace/api-zod";
import { parseCsv } from "../lib/sheet-sync";
import ExcelJS from "exceljs";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const EXPORT_COLUMNS = ["id", "type", "title", "content", "createdAt", "updatedAt"] as const;

async function loadValidTypes(ownerPhone: string): Promise<Set<string>> {
  await ensureKnowledgeTypesSeed(ownerPhone);
  const rows = await db
    .select({ value: knowledgeTypesTable.value })
    .from(knowledgeTypesTable)
    .where(eq(knowledgeTypesTable.ownerPhone, ownerPhone));
  return new Set(rows.map((r) => r.value));
}

function makeLabelFromValue(v: string): string {
  return v
    .split(/[-_]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

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
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengekspor knowledge." });
    }
    const entries = await db
      .select()
      .from(knowledgeTable)
      .where(eq(knowledgeTable.ownerPhone, ownerPhone))
      .orderBy(knowledgeTable.id);
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
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengekspor knowledge." });
    }
    const entries = await db
      .select()
      .from(knowledgeTable)
      .where(eq(knowledgeTable.ownerPhone, ownerPhone))
      .orderBy(knowledgeTable.id);
    const wb = new ExcelJS.Workbook();
    wb.creator = "VJ-Chat";
    wb.created = new Date();
    const ws = wb.addWorksheet("Knowledge Base");
    ws.columns = [
      { header: "id", key: "id", width: 6 },
      { header: "type", key: "type", width: 14 },
      { header: "title", key: "title", width: 36 },
      { header: "content", key: "content", width: 80 },
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
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) return res.json([]);
    const entries = await db
      .select()
      .from(knowledgeTable)
      .where(eq(knowledgeTable.ownerPhone, ownerPhone))
      .orderBy(knowledgeTable.createdAt);
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

    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menambah knowledge." });
    }

    const [entry] = await db
      .insert(knowledgeTable)
      .values({ ...parsed.data, ownerPhone })
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

    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengubah knowledge." });
    }

    const [updated] = await db
      .update(knowledgeTable)
      .set({ ...bodyParsed.data, updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeTable.id, idParsed.data.id),
          eq(knowledgeTable.ownerPhone, ownerPhone)
        )
      )
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

    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menghapus knowledge." });
    }

    const deleted = await db
      .delete(knowledgeTable)
      .where(
        and(
          eq(knowledgeTable.id, idParsed.data.id),
          eq(knowledgeTable.ownerPhone, ownerPhone)
        )
      )
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Entry not found" });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Import from CSV / XLSX (replaces all entries) ---

interface ParsedEntry {
  type: string;
  title: string;
  content: string;
}

function normalizeHeader(s: string): string {
  return s.trim().toLowerCase();
}

const VALUE_REGEX = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function rowsToEntries(rows: string[][]): { entries: ParsedEntry[]; error: string | null } {
  if (rows.length === 0) {
    return { entries: [], error: "File kosong" };
  }
  const headers = rows[0].map(normalizeHeader);
  const typeIdx = headers.indexOf("type");
  const titleIdx = headers.indexOf("title");
  const contentIdx = headers.indexOf("content");
  if (typeIdx === -1 || titleIdx === -1 || contentIdx === -1) {
    return {
      entries: [],
      error: "Header wajib: type, title, content (baris pertama).",
    };
  }
  const entries: ParsedEntry[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rawType = (r[typeIdx] ?? "").trim().toLowerCase();
    const title = (r[titleIdx] ?? "").trim();
    const content = (r[contentIdx] ?? "").trim();
    if (!title && !content) continue;
    if (!title || !content) continue;
    const type = VALUE_REGEX.test(rawType) ? rawType : "faq";
    entries.push({ type, title, content });
  }
  if (entries.length === 0) {
    return { entries: [], error: "Tidak ada baris valid di file." };
  }
  return { entries, error: null };
}

async function parseXlsxBuffer(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const out: string[] = [];
    const values = row.values as unknown[];
    // ExcelJS row.values is 1-indexed; skip index 0
    for (let i = 1; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined) {
        out.push("");
      } else if (typeof v === "object" && v !== null && "text" in (v as object)) {
        out.push(String((v as { text: unknown }).text ?? ""));
      } else if (v instanceof Date) {
        out.push(v.toISOString());
      } else {
        out.push(String(v));
      }
    }
    rows.push(out);
  });
  return rows;
}

let importInFlight = false;

router.post("/import", upload.single("file"), async (req, res) => {
  if (importInFlight) {
    return res
      .status(409)
      .json({ error: "Import sedang berjalan, tunggu sebentar." });
  }
  importInFlight = true;
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengimpor knowledge." });
    }

    const file = req.file;
    if (!file) return res.status(400).json({ error: "File tidak ditemukan di field 'file'" });

    const name = (file.originalname ?? "").toLowerCase();
    const mime = (file.mimetype ?? "").toLowerCase();
    const isXlsx =
      name.endsWith(".xlsx") ||
      mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const isCsv =
      name.endsWith(".csv") ||
      mime === "text/csv" ||
      mime === "application/csv" ||
      mime === "text/plain";

    let rows: string[][];
    try {
      if (isXlsx) {
        rows = await parseXlsxBuffer(file.buffer);
      } else if (isCsv) {
        // Strip UTF-8 BOM if present
        let text = file.buffer.toString("utf8");
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        rows = parseCsv(text);
      } else {
        return res.status(400).json({
          error: "Format file tidak didukung. Gunakan .csv atau .xlsx",
        });
      }
    } catch (e) {
      req.log.error({ err: e }, "Failed to parse import file");
      return res.status(400).json({ error: "Gagal membaca isi file." });
    }

    const { entries, error } = rowsToEntries(rows);
    if (error) return res.status(400).json({ error });

    const validTypes = await loadValidTypes(ownerPhone);
    const newTypes = new Set<string>();
    for (const e of entries) {
      if (!validTypes.has(e.type)) newTypes.add(e.type);
    }

    // Import is owner-scoped: wipe & replace ONLY this account's entries,
    // and seed any missing types under this owner. Other accounts'
    // knowledge bases are untouched.
    await db.transaction(async (tx) => {
      if (newTypes.size > 0) {
        await tx
          .insert(knowledgeTypesTable)
          .values(
            Array.from(newTypes).map((v) => ({
              ownerPhone,
              value: v,
              label: makeLabelFromValue(v),
            })),
          )
          .onConflictDoNothing();
      }
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.ownerPhone, ownerPhone));
      await tx
        .insert(knowledgeTable)
        .values(entries.map((e) => ({ ...e, ownerPhone })));
    });

    res.json({ imported: entries.length });
  } catch (err) {
    req.log.error({ err }, "Failed to import knowledge");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    importInFlight = false;
  }
});

export default router;
