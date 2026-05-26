import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { google } from "googleapis";
import { z } from "zod";
import {
  db,
  productsTable,
  productSyncConfigTable,
  credentialsTable,
  type ProductSyncConfig,
  type Credential,
} from "@workspace/db";
import { getCurrentOwnerPhone } from "./whatsapp";
import { getAuthorizedOAuthClient } from "./credentials";
import { HEADER_ALIASES, EXPORT_HEADERS_MAP, parseIntCell } from "./products";
import { logger } from "../lib/logger";

const router = Router();

type ProductCol = keyof typeof EXPORT_HEADERS_MAP;

const ALLOWED_INTERVALS = new Set([5, 15, 30, 60]);

function publicConfig(row: ProductSyncConfig) {
  return {
    id: row.id,
    credentialId: row.credentialId,
    spreadsheetId: row.spreadsheetId,
    sheetName: row.sheetName,
    headerRow: row.headerRow,
    autoSyncEnabled: row.autoSyncEnabled,
    intervalMinutes: row.intervalMinutes,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    lastSyncStatus: row.lastSyncStatus as "idle" | "ok" | "error",
    lastSyncError: row.lastSyncError ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/sync-config", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.json({ config: null });
      return;
    }
    const [row] = await db
      .select()
      .from(productSyncConfigTable)
      .where(eq(productSyncConfigTable.ownerPhone, ownerPhone))
      .limit(1);
    res.json({ config: row ? publicConfig(row) : null });
  } catch (err) {
    req.log.error({ err }, "get sync config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

const ConfigInput = z.object({
  credentialId: z.number().int().positive(),
  spreadsheetId: z.string().min(1),
  sheetName: z.string().min(1),
  headerRow: z.number().int().min(1).max(100).optional(),
  autoSyncEnabled: z.boolean().optional(),
  intervalMinutes: z.number().int().refine((v) => ALLOWED_INTERVALS.has(v)).optional(),
});

router.put("/sync-config", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(503).json({ error: "Hubungkan WhatsApp dulu." });
      return;
    }
    // Pass `null` to clear the binding.
    if (req.body === null) {
      await db
        .delete(productSyncConfigTable)
        .where(eq(productSyncConfigTable.ownerPhone, ownerPhone));
      res.json({ config: null });
      return;
    }
    const parsed = ConfigInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    // Verify the credential belongs to the signed-in user — otherwise a user
    // could bind their products sync to someone else's tokens.
    const [cred] = await db
      .select()
      .from(credentialsTable)
      .where(
        and(
          eq(credentialsTable.id, parsed.data.credentialId),
          eq(credentialsTable.userId, userId)
        )
      )
      .limit(1);
    if (!cred) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    const values = {
      ownerPhone,
      credentialId: parsed.data.credentialId,
      spreadsheetId: parsed.data.spreadsheetId,
      sheetName: parsed.data.sheetName,
      headerRow: parsed.data.headerRow ?? 1,
      autoSyncEnabled: parsed.data.autoSyncEnabled ?? false,
      intervalMinutes: parsed.data.intervalMinutes ?? 15,
      updatedAt: new Date(),
    };
    const upserted = await db
      .insert(productSyncConfigTable)
      .values(values)
      .onConflictDoUpdate({
        target: productSyncConfigTable.ownerPhone,
        set: values,
      })
      .returning();
    res.json({ config: publicConfig(upserted[0]!) });
  } catch (err) {
    req.log.error({ err }, "upsert sync config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/sync-run", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(503).json({ error: "Hubungkan WhatsApp dulu." });
      return;
    }
    const result = await runSyncForOwner(ownerPhone);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err }, "manual product sync failed");
    res
      .status(500)
      .json({ error: (err as Error)?.message || "Sync gagal" });
  }
});

// ---- Sync engine ---------------------------------------------------------

type SyncResult = {
  inserted: number;
  updated: number;
  deleted: number;
  syncedAt: string;
};

