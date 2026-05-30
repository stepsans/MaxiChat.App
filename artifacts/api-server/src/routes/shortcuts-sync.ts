import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { google } from "googleapis";
import { z } from "zod";
import {
  db,
  textShortcutsTable,
  shortcutSyncConfigTable,
  credentialsTable,
  type ShortcutSyncConfig,
  type Credential,
} from "@workspace/db";
import { getCurrentOwnerPhone } from "./whatsapp";
import { getAuthorizedOAuthClient } from "./credentials";
import { logger } from "../lib/logger";

const router = Router();

const ALLOWED_INTERVALS = new Set([5, 15, 30, 60]);

function publicConfig(row: ShortcutSyncConfig) {
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
    const userId = req.session.userId!;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.json({ config: null });
      return;
    }
    // Scope by BOTH userId and ownerPhone so a phone reassigned to a
    // different user cannot read the prior tenant's spreadsheet binding.
    const [row] = await db
      .select()
      .from(shortcutSyncConfigTable)
      .where(
        and(
          eq(shortcutSyncConfigTable.userId, userId),
          eq(shortcutSyncConfigTable.ownerPhone, ownerPhone)
        )
      )
      .limit(1);
    res.json({ config: row ? publicConfig(row) : null });
  } catch (err) {
    req.log.error({ err }, "get shortcut sync config failed");
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
    if (req.body === null) {
      await db
        .delete(shortcutSyncConfigTable)
        .where(
          and(
            eq(shortcutSyncConfigTable.userId, userId),
            eq(shortcutSyncConfigTable.ownerPhone, ownerPhone)
          )
        );
      res.json({ config: null });
      return;
    }
    const parsed = ConfigInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
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
      userId,
      credentialId: parsed.data.credentialId,
      spreadsheetId: parsed.data.spreadsheetId,
      sheetName: parsed.data.sheetName,
      headerRow: parsed.data.headerRow ?? 1,
      autoSyncEnabled: parsed.data.autoSyncEnabled ?? false,
      intervalMinutes: parsed.data.intervalMinutes ?? 15,
      updatedAt: new Date(),
    };
    const upserted = await db
      .insert(shortcutSyncConfigTable)
      .values(values)
      .onConflictDoUpdate({
        target: shortcutSyncConfigTable.ownerPhone,
        set: values,
      })
      .returning();
    res.json({ config: publicConfig(upserted[0]!) });
  } catch (err) {
    req.log.error({ err }, "upsert shortcut sync config failed");
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
    const result = await runShortcutSyncForOwner(ownerPhone);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err }, "manual shortcut sync failed");
    res.status(500).json({ error: (err as Error)?.message || "Sync gagal" });
  }
});

// ---- Sync engine ---------------------------------------------------------

type SyncResult = {
  inserted: number;
  updated: number;
  deleted: number;
  syncedAt: string;
};

interface ParsedShortcut {
  shortcut: string;
  replacement: string;
  link: string | null;
}

function normalizeHeader(s: string): string {
  return s.trim().toLowerCase();
}

// Sheet → shortcuts. Required headers: shortcut, replacement (case-insensitive).
// Header row is 1-indexed. Rows missing either field are skipped. If two rows
// share the same shortcut (case-insensitively), the last one wins — matches
// the manual-create unique constraint.
function rowsToShortcuts(
  rows: string[][],
  headerRow: number
): { entries: ParsedShortcut[]; skipped: number } {
  const headerIdx = Math.max(0, headerRow - 1);
  if (rows.length <= headerIdx) return { entries: [], skipped: 0 };
  const headers = (rows[headerIdx] ?? []).map((c) =>
    normalizeHeader((c ?? "").toString())
  );
  const shortcutIdx = headers.indexOf("shortcut");
  const replacementIdx = headers.indexOf("replacement");
  // "link" (col C) is optional. When present, the cell value becomes the image
  // URL sent as a photo (replacement = caption) when the shortcut is sent.
  const linkIdx = headers.indexOf("link");
  if (shortcutIdx === -1 || replacementIdx === -1) {
    throw new Error(
      "Header tab wajib: shortcut, replacement. Pastikan baris header benar."
    );
  }
  const map = new Map<string, ParsedShortcut>();
  let skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const shortcut = (r[shortcutIdx] ?? "").toString().trim();
    const replacement = (r[replacementIdx] ?? "").toString().replace(/\s+$/, "");
    const linkRaw =
      linkIdx === -1 ? "" : (r[linkIdx] ?? "").toString().trim();
    const link = linkRaw.length > 0 && linkRaw.length <= 2000 ? linkRaw : null;
    if (!shortcut && !replacement) continue;
    if (!shortcut || !replacement) {
      skipped++;
      continue;
    }
    if (shortcut.length > 64 || replacement.length > 4000) {
      skipped++;
      continue;
    }
    map.set(shortcut.toLowerCase(), { shortcut, replacement, link });
  }
  return { entries: Array.from(map.values()), skipped };
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

