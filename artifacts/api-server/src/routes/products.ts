import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { db } from "@workspace/db";
import { productsTable } from "@workspace/db";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Request, Response } from "express";
import { resolveOwnerUserId } from "../lib/seed";
import { refreshChecklist } from "../lib/onboarding";
import { saveTenantMedia } from "../lib/tenant-storage";
import { checkStorageQuota } from "../lib/storage-enforce";
import {
  requireSupervisorOrAbove,
  getCurrentTeamRole,
} from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";
import { buildQuotationPdf, type QuotationItem } from "../lib/quotation-pdf";
import {
  requireOwnerUserId,
  getOwnerPrimaryPhone,
} from "../lib/channel-context";
import {
  parseChannelIdsInput,
  replaceChannelAssignments,
  verifyChannelOwnership,
  loadChannelIdsBatch,
} from "../lib/channel-assignments";

// Products are a shared resource (per-user). Reads scope by user_id; writes
// also need owner_phone (legacy NOT NULL column) — derive from primary
// channel; 503 if the user has no paired channel yet.
async function resolveWriteOwner(
  req: Request,
  res: Response,
  errMsg: string
): Promise<{ ownerUserId: number; ownerPhone: string } | null> {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return null;
  const ownerPhone = await getOwnerPrimaryPhone(ownerUserId);
  if (!ownerPhone) {
    res.status(503).json({ error: errMsg });
    return null;
  }
  return { ownerUserId, ownerPhone };
}

const router = Router();
// Agen view-only untuk produk; semua mutasi/import/upload butuh supervisor+.
router.get("/", requirePermission("products", "view"));
router.get("/export.csv", requirePermission("products", "view"));
router.get("/export.xlsx", requirePermission("products", "view"));
router.post("/quotation.pdf", requirePermission("products", "view"));
router.post("/", requireSupervisorOrAbove, requirePermission("products", "create"));
router.put("/:id", requireSupervisorOrAbove, requirePermission("products", "edit"));
router.delete("/:id", requireSupervisorOrAbove, requirePermission("products", "delete"));
router.post("/upload-image", requireSupervisorOrAbove, requirePermission("products", "create"));
router.post("/import", requireSupervisorOrAbove, requirePermission("products", "create"));