// Map a sheet row to the same product columns the CSV/XLSX import accepts,
// reusing HEADER_ALIASES so users get one consistent column-name convention
// across import, sync, and export. Sheet is the source of truth → unmapped
// columns are ignored, blank rows are skipped, duplicate codes within the
// sheet take the first occurrence (rest are skipped silently).
function rowsToEntries(rows: string[][], headerRow: number): {
  entries: Omit<typeof productsTable.$inferInsert, "ownerPhone">[];
  skipped: number;
} {
  const headerIdx = Math.max(0, headerRow - 1);
  if (rows.length <= headerIdx) return { entries: [], skipped: 0 };
  const headerCells = rows[headerIdx]!.map((c) => (c ?? "").toString().trim().toLowerCase());
  const colIndex: Partial<Record<ProductCol, number>> = {};
  headerCells.forEach((h, idx) => {
    const key = HEADER_ALIASES[h];
    if (key && colIndex[key] === undefined) colIndex[key] = idx;
  });
  if (colIndex.code === undefined || colIndex.name === undefined || colIndex.price === undefined) {
    throw new Error(
      "Header tab wajib: Kode Product, Nama Barang, Harga Pricelist. Pastikan baris header benar."
    );
  }
  const cell = (r: string[], k: ProductCol): string =>
    colIndex[k] !== undefined ? (r[colIndex[k] as number] ?? "").toString().trim() : "";
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
  const entries: Omit<typeof productsTable.$inferInsert, "ownerPhone">[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (r.every((c) => !c || !c.toString().trim())) continue;
    const code = cell(r, "code");
    const nm = cell(r, "name");
    const price = parseIntCell(cell(r, "price"));
    if (!code || price === null || seen.has(code)) {
      skipped++;
      continue;
    }
    seen.add(code);
    const videoUrls = cell(r, "videoUrls")
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
  return { entries, skipped };
}

async function loadOwnedCredentialForUser(
  userId: number,
  credentialId: number
): Promise<Credential | null> {
  const [row] = await db
    .select()
    .from(credentialsTable)
    .where(
      and(
        eq(credentialsTable.id, credentialId),
        eq(credentialsTable.userId, userId)
      )
    )
    .limit(1);
  return row ?? null;
}

// Core sync used by both the manual route and the scheduler. Pulls the sheet
// via the Sheets API, validates the credential, replaces the owner's product
// catalog atomically (sheet = source of truth → rows missing from the sheet
// are deleted from the DB).
export async function runSyncForOwner(ownerPhone: string): Promise<SyncResult> {
  const [cfg] = await db
    .select()
    .from(productSyncConfigTable)
    .where(eq(productSyncConfigTable.ownerPhone, ownerPhone))
    .limit(1);
  if (!cfg) throw new Error("Belum ada Google Sheet yang dipilih.");
  // Resolve userId from user_whatsapp so we only use credentials owned by
  // the same app user this WhatsApp account belongs to.
  const { userWhatsappTable } = await import("@workspace/db");
  const [link] = await db
    .select({ userId: userWhatsappTable.userId })
    .from(userWhatsappTable)
    .where(eq(userWhatsappTable.ownerPhone, ownerPhone))
    .limit(1);
  if (!link) throw new Error("WhatsApp account tidak terhubung ke user.");
  const cred = await loadOwnedCredentialForUser(link.userId, cfg.credentialId);
  if (!cred) throw new Error("Credential tidak ditemukan atau bukan milik user ini.");
  if (cred.status !== "connected") {
    throw new Error("Credential belum terhubung ke Google. Reconnect dulu.");
  }
  let rows: string[][];
  try {
    const auth = await getAuthorizedOAuthClient(cred);
    const sheets = google.sheets({ version: "v4", auth });
    // Use the tab name as the A1 range (no specific columns → returns the
    // full populated rectangle).
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheetId,
      range: cfg.sheetName,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    rows = (resp.data.values ?? []).map((r) =>
      (r as unknown[]).map((c) => (c == null ? "" : String(c)))
    );
  } catch (err: unknown) {
    const e = err as { code?: number; response?: { status?: number; data?: { error?: { message?: string } } } };
    const status = e?.response?.status ?? e?.code;
    if (status === 401 || status === 403) {
      await db
        .update(credentialsTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(credentialsTable.id, cred.id));
      throw new Error("Akses Google ditolak. Reconnect credential di halaman Credentials.");
    }
    if (status === 404) throw new Error("Spreadsheet atau tab tidak ditemukan.");
    throw new Error(e?.response?.data?.error?.message || (err as Error)?.message || "Sheets API error");
  }
  const { entries, skipped: _skipped } = rowsToEntries(rows, cfg.headerRow);
  void _skipped;

  // Atomic replace: snapshot existing codes for the owner, replace with sheet
  // contents, count inserted/updated/deleted. We treat sheet as source of
  // truth — anything not in the sheet is removed.
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const syncedAt = new Date();
  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ code: productsTable.code })
        .from(productsTable)
        .where(eq(productsTable.ownerPhone, ownerPhone));
      const existingCodes = new Set(existing.map((r) => r.code));
      const sheetCodes = new Set(entries.map((e) => e.code));
      for (const code of existingCodes) {
        if (!sheetCodes.has(code)) deleted++;
      }
      await tx.delete(productsTable).where(eq(productsTable.ownerPhone, ownerPhone));
      if (entries.length > 0) {
        await tx
          .insert(productsTable)
          .values(entries.map((e) => ({ ...e, ownerPhone })));
      }
      for (const e of entries) {
        if (existingCodes.has(e.code)) updated++;
        else inserted++;
      }
    });
  } catch (err) {
    await db
      .update(productSyncConfigTable)
      .set({
        lastSyncedAt: syncedAt,
        lastSyncStatus: "error",
        lastSyncError: (err as Error)?.message?.slice(0, 500) || "DB error",
        updatedAt: new Date(),
      })
      .where(eq(productSyncConfigTable.ownerPhone, ownerPhone));
    throw err;
  }
  await db
    .update(productSyncConfigTable)
    .set({
      lastSyncedAt: syncedAt,
      lastSyncStatus: "ok",
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(productSyncConfigTable.ownerPhone, ownerPhone));
  return {
    inserted,
    updated,
    deleted,
    syncedAt: syncedAt.toISOString(),
  };
}