export async function runShortcutSyncForOwner(
  ownerPhone: string
): Promise<SyncResult> {
  const [cfg] = await db
    .select()
    .from(shortcutSyncConfigTable)
    .where(eq(shortcutSyncConfigTable.ownerPhone, ownerPhone))
    .limit(1);
  if (!cfg) throw new Error("Belum ada Google Sheet yang dipilih.");
  const { userWhatsappTable } = await import("@workspace/db");
  const [link] = await db
    .select({ userId: userWhatsappTable.userId })
    .from(userWhatsappTable)
    .where(eq(userWhatsappTable.ownerPhone, ownerPhone))
    .limit(1);
  if (!link) throw new Error("WhatsApp account tidak terhubung ke user.");
  if (cfg.userId == null || cfg.userId !== link.userId) {
    throw new Error("Sync config tidak konsisten dengan pemilik akun WhatsApp.");
  }
  const cred = await loadOwnedCredentialForUser(link.userId, cfg.credentialId);
  if (!cred) throw new Error("Credential tidak ditemukan atau bukan milik user ini.");
  if (cred.status !== "connected") {
    throw new Error("Credential belum terhubung ke Google. Reconnect dulu.");
  }
  let rows: string[][];
  try {
    const auth = await getAuthorizedOAuthClient(cred);
    const sheets = google.sheets({ version: "v4", auth });
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheetId,
      range: cfg.sheetName,
      valueRenderOption: "UNFORMATTED_VALUE",
    });
    rows = (resp.data.values ?? []).map((r) =>
      (r as unknown[]).map((c) => (c == null ? "" : String(c)))
    );
  } catch (err: unknown) {
    const e = err as {
      code?: number;
      response?: { status?: number; data?: { error?: { message?: string } } };
    };
    const status = e?.response?.status ?? e?.code;
    if (status === 401 || status === 403) {
      await db
        .update(credentialsTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(credentialsTable.id, cred.id));
      throw new Error(
        "Akses Google ditolak. Reconnect credential di halaman Credentials."
      );
    }
    if (status === 404) throw new Error("Spreadsheet atau tab tidak ditemukan.");
    throw new Error(
      e?.response?.data?.error?.message || (err as Error)?.message || "Sheets API error"
    );
  }
  const { entries } = rowsToShortcuts(rows, cfg.headerRow);

  // Atomic replace per owner. Identity = lower(shortcut) since the unique
  // index is per-owner case-insensitive.
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const syncedAt = new Date();
  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ shortcut: textShortcutsTable.shortcut })
        .from(textShortcutsTable)
        .where(eq(textShortcutsTable.userId, link.userId));
      const existingKeys = new Set(existing.map((r) => r.shortcut.toLowerCase()));
      const sheetKeys = new Set(entries.map((e) => e.shortcut.toLowerCase()));
      for (const k of existingKeys) {
        if (!sheetKeys.has(k)) deleted++;
      }
      await tx
        .delete(textShortcutsTable)
        .where(eq(textShortcutsTable.userId, link.userId));
      if (entries.length > 0) {
        await tx
          .insert(textShortcutsTable)
          .values(entries.map((e) => ({ ...e, userId: link.userId })));
      }
      for (const e of entries) {
        if (existingKeys.has(e.shortcut.toLowerCase())) updated++;
        else inserted++;
      }
    });
  } catch (err) {
    await db
      .update(shortcutSyncConfigTable)
      .set({
        lastSyncedAt: syncedAt,
        lastSyncStatus: "error",
        lastSyncError: (err as Error)?.message?.slice(0, 500) || "DB error",
        updatedAt: new Date(),
      })
      .where(eq(shortcutSyncConfigTable.ownerPhone, ownerPhone));
    throw err;
  }
  await db
    .update(shortcutSyncConfigTable)
    .set({
      lastSyncedAt: syncedAt,
      lastSyncStatus: "ok",
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(shortcutSyncConfigTable.ownerPhone, ownerPhone));
  return {
    inserted,
    updated,
    deleted,
    syncedAt: syncedAt.toISOString(),
  };
}

// ---- Scheduler -----------------------------------------------------------

const inFlight = new Set<string>();

async function tickScheduler(): Promise<void> {
  let configs: ShortcutSyncConfig[];
  try {
    configs = await db
      .select()
      .from(shortcutSyncConfigTable)
      .where(eq(shortcutSyncConfigTable.autoSyncEnabled, true));
  } catch (err) {
    logger.error({ err }, "shortcut sync scheduler: db read failed");
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
        await runShortcutSyncForOwner(cfg.ownerPhone);
        logger.info(
          { ownerPhone: cfg.ownerPhone },
          "shortcut sync scheduler: ok"
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, ownerPhone: cfg.ownerPhone },
          "shortcut sync scheduler: failed"
        );
      } finally {
        inFlight.delete(cfg.ownerPhone);
      }
    })();
  }
}

let schedulerStarted = false;
export function startShortcutSyncScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => {
    void tickScheduler();
    setInterval(() => void tickScheduler(), 60_000);
  }, 60_000);
  logger.info("shortcut sync scheduler started");
}

export default router;