const imageUpload = multer({
  storage: multer.memoryStorage(),
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

// Internal pricing tiers are operator-confidential and must never reach an
// agent (or any customer-facing surface). We strip them by nulling the fields
// (keeping the response shape identical to the OpenAPI contract) for callers
// who aren't supervisor-or-above. Stock figures stay — the agent app is allowed
// to display stock; only the tier prices are withheld.
function serialize(
  p: typeof productsTable.$inferSelect,
  channelIds: number[],
  includeInternalPricing: boolean
) {
  return {
    ...p,
    priceSilver: includeInternalPricing ? p.priceSilver : null,
    priceGold: includeInternalPricing ? p.priceGold : null,
    pricePlatinum: includeInternalPricing ? p.pricePlatinum : null,
    priceReseller: includeInternalPricing ? p.priceReseller : null,
    priceDistributor: includeInternalPricing ? p.priceDistributor : null,
    channelIds,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// Tier prices are visible only to supervisor-and-above (the catalog managers).
async function callerCanSeeInternalPricing(req: Request): Promise<boolean> {
  const userId = req.session.userId;
  if (userId == null) return false;
  const role = await getCurrentTeamRole(userId);
  return role === "super_admin" || role === "supervisor";
}

const ProductBody = z.object({
  code: z.string().trim().min(1, "Kode wajib diisi"),
  name: z.string().trim().min(1, "Nama wajib diisi"),
  category: z.string().trim().nullable().optional(),
  description: z.string().trim().nullable().optional(),
  price: z.number().int().nonnegative(),
  priceSilver: z.number().int().nonnegative().nullable().optional(),
  priceGold: z.number().int().nonnegative().nullable().optional(),
  pricePlatinum: z.number().int().nonnegative().nullable().optional(),
  priceReseller: z.number().int().nonnegative().nullable().optional(),
  priceDistributor: z.number().int().nonnegative().nullable().optional(),
  stock: z.number().int().nonnegative().nullable().optional(),
  stockOnHand: z.number().int().nonnegative().nullable().optional(),
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
    description: norm(b.description),
    price: b.price,
    priceSilver: num(b.priceSilver),
    priceGold: num(b.priceGold),
    pricePlatinum: num(b.pricePlatinum),
    priceReseller: num(b.priceReseller),
    priceDistributor: num(b.priceDistributor),
    stock: num(b.stock),
    stockOnHand: num(b.stockOnHand),
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

router.get("/", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId))
      .orderBy(productsTable.createdAt);
    const joins = await loadChannelIdsBatch(
      "product",
      rows.map((r) => r.id)
    );
    const includeInternalPricing = await callerCanSeeInternalPricing(req);
    res.json(
      rows.map((r) =>
        serialize(r, joins.get(r.id) ?? [], includeInternalPricing)
      )
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list products");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res): Promise<void> => {
  try {
    const parsed = ProductBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const channelIds = parseChannelIdsInput(req.body?.channelIds);
    if (channelIds === "invalid") {
      res.status(400).json({ error: "Invalid channelIds" });
      return;
    }
    const owner = await resolveWriteOwner(
      req,
      res,
      "Hubungkan WhatsApp dulu sebelum menambah produk."
    );
    if (!owner) return;
    try {
      const [created] = await db
        .insert(productsTable)
        .values({
          ...bodyToInsert(parsed.data),
          userId: owner.ownerUserId,
        })
        .returning();
      const assigned = await replaceChannelAssignments(
        "product",
        created.id,
        channelIds,
        owner.ownerUserId
      );
      if (assigned === "forbidden") {
        await db.delete(productsTable).where(eq(productsTable.id, created.id));
        res.status(400).json({ error: "Invalid channelIds" });
        return;
      }
      // Best-effort onboarding checklist refresh (flips productAdded → true).
      try {
        await refreshChecklist(owner.ownerUserId);
      } catch {
        /* best-effort */
      }
      // Writers are supervisor-or-above, so they get the full pricing back.
      res.status(201).json(serialize(created, channelIds ?? [], true));
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "23505") {
        res.status(409).json({ error: "Kode produk sudah dipakai" });
        return;
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create product");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = ProductBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const channelIds = parseChannelIdsInput(req.body?.channelIds);
    if (channelIds === "invalid") {
      res.status(400).json({ error: "Invalid channelIds" });
      return;
    }
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    // Pre-flight ownership check so a forbidden channelId fails the request
    // BEFORE the row update commits (avoids partial writes).
    if ((await verifyChannelOwnership(ownerUserId, channelIds)) === "forbidden") {
      res.status(400).json({ error: "Invalid channelIds" });
      return;
    }
    try {
      const [updated] = await db
        .update(productsTable)
        .set({ ...bodyToInsert(parsed.data), updatedAt: new Date() })
        .where(and(eq(productsTable.id, id), eq(productsTable.userId, ownerUserId)))
        .returning();
      if (!updated) { res.status(404).json({ error: "Product not found" }); return; }
      await replaceChannelAssignments("product", updated.id, channelIds, ownerUserId);
      const joins = await loadChannelIdsBatch("product", [updated.id]);
      res.json(serialize(updated, joins.get(updated.id) ?? [], true));
    } catch (e: unknown) {
      if ((e as { code?: string })?.code === "23505") {
        res.status(409).json({ error: "Kode produk sudah dipakai" });
        return;
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update product");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const deleted = await db
      .delete(productsTable)
      .where(and(eq(productsTable.id, id), eq(productsTable.userId, ownerUserId)))
      .returning();
    if (deleted.length === 0) { res.status(404).json({ error: "Product not found" }); return; }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete product");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Image upload ---
router.post("/upload-image", imageUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) { res.status(400).json({ error: "Missing file" }); return; }
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    // FASE C: block the upload if the tenant is over its storage plafon (no-op
    // unless the operator has enabled enforcement).
    const storageCheck = await checkStorageQuota(ownerUserId, req.file.buffer.length);
    if (!storageCheck.ok) { res.status(413).json({ error: storageCheck.message }); return; }
    const { url } = await saveTenantMedia({
      ownerUserId,
      buffer: req.file.buffer,
      contentType: req.file.mimetype || "image/jpeg",
      kind: "product",
      preferredFilename: req.file.originalname,
    });
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
  "description",
  "price",
  "priceSilver",
  "priceGold",
  "pricePlatinum",
  "priceReseller",
  "priceDistributor",
  "stock",
  "stockOnHand",
  "imageUrl",
  "flyerUrl",
  "productUrl",
  "videoUrls",
] as const;

// Internal pricing tiers are operator-confidential — blanked in exports for
// callers below supervisor, same as the JSON serializer.
const INTERNAL_PRICE_HEADERS = new Set<string>([
  "priceSilver",
  "priceGold",
  "pricePlatinum",
  "priceReseller",
  "priceDistributor",
]);

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

router.get("/export.csv", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId))
      .orderBy(productsTable.id);
    const includeInternalPricing = await callerCanSeeInternalPricing(req);
    const lines: string[] = [EXPORT_HEADERS.join(",")];
    for (const r of rows) {
      lines.push(
        EXPORT_HEADERS.map((h) =>
          !includeInternalPricing && INTERNAL_PRICE_HEADERS.has(h)
            ? ""
            : rowToCsvField((r as Record<string, unknown>)[h]),
        ).join(","),
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

router.get("/export.xlsx", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId))
      .orderBy(productsTable.id);
    const includeInternalPricing = await callerCanSeeInternalPricing(req);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Products");
    ws.addRow([...EXPORT_HEADERS]);
    for (const r of rows) {
      ws.addRow(
        EXPORT_HEADERS.map((h) => {
          if (!includeInternalPricing && INTERNAL_PRICE_HEADERS.has(h)) return "";
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

// Generate a quotation (penawaran harga) PDF for a selected set of products.
// Each row shows the product photo, name and pricelist price (productsTable.price).
// POST body: { ids: number[] }. Scoped to the caller's tenant via userId.
const quotationBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(200),
});

router.post("/quotation.pdf", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const parsed = quotationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Pilih minimal satu produk." });
      return;
    }
    const uniqueIds = [...new Set(parsed.data.ids)];
    const rows = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId))
      .orderBy(productsTable.id);
    const byId = new Map(rows.map((r) => [r.id, r]));
    // Preserve the order the client selected the products in.
    const items: QuotationItem[] = uniqueIds
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({
        name: r.name,
        code: r.code,
        price: r.price ?? 0,
        imageUrl: r.imageUrl ?? null,
      }));
    if (items.length === 0) {
      res.status(404).json({ error: "Produk tidak ditemukan." });
      return;
    }
    const pdf = await buildQuotationPdf(items);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="quotation_${exportTimestamp()}.pdf"`,
    );
    res.send(Buffer.from(pdf));
  } catch (err) {
    req.log.error({ err }, "Failed to generate quotation pdf");
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
  description: "description",
  deskripsi: "description",
  keterangan: "description",
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
  stock: "stock",
  stok: "stock",
  qty: "stock",
  "stok gudang": "stock",
  "jumlah stok": "stock",
  "stock on hand": "stockOnHand",
  stockonhand: "stockOnHand",
  "stok on hand": "stockOnHand",
  "qty on hand": "stockOnHand",
  qtyonhand: "stockOnHand",
  "stok ready": "stockOnHand",
  ready: "stockOnHand",
  soh: "stockOnHand",
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
  description: 0,
  price: 0,
  priceSilver: 0,
  priceGold: 0,
  pricePlatinum: 0,
  priceReseller: 0,
  priceDistributor: 0,
  stock: 0,
  stockOnHand: 0,
  imageUrl: 0,
  flyerUrl: 0,
  productUrl: 0,
  videoUrls: 0,
};

type ProductCol = keyof typeof EXPORT_HEADERS_MAP;

let productImportInFlight = false;

router.post("/import", fileUpload.single("file"), async (req, res): Promise<void> => {
  if (productImportInFlight) {
    res.status(409).json({ error: "Import sedang berjalan, tunggu sebentar." });
    return;
  }
  productImportInFlight = true;
  try {
    const owner = await resolveWriteOwner(
      req,
      res,
      "Hubungkan WhatsApp dulu sebelum mengimpor produk."
    );
    if (!owner) return;
    if (!req.file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }
    const name = (req.file.originalname || "").toLowerCase();
    let rows: string[][];
    try {
      if (name.endsWith(".xlsx")) {
        rows = await parseXlsxBuffer(req.file.buffer);
      } else if (name.endsWith(".csv")) {
        rows = parseCsv(req.file.buffer.toString("utf-8"));
      } else {
        res.status(400).json({ error: "Format tidak didukung. Gunakan .csv atau .xlsx." });
        return;
      }
    } catch (e) {
      req.log.error({ err: e }, "Failed to parse product import file");
      res.status(400).json({ error: "Gagal membaca isi file." });
      return;
    }

    if (rows.length === 0) {
      res.status(400).json({ error: "File kosong." });
      return;
    }

    const headerCells = rows[0].map((c) => c.trim().toLowerCase());
    const colIndex: Partial<Record<ProductCol, number>> = {};
    headerCells.forEach((h, idx) => {
      const key = HEADER_ALIASES[h];
      if (key && colIndex[key] === undefined) colIndex[key] = idx;
    });

    if (colIndex.code === undefined || colIndex.name === undefined || colIndex.price === undefined) {
      res.status(400).json({
        error:
          "Header wajib: Kode Product, Nama Barang, Harga Pricelist. Header lain (Category, Harga Silver/Gold/Platinum/Reseller/Distributor, Link Foto, Link Flyer, Link Website, Link Video) opsional.",
      });
      return;
    }

    const cell = (r: string[], k: ProductCol): string =>
      colIndex[k] !== undefined ? (r[colIndex[k] as number] ?? "").toString().trim() : "";

    // ownerPhone + userId are added at insert time (block below) so the
    // parsed array omits them here.
    const entries: Omit<typeof productsTable.$inferInsert, "userId">[] = [];
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
        description: cell(r, "description") || null,
        price,
        priceSilver: parseIntCell(cell(r, "priceSilver")),
        priceGold: parseIntCell(cell(r, "priceGold")),
        pricePlatinum: parseIntCell(cell(r, "pricePlatinum")),
        priceReseller: parseIntCell(cell(r, "priceReseller")),
        priceDistributor: parseIntCell(cell(r, "priceDistributor")),
        stock: parseIntCell(cell(r, "stock")),
        stockOnHand: parseIntCell(cell(r, "stockOnHand")),
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
      res.status(400).json({ error: "Tidak ada baris valid di file." });
      return;
    }

    // Per-user upsert by (user_id, code): existing products keep their id (so
    // the serial sequence no longer jumps ~568 every import), new codes are
    // inserted, and codes absent from this import are removed. Filter is on
    // user_id; other users' catalogs are untouched.
    const codes = entries.map((e) => e.code);
    await db.transaction(async (tx) => {
      await tx
        .insert(productsTable)
        .values(
          entries.map((e) => ({
            ...e,
            userId: owner.ownerUserId,
          })),
        )
        .onConflictDoUpdate({
          target: [productsTable.userId, productsTable.code],
          set: {
            name: sql`excluded.name`,
            category: sql`excluded.category`,
            description: sql`excluded.description`,
            price: sql`excluded.price`,
            priceSilver: sql`excluded.price_silver`,
            priceGold: sql`excluded.price_gold`,
            pricePlatinum: sql`excluded.price_platinum`,
            priceReseller: sql`excluded.price_reseller`,
            priceDistributor: sql`excluded.price_distributor`,
            stock: sql`excluded.stock`,
            stockOnHand: sql`excluded.stock_on_hand`,
            imageUrl: sql`excluded.image_url`,
            flyerUrl: sql`excluded.flyer_url`,
            productUrl: sql`excluded.product_url`,
            videoUrls: sql`excluded.video_urls`,
            updatedAt: sql`now()`,
          },
        });
      await tx
        .delete(productsTable)
        .where(
          and(
            eq(productsTable.userId, owner.ownerUserId),
            notInArray(productsTable.code, codes),
          ),
        );
    });

    res.json({ imported: entries.length, skipped: skipped.length });
  } catch (err) {
    req.log.error({ err }, "Failed to import products");
    res.status(500).json({ error: "Internal server error" });
  } finally {
    productImportInFlight = false;
  }
});


export default router;