// ---- Scheduler -----------------------------------------------------------

// One in-process tick per minute. For each config with auto-sync enabled,
// runs the sync if `now - lastSyncedAt >= intervalMinutes`. We dedupe by
// ownerPhone so a long-running sync can't be doubled-up by the next tick.
const inFlight = new Set<string>();

async function tickScheduler(): Promise<void> {
  let configs: ProductSyncConfig[];
  try {
    configs = await db
      .select()
      .from(productSyncConfigTable)
      .where(eq(productSyncConfigTable.autoSyncEnabled, true));
  } catch (err) {
    logger.error({ err }, "product sync scheduler: db read failed");
    return;
  }
  const now = Date.now();
  for (const cfg of configs) {
    const last = cfg.lastSyncedAt ? cfg.lastSyncedAt.getTime() : 0;
    const dueAt = last + cfg.intervalMinutes * 60_000;
    if (now < dueAt) continue;
    if (inFlight.has(cfg.ownerPhone)) continue;
    inFlight.add(cfg.ownerPhone);
    void (async () => {
      try {
        await runSyncForOwner(cfg.ownerPhone);
        logger.info(
          { ownerPhone: cfg.ownerPhone },
          "product sync scheduler: ok"
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, ownerPhone: cfg.ownerPhone },
          "product sync scheduler: failed"
        );
      } finally {
        inFlight.delete(cfg.ownerPhone);
      }
    })();
  }
}

let schedulerStarted = false;
export function startProductSyncScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // First tick after 60s to give the server time to fully boot.
  setTimeout(() => {
    void tickScheduler();
    setInterval(() => void tickScheduler(), 60_000);
  }, 60_000);
  logger.info("product sync scheduler started");
}

export default router;
