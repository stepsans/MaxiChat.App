import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { productsTable, knowledgeTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { MEDIA_DIR, getCurrentOwnerPhone } from "./whatsapp";
import { ensureKnowledgeTypesSeed } from "./knowledge-types";
import { requireSupervisorOrAbove } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";

const router = Router();
// Agen view-only untuk produk; semua mutasi/import/upload butuh supervisor+.
router.get("/", requirePermission("products", "view"));
router.get("/export.csv", requirePermission("products", "view"));
router.get("/export.xlsx", requirePermission("products", "view"));
router.post("/", requireSupervisorOrAbove, requirePermission("products", "create"));
router.put("/:id", requireSupervisorOrAbove, requirePermission("products", "edit"));
router.delete("/:id", requireSupervisorOrAbove, requirePermission("products", "delete"));
router.post("/upload-image", requireSupervisorOrAbove, requirePermission("products", "create"));
router.post("/import", requireSupervisorOrAbove, requirePermission("products", "create"));
router.post("/sync-to-knowledge", requireSupervisorOrAbove, requirePermission("products", "edit"));

const imageUpload = multer({
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

const fileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

function serialize(p: typeof productsTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

const ProductBody = z.object({
  code: z.string().trim().min(1, "Kode wajib diisi"),
  name: z.string().trim().min(1, "Nama wajib diisi"),
  category: z.string().trim().nullable().optional(),
  price: z.number().int().nonnegative(),
  priceSilver: z.number().int().nonnegative().nullable().optional(),
  priceGold: z.number().int().nonnegative().nullable().optional(),
  pricePlatinum: z.number().int().nonnegative().nullable().optional(),
  priceReseller: z.number().int().nonnegative().nullable().optional(),
  priceDistributor: z.number().int().nonnegative().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  flyerUrl: z.string().nullable().optional(),
  productUrl: z.string().nullable().optional(),
  videoUrls: z.array(z.string()).max(10).optional(),
});

function isSafeHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeMediaUrl(s: string): boolean {
  // Allow http(s) external links and internal /api/media/... uploads
  if (s.startsWith("/api/media/")) return true;
  return isSafeHttpUrl(s);
}

function bodyToInsert(b: z.infer<typeof ProductBody>) {
  const norm = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    return s.length > 0 ? s : null;
  };
  const num = (n: number | null | undefined) =>
    n === undefined || n === null ? null : n;
  return {
    code: b.code.trim(),
    name: b.name.trim(),
    category: norm(b.category),
    price: b.price,
    priceSilver: num(b.priceSilver),
    priceGold: num(b.priceGold),
    pricePlatinum: num(b.pricePlatinum),
    priceReseller: num(b.priceReseller),
    priceDistributor: num(b.priceDistributor),
    imageUrl: ((): string | null => {
      const v = norm(b.imageUrl);
      return v && isSafeMediaUrl(v) ? v : null;
    })(),
    // Flyer can be either an http(s) URL or an iframe embed HTML snippet
    // (typically pasted from Google Drive's "Embed item" dialog). We store
    // exactly what the user gave us; src extraction happens at send time.
    flyerUrl: ((): string | null => {
      const v = norm(b.flyerUrl);
      if (!v) return null;
      if (v.length > 4000) return null;
      // Accept either plain http(s) URL or anything containing an iframe src.
      if (isSafeHttpUrl(v)) return v;
      if (/<iframe[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(v)) return v;
      return null;
    })(),
    productUrl: ((): string | null => {
      const v = norm(b.productUrl);
      return v && isSafeHttpUrl(v) ? v : null;
    })(),
    videoUrls: (b.videoUrls ?? [])
      .map((s) => (s ?? "").trim())
      .filter((s) => s.length > 0 && isSafeHttpUrl(s))
      .slice(0, 10),
  };
}

router.get("/", async (req, res) => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) return res.json([]);
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.ownerPhone, ownerPhone))
      .orderBy(productsTable.createdAt);
    res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "Failed to list products");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = ProductBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    }
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menambah produk." });
    }
    try {
      const [created] = await db
        .insert(productsTable)
        .values({ ...bodyToInsert(parsed.data), ownerPhone })
        .returning();
      res.status(201).json(serialize(created));
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "23505") {
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const parsed = ProductBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    }
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengubah produk." });
    }
    try {
      const [updated] = await db
        .update(productsTable)
        .set({ ...bodyToInsert(parsed.data), updatedAt: new Date() })
        .where(and(eq(productsTable.id, id), eq(productsTable.ownerPhone, ownerPhone)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Product not found" });
      res.json(serialize(updated));
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "23505") {
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menghapus produk." });
    }
    const deleted = await db
      .delete(productsTable)
      .where(and(eq(productsTable.id, id), eq(productsTable.ownerPhone, ownerPhone)))
      .returning();
    if (deleted.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete product");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Image upload ---
router.post("/upload-image", imageUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    const url = `/api/media/${path.basename(req.file.path)}`;
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "Failed to upload product image");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Import / Export ---

const EXPORT_HEADERS = [
  "id",
  "code",
  "name",
  "category",
  "price",
  "priceSilver",
  "priceGold",
  "pricePlatinum",
  "priceReseller",
  "priceDistributor",
  "imageUrl",
  "flyerUrl",
  "productUrl",
  "videoUrls",
] as const;

function neutralizeFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function exportTimestamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}-${get("hour")}${get("minute")}`;
}

function rowToCsvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join(" | ") : String(v);
  const escaped = s.includes('"') ? s.replace(/"/g, '""') : s;
  const needsQuote = /[",\n\r]/.test(s);
  const safe = neutralizeFormula(escaped);
  return needsQuote ? `"${safe}"` : safe;
}

router.get("/export.csv", async (req, res) => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengekspor produk." });
    }
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.ownerPhone, ownerPhone))
      .orderBy(productsTable.id);
    const lines: string[] = [EXPORT_HEADERS.join(",")];
    for (const r of rows) {
      lines.push(
        EXPORT_HEADERS.map((h) => rowToCsvField((r as Record<string, unknown>)[h])).join(","),
      );
    }
    const body = "\uFEFF" + lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="products_${exportTimestamp()}.csv"`,
    );
    res.send(body);
  } catch (err) {
    req.log.error({ err }, "Failed to export products csv");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/export.xlsx", async (req, res) => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengekspor produk." });
    }
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.ownerPhone, ownerPhone))
      .orderBy(productsTable.id);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");
    ws.addRow([...EXPORT_HEADERS]);
    for (const r of rows) {
      ws.addRow(
        EXPORT_HEADERS.map((h) => {
          const v = (r as Record<string, unknown>)[h];
          if (Array.isArray(v)) return v.join(" | ");
          return v ?? "";
        }),
      );
    }
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="products_${exportTimestamp()}.xlsx"`,
    );
    const buf = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    req.log.error({ err }, "Failed to export products xlsx");
    res.status(500).json({ error: "Internal server error" });
  }
});

export function parseIntCell(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
}

function parseCsv(text: string): string[][] {
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (inQuotes) {
      if (c === '"') {
        if (stripped[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip
      } else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function parseXlsxBuffer(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const v = cell.value;
      if (v === null || v === undefined) cells.push("");
      else if (typeof v === "object" && "text" in v) cells.push(String((v as { text: string }).text));
      else if (typeof v === "object" && "result" in v)
        cells.push(String((v as { result: unknown }).result ?? ""));
      else cells.push(String(v));
    });
    out.push(cells);
  });
  return out;
}

export const HEADER_ALIASES: Record<string, keyof typeof EXPORT_HEADERS_MAP> = {
  id: "id",
  code: "code",
  "kode product": "code",
  "kode produk": "code",
  "kode barang": "code",
  name: "name",
  "nama barang": "name",
  "nama produk": "name",
  category: "category",
  kategori: "category",
  price: "price",
  "harga pricelist": "price",
  pricelist: "price",
  "harga silver": "priceSilver",
  pricesilver: "priceSilver",
  "harga gold": "priceGold",
  pricegold: "priceGold",
  "harga platinum": "pricePlatinum",
  priceplatinum: "pricePlatinum",
  "harga reseller": "priceReseller",
  pricereseller: "priceReseller",
  "harga distributor": "priceDistributor",
  pricedistributor: "priceDistributor",
  "image url": "imageUrl",
  "image_url": "imageUrl",
  imageurl: "imageUrl",
  foto: "imageUrl",
  "link foto": "imageUrl",
  "link gambar": "imageUrl",
  gambar: "imageUrl",
  "flyer url": "flyerUrl",
  "flyer_url": "flyerUrl",
  flyerurl: "flyerUrl",
  flyer: "flyerUrl",
  "link flyer": "flyerUrl",
  "product url": "productUrl",
  "product_url": "productUrl",
  producturl: "productUrl",
  "link website": "productUrl",
  website: "productUrl",
  "video url": "videoUrls",
  "video_url": "videoUrls",
  videourl: "videoUrls",
  "video urls": "videoUrls",
  "video_urls": "videoUrls",
  videourls: "videoUrls",
  "link video": "videoUrls",
};

export const EXPORT_HEADERS_MAP = {
  id: 0,
  code: 0,
  name: 0,
  category: 0,
  price: 0,
  priceSilver: 0,
  priceGold: 0,
  pricePlatinum: 0,
  priceReseller: 0,
  priceDistributor: 0,
  imageUrl: 0,
  flyerUrl: 0,
  productUrl: 0,
  videoUrls: 0,
};

type ProductCol = keyof typeof EXPORT_HEADERS_MAP;

let productImportInFlight = false;

router.post("/import", fileUpload.single("file"), async (req, res) => {
  if (productImportInFlight) {
    return res.status(409).json({ error: "Import sedang berjalan, tunggu sebentar." });
  }
  productImportInFlight = true;
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum mengimpor produk." });
    }
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    const name = (req.file.originalname || "").toLowerCase();
    let rows: string[][];
    try {
      if (name.endsWith(".xlsx")) {
        rows = await parseXlsxBuffer(req.file.buffer);
      } else if (name.endsWith(".csv")) {
        rows = parseCsv(req.file.buffer.toString("utf-8"));
      } else {
        return res.status(400).json({ error: "Format tidak didukung. Gunakan .csv atau .xlsx." });
      }
    } catch (e) {
      req.log.error({ err: e }, "Failed to parse product import file");
      return res.status(400).json({ error: "Gagal membaca isi file." });
    }

    if (rows.length === 0) {
      return res.status(400).json({ error: "File kosong." });
    }

    const headerCells = rows[0].map((c) => c.trim().toLowerCase());
    const colIndex: Partial<Record<ProductCol, number>> = {};
    headerCells.forEach((h, idx) => {
      const key = HEADER_ALIASES[h];
      if (key && colIndex[key] === undefined) colIndex[key] = idx;
    });

    if (colIndex.code === undefined || colIndex.name === undefined || colIndex.price === undefined) {
      return res.status(400).json({
        error:
          "Header wajib: Kode Product, Nama Barang, Harga Pricelist. Header lain (Category, Harga Silver/Gold/Platinum/Reseller/Distributor, Link Foto, Link Flyer, Link Website, Link Video) opsional.",
      });
    }

    const cell = (r: string[], k: ProductCol): string =>
      colIndex[k] !== undefined ? (r[colIndex[k] as number] ?? "").toString().trim() : "";

    // ownerPhone is added at insert time (line below) so the parsed array
    // omits it here.
    const entries: Omit<typeof productsTable.$inferInsert, "ownerPhone">[] = [];
    const seen = new Set<string>();
    const skipped: { row: number; reason: string }[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const rowNum = i + 1;
      const code = cell(r, "code");
      const nm = cell(r, "name");
      const priceRaw = cell(r, "price");
      if (!code) {
        skipped.push({ row: rowNum, reason: "kode kosong" });
        continue;
      }
      const price = parseIntCell(priceRaw);
      if (price === null) {
        skipped.push({ row: rowNum, reason: "harga pricelist tidak valid" });
        continue;
      }
      if (seen.has(code)) {
        skipped.push({ row: rowNum, reason: `kode "${code}" duplikat di file` });
        continue;
      }
      seen.add(code);

      const urlOrNull = (s: string) => {
        const t = s.trim();
        if (!t) return null;
        try {
          const u = new URL(t);
          return u.protocol === "http:" || u.protocol === "https:" ? t : null;
        } catch {
          return null;
        }
      };

      const videoUrlsCell = cell(r, "videoUrls");
      const videoUrls = videoUrlsCell
        .split(/[|\n;]+/)
        .map((s) => urlOrNull(s))
        .filter((u): u is string => !!u)
        .slice(0, 10);

      entries.push({
        code,
        name: nm || code,
        category: cell(r, "category") || null,
        price,
        priceSilver: parseIntCell(cell(r, "priceSilver")),
        priceGold: parseIntCell(cell(r, "priceGold")),
        pricePlatinum: parseIntCell(cell(r, "pricePlatinum")),
        priceReseller: parseIntCell(cell(r, "priceReseller")),
        priceDistributor: parseIntCell(cell(r, "priceDistributor")),
        imageUrl: urlOrNull(cell(r, "imageUrl")),
        flyerUrl: ((): string | null => {
          const raw = cell(r, "flyerUrl");
          if (!raw) return null;
          if (raw.length > 4000) return null;
          if (/<iframe[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(raw)) return raw;
          return urlOrNull(raw);
        })(),
        productUrl: urlOrNull(cell(r, "productUrl")),
        videoUrls,
      });
    }

    if (entries.length === 0) {
      return res.status(400).json({ error: "Tidak ada baris valid di file." });
    }

    // Owner-scoped wipe & replace: only this account's catalog is rebuilt;
    // other operators' product catalogs are untouched.
    await db.transaction(async (tx) => {
      await tx.delete(productsTable).where(eq(productsTable.ownerPhone, ownerPhone));
      await tx
        .insert(productsTable)
        .values(entries.map((e) => ({ ...e, ownerPhone })));
    });

    res.json({ imported: entries.length, skipped: skipped.length });
  } catch (err) {
    req.log.error({ err }, "Failed to import products");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    productImportInFlight = false;
  }
});

// Title used for the auto-generated knowledge entry built from the product
// catalog. Kept stable so each sync replaces the previous entry instead of
// piling up duplicates.
const PRODUCT_KB_TITLE = "Katalog Produk (auto-sync)";

function formatIdr(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return "Rp " + n.toLocaleString("id-ID");
}

function buildKnowledgeContent(
  rows: (typeof productsTable.$inferSelect)[],
): string {
  if (rows.length === 0) {
    return "Belum ada produk di katalog.";
  }
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const cat = (r.category ?? "").trim() || "Tanpa Kategori";
    const list = groups.get(cat);
    if (list) list.push(r);
    else groups.set(cat, [r]);
  }
  const sortedCats = Array.from(groups.keys()).sort((a, b) =>
    a.localeCompare(b, "id-ID", { sensitivity: "base" }),
  );
  const lines: string[] = [];
  lines.push(
    `Daftar produk toko (total ${rows.length} item, ${sortedCats.length} kategori). Gunakan data ini saat menjawab pertanyaan customer tentang nama produk, kategori, kode, atau harga pricelist.`,
  );
  for (const cat of sortedCats) {
    const items = groups.get(cat)!.slice().sort((a, b) =>
      a.name.localeCompare(b.name, "id-ID", { sensitivity: "base" }),
    );
    lines.push("");
    lines.push(`== Kategori: ${cat} (${items.length} produk) ==`);
    for (const p of items) {
      lines.push(
        `- ${p.name} | kode: ${p.code} | harga: ${formatIdr(p.price)}`,
      );
    }
  }
  return lines.join("\n");
}

// Per-owner in-flight lock prevents two concurrent sync calls (e.g. impatient
// double-click on the UI button) from racing each other in the
// delete-then-insert transaction below. Without this we could end up with
// duplicate "Katalog Produk (auto-sync)" rows since the DB does not enforce
// uniqueness on (owner_phone, title) — keeping the constraint out of schema
// avoids breaking owners who legitimately have duplicate manual titles.
const syncToKnowledgeInFlight = new Set<string>();

// Snapshot the current product catalog into a single knowledge entry so the
// AI (which is fed only from the knowledge base) can answer questions like
// "produk apa saja di kategori X". Internal tier prices (silver/gold/etc.)
// are intentionally excluded — they are app-only data, never for customers.
router.post("/sync-to-knowledge", async (req, res) => {
  let ownerPhone: string | null = null;
  try {
    ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum sync ke knowledge base." });
    }
    if (syncToKnowledgeInFlight.has(ownerPhone)) {
      return res
        .status(409)
        .json({ error: "Sync sedang berjalan, tunggu sebentar." });
    }
    syncToKnowledgeInFlight.add(ownerPhone);
    await ensureKnowledgeTypesSeed(ownerPhone);
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.ownerPhone, ownerPhone))
      .orderBy(productsTable.id);
    const content = buildKnowledgeContent(rows);
    const contentChars = content.length;
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .delete(knowledgeTable)
        .where(
          and(
            eq(knowledgeTable.ownerPhone, ownerPhone!),
            eq(knowledgeTable.title, PRODUCT_KB_TITLE),
          ),
        );
      await tx.insert(knowledgeTable).values({
        ownerPhone: ownerPhone!,
        type: "product",
        title: PRODUCT_KB_TITLE,
        content,
        createdAt: now,
        updatedAt: now,
      });
    });
    res.json({ synced: rows.length, title: PRODUCT_KB_TITLE, contentChars });
  } catch (err) {
    req.log.error({ err }, "Failed to sync products to knowledge");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    if (ownerPhone) syncToKnowledgeInFlight.delete(ownerPhone);
  }
});

export default router;
