import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db } from "@workspace/db";
import { productsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateProductBody,
  UpdateProductBody,
  UpdateProductParams,
  DeleteProductParams,
} from "@workspace/api-zod";
import { MEDIA_DIR } from "./whatsapp";
import { normalizeSheetUrlToCsv, parseCsv, fetchSheetCsv } from "../lib/sheet-sync";

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(MEDIA_DIR, { recursive: true });
      } catch {}
      cb(null, MEDIA_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = mime.extension(file.mimetype || "");
      cb(null, `${randomUUID()}${ext ? "." + ext : ""}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
  limits: { fileSize: 16 * 1024 * 1024 },
});

function serialize(p: typeof productsTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(productsTable).orderBy(productsTable.createdAt);
    res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "Failed to list products");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateProductBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    if (!Number.isInteger(parsed.data.price)) {
      return res.status(400).json({ error: "Harga harus berupa bilangan bulat" });
    }

    try {
      const [created] = await db
        .insert(productsTable)
        .values({
          code: parsed.data.code.trim(),
          name: parsed.data.name.trim(),
          price: parsed.data.price,
          imageUrl: parsed.data.imageUrl ?? null,
          productUrl: parsed.data.productUrl ?? null,
          description: parsed.data.description ?? null,
        })
        .returning();
      res.status(201).json(serialize(created));
    } catch (e: any) {
      if (e?.code === "23505") {
        return res.status(409).json({ error: "Kode produk sudah dipakai" });
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create product");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const idP = UpdateProductParams.safeParse({ id: Number(req.params.id) });
    if (!idP.success) return res.status(400).json({ error: "Invalid id" });

    const bodyP = UpdateProductBody.safeParse(req.body);
    if (!bodyP.success) return res.status(400).json({ error: "Invalid body" });
    if (!Number.isInteger(bodyP.data.price)) {
      return res.status(400).json({ error: "Harga harus berupa bilangan bulat" });
    }

    try {
      const [updated] = await db
        .update(productsTable)
        .set({
          code: bodyP.data.code.trim(),
          name: bodyP.data.name.trim(),
          price: bodyP.data.price,
          imageUrl: bodyP.data.imageUrl ?? null,
          productUrl: bodyP.data.productUrl ?? null,
          description: bodyP.data.description ?? null,
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, idP.data.id))
        .returning();

      if (!updated) return res.status(404).json({ error: "Product not found" });
      res.json(serialize(updated));
    } catch (e: any) {
      if (e?.code === "23505") {
        return res.status(409).json({ error: "Kode produk sudah dipakai" });
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update product");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const idP = DeleteProductParams.safeParse({ id: Number(req.params.id) });
    if (!idP.success) return res.status(400).json({ error: "Invalid id" });

    const deleted = await db
      .delete(productsTable)
      .where(eq(productsTable.id, idP.data.id))
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete product");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Google Sheet sync for product catalog ---
//
// Expected columns (header row required, header text is ignored — order is what matters):
//   A = kode barang     (code, required, unique)
//   B = nama produk     (name, optional → falls back to code)
//   C = harga           (price, required, integer Rupiah — non-numeric chars stripped)
//   D = foto produk     (imageUrl, optional, must be http/https)
//   E = link website    (productUrl, optional, must be http/https)
//
// Sync replaces all rows where source='google_sheet'; manual entries are kept.

let productSyncInFlight = false;

function parsePriceCell(raw: string): number | null {
  if (!raw) return null;
  // Strip everything except digits ("Rp 1.250.000" / "1,250,000" / "1250000")
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

function isValidHttpUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

router.post("/sync-google-sheet", async (req, res) => {
  if (productSyncInFlight) {
    return res
      .status(409)
      .json({ success: false, count: 0, error: "Sync sedang berjalan, tunggu sebentar." });
  }
  productSyncInFlight = true;
  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    const sheetUrl = settings?.productSheetCsvUrl?.trim();
    if (!sheetUrl) {
      return res.status(400).json({
        success: false,
        count: 0,
        error: "Google Sheet URL produk belum diatur di Settings",
      });
    }

    const setSyncError = async (errMsg: string) => {
      if (!settings) return;
      await db
        .update(settingsTable)
        .set({
          productSheetLastSyncAt: new Date(),
          productSheetLastSyncError: errMsg,
          productSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings.id));
    };

    const csvUrl = normalizeSheetUrlToCsv(sheetUrl);
    if (!csvUrl) {
      const errMsg = "Format URL Google Sheet tidak dikenali";
      await setSyncError(errMsg);
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    let csvText: string;
    try {
      csvText = await fetchSheetCsv(csvUrl);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gagal mengambil sheet";
      await setSyncError(msg);
      return res.status(400).json({ success: false, count: 0, error: msg });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      const errMsg = "Sheet kosong atau tidak punya data (selain header)";
      await setSyncError(errMsg);
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    // Skip header. Dedupe by code (first occurrence wins; later duplicates skipped).
    const dataRows = rows.slice(1);
    const seen = new Set<string>();
    const skipped: { row: number; reason: string }[] = [];
    const entries: {
      code: string;
      name: string;
      price: number;
      imageUrl: string | null;
      productUrl: string | null;
      source: string;
    }[] = [];

    for (let i = 0; i < dataRows.length; i++) {
      const r = dataRows[i];
      const rowNum = i + 2; // human-friendly row number incl. header
      const code = (r[0] ?? "").trim();
      const nameRaw = (r[1] ?? "").trim();
      const priceRaw = (r[2] ?? "").trim();
      const imageRaw = (r[3] ?? "").trim();
      const urlRaw = (r[4] ?? "").trim();

      if (!code) {
        skipped.push({ row: rowNum, reason: "kode kosong" });
        continue;
      }
      const price = parsePriceCell(priceRaw);
      if (price === null) {
        skipped.push({ row: rowNum, reason: "harga tidak valid" });
        continue;
      }
      if (seen.has(code)) {
        skipped.push({ row: rowNum, reason: `kode "${code}" duplikat` });
        continue;
      }
      seen.add(code);

      entries.push({
        code,
        name: nameRaw || code,
        price,
        imageUrl: isValidHttpUrl(imageRaw) ? imageRaw : null,
        productUrl: isValidHttpUrl(urlRaw) ? urlRaw : null,
        source: "google_sheet",
      });
    }

    if (entries.length === 0) {
      const errMsg =
        "Tidak ada baris valid. Format: A=kode, B=nama, C=harga, D=foto, E=link website. Baris 1 = header.";
      await setSyncError(errMsg);
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    // Replace all sheet-synced rows in a single tx. Manual rows untouched.
    try {
      await db.transaction(async (tx) => {
        await tx.delete(productsTable).where(eq(productsTable.source, "google_sheet"));
        await tx.insert(productsTable).values(entries);
      });
    } catch (e: any) {
      if (e?.code === "23505") {
        // Unique constraint on `code` collided with an existing manual entry.
        // The tx rolled back atomically — no data loss. Tell the user which
        // code(s) need to be renamed in their sheet or removed from manual.
        const detail =
          typeof e?.detail === "string"
            ? e.detail.replace(/^Key \(code\)=\(([^)]+)\) already exists\.?$/, '"$1"')
            : null;
        const errMsg = detail
          ? `Kode produk bentrok dengan entri manual: ${detail}. Hapus produk manual atau ubah kode di sheet.`
          : "Beberapa kode di sheet bentrok dengan produk manual. Hapus produk manual atau ubah kode di sheet.";
        await setSyncError(errMsg);
        return res.status(409).json({ success: false, count: 0, error: errMsg });
      }
      throw e;
    }

    const summary =
      skipped.length > 0
        ? `${entries.length} produk tersimpan, ${skipped.length} baris dilewati.`
        : null;

    await db
      .update(settingsTable)
      .set({
        productSheetLastSyncAt: new Date(),
        productSheetLastSyncError: summary,
        productSheetLastSyncCount: entries.length,
        updatedAt: new Date(),
      })
      .where(eq(settingsTable.id, settings!.id));

    req.log.info(
      { inserted: entries.length, skipped: skipped.length },
      "Product sheet sync done"
    );
    res.json({ success: true, count: entries.length });
  } catch (err) {
    req.log.error({ err }, "Failed to sync products from google sheet");
    res.status(500).json({ success: false, count: 0, error: "Internal server error" });
  } finally {
    productSyncInFlight = false;
  }
});

// Image upload endpoint — returns the public URL the frontend can attach
// to a product when creating/updating.
router.post("/upload-image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    const url = `/api/media/${path.basename(req.file.path)}`;
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "Failed to upload product image");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
