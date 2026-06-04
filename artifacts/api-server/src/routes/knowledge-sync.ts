import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { google } from "googleapis";
import { z } from "zod";
import {
  db,
  knowledgeTable,
  knowledgeTypesTable,
  knowledgeSyncConfigTable,
  credentialsTable,
  type KnowledgeSyncConfig,
  type Credential,
} from "@workspace/db";
import { getCurrentOwnerPhone } from "./whatsapp";
import { requireOwnerUserId } from "../lib/channel-context";
import { requireSuperAdmin } from "../lib/team-permissions";
import { getAuthorizedOAuthClient } from "./credentials";
import { ensureKnowledgeTypesSeed } from "./knowledge-types";
import { logger } from "../lib/logger";

const router = Router();

const ALLOWED_INTERVALS = new Set([5, 15, 30, 60]);
const VALUE_REGEX = /^[a-z0-9][a-z0-9_-]{0,30}$/;

function publicConfig(row: KnowledgeSyncConfig) {
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

function makeLabelFromValue(v: string): string {
  return v
    .split(/[-_]+/)
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

router.get("/sync-config", async (req, res): Promise<void> => {
  try {
    const userId = await requireOwnerUserId(req, res);
    if (userId == null) return;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.json({ config: null });
      return;
    }
    // Scope by BOTH userId and ownerPhone so a phone reassigned to a
    // different user cannot read the prior tenant's spreadsheet binding.
    const [row] = await db
      .select()
      .from(knowledgeSyncConfigTable)
      .where(
        and(
          eq(knowledgeSyncConfigTable.userId, userId),
          eq(knowledgeSyncConfigTable.ownerPhone, ownerPhone)
        )
      )
      .limit(1);
    res.json({ config: row ? publicConfig(row) : null });
  } catch (err) {
    req.log.error({ err }, "get knowledge sync config failed");
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

router.put("/sync-config", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const userId = await requireOwnerUserId(req, res);
    if (userId == null) return;
    const ownerPhone = await getCurrentOwnerPhone(userId);
    if (!ownerPhone) {
      res.status(503).json({ error: "Hubungkan WhatsApp dulu." });
      return;
    }
    if (req.body === null) {
      await db
        .delete(knowledgeSyncConfigTable)
        .where(
          and(
            eq(knowledgeSyncConfigTable.userId, userId),
            eq(knowledgeSyncConfigTable.ownerPhone, ownerPhone)
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
      .insert(knowledgeSyncConfigTable)
      .values(values)
      .onConflictDoUpdate({
        target: knowledgeSyncConfigTable.ownerPhone,
        set: values,
      })
      .returning();
    res.json({ config: publicConfig(upserted[0]!) });
  } catch (err) {
    req.log.error({ err }, "upsert knowledge sync config failed");
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
    const result = await runKnowledgeSyncForOwner(ownerPhone);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err }, "manual knowledge sync failed");
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

interface ParsedEntry {
  type: string;
  title: string;
  content: string;
}

function normalizeHeader(s: string): string {
  return s.trim().toLowerCase();
}

// Sheet → entries. Required headers: type, title, content (case-insensitive).
// Header row is 1-indexed. Blank rows skipped. Rows missing title or content
// are skipped silently. Unknown `type` values are kept verbatim if they match
// the slug regex (caller seeds missing types); otherwise coerced to "faq".
function rowsToEntries(
  rows: string[][],
  headerRow: number
): { entries: ParsedEntry[]; skipped: number } {
  const headerIdx = Math.max(0, headerRow - 1);
  if (rows.length <= headerIdx) return { entries: [], skipped: 0 };
  const headers = (rows[headerIdx] ?? []).map((c) =>
    normalizeHeader((c ?? "").toString())
  );
  const typeIdx = headers.indexOf("type");
  const titleIdx = headers.indexOf("title");
  const contentIdx = headers.indexOf("content");
  if (typeIdx === -1 || titleIdx === -1 || contentIdx === -1) {
    throw new Error(
      "Header tab wajib: type, title, content. Pastikan baris header benar."
    );
  }
  const entries: ParsedEntry[] = [];
  let skipped = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const rawType = (r[typeIdx] ?? "").toString().trim().toLowerCase();
    const title = (r[titleIdx] ?? "").toString().trim();
    const content = (r[contentIdx] ?? "").toString().trim();
    if (!title && !content) continue;
    if (!title || !content) {
      skipped++;
      continue;
    }
    const type = VALUE_REGEX.test(rawType) ? rawType : "faq";
    entries.push({ type, title, content });
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

export async function runKnowledgeSyncForOwner(
  ownerPhone: string
): Promise<SyncResult> {
  const [cfg] = await db
    .select()
    .from(knowledgeSyncConfigTable)
    .where(eq(knowledgeSyncConfigTable.ownerPhone, ownerPhone))
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
  const { entries } = rowsToEntries(rows, cfg.headerRow);

  // Ensure default types exist before checking which types the sheet introduces.
  await ensureKnowledgeTypesSeed(ownerPhone);
  const existingTypeRows = await db
    .select({ value: knowledgeTypesTable.value })
    .from(knowledgeTypesTable)
    .where(eq(knowledgeTypesTable.ownerPhone, ownerPhone));
  const validTypes = new Set(existingTypeRows.map((r) => r.value));
  const newTypes = new Set<string>();
  for (const e of entries) {
    if (!validTypes.has(e.type)) newTypes.add(e.type);
  }

  // Atomic replace per owner. We use (type+title) as the identity for
  // insert/update accounting since knowledge_entries has no natural unique key.
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const syncedAt = new Date();
  try {
    await db.transaction(async (tx) => {
      if (newTypes.size > 0) {
        await tx
          .insert(knowledgeTypesTable)
          .values(
            Array.from(newTypes).map((v) => ({
              ownerPhone,
              value: v,
              label: makeLabelFromValue(v),
            }))
          )
          .onConflictDoNothing();
      }
      const existing = await tx
        .select({ type: knowledgeTable.type, title: knowledgeTable.title })
        .from(knowledgeTable)
        .where(eq(knowledgeTable.userId, cfg.userId));
      const existingKeys = new Set(existing.map((r) => `${r.type}\u0000${r.title}`));
      const sheetKeys = new Set(entries.map((e) => `${e.type}\u0000${e.title}`));
      for (const k of existingKeys) {
        if (!sheetKeys.has(k)) deleted++;
      }
      await tx
        .delete(knowledgeTable)
        .where(eq(knowledgeTable.userId, cfg.userId));
      if (entries.length > 0) {
        await tx
          .insert(knowledgeTable)
          .values(entries.map((e) => ({ ...e, userId: cfg.userId })));
      }
      for (const e of entries) {
        const k = `${e.type}\u0000${e.title}`;
        if (existingKeys.has(k)) updated++;
        else inserted++;
      }
    });
  } catch (err) {
    await db
      .update(knowledgeSyncConfigTable)
      .set({
        lastSyncedAt: syncedAt,
        lastSyncStatus: "error",
        lastSyncError: (err as Error)?.message?.slice(0, 500) || "DB error",
        updatedAt: new Date(),
      })
      .where(eq(knowledgeSyncConfigTable.ownerPhone, ownerPhone));
    throw err;
  }
  await db
    .update(knowledgeSyncConfigTable)
    .set({
      lastSyncedAt: syncedAt,
      lastSyncStatus: "ok",
      lastSyncError: null,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeSyncConfigTable.ownerPhone, ownerPhone));
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
  let configs: KnowledgeSyncConfig[];
  try {
    configs = await db
      .select()
      .from(knowledgeSyncConfigTable)
      .where(eq(knowledgeSyncConfigTable.autoSyncEnabled, true));
  } catch (err) {
    logger.error({ err }, "knowledge sync scheduler: db read failed");
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
        await runKnowledgeSyncForOwner(cfg.ownerPhone);
        logger.info(
          { ownerPhone: cfg.ownerPhone },
          "knowledge sync scheduler: ok"
        );
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, ownerPhone: cfg.ownerPhone },
          "knowledge sync scheduler: failed"
        );
      } finally {
        inFlight.delete(cfg.ownerPhone);
      }
    })();
  }
}

let schedulerStarted = false;
export function startKnowledgeSyncScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => {
    void tickScheduler();
    setInterval(() => void tickScheduler(), 60_000);
  }, 60_000);
  logger.info("knowledge sync scheduler started");
}

export default router;
