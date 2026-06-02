import { Router, type Request, type Response, type NextFunction } from "express";
import { and, eq, like, desc } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  aiReviewConfigTable,
  chatsTable,
  channelsTable,
  credentialsTable,
  type AiReviewConfig,
  type AiReviewColumn,
} from "@workspace/db";
import { resolveOwnerUserId } from "../lib/seed";
import { runAndRecord } from "../lib/ai-review";
import { requirePermission } from "../lib/role-permissions";

const router = Router();

// AI Review reads are gated by the per-role matrix (aiReview.view); writes
// (config create/update/delete/run) stay super-admin only because they touch
// Google credentials + AI billing. requireSuperAdmin asserts the signed-in
// user IS the tenant owner.
async function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.session.userId;
  if (userId == null) {
    res.status(401).json({ error: "not_signed_in" });
    return;
  }
  const ownerUserId = await resolveOwnerUserId(userId);
  if (ownerUserId !== userId) {
    res.status(403).json({ error: "Hanya super admin yang dapat mengatur AI Review" });
    return;
  }
  next();
}

// Read routes: gated by the matrix (super_admin always passes; others need
// aiReview.view granted explicitly).
const reviewView = requirePermission("aiReview", "view");

// Write routes: super_admin (tenant owner) only.
const reviewManage = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Forward async rejections (e.g. a DB error inside resolveOwnerUserId) to
  // Express's error handler instead of swallowing them and hanging the request.
  requireSuperAdmin(req, res, next).catch(next);
};

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function publicConfig(row: AiReviewConfig) {
  return {
    id: row.id,
    channelId: row.channelId,
    groupJid: row.groupJid,
    groupName: row.groupName,
    sheetCredentialId: row.sheetCredentialId,
    spreadsheetId: row.spreadsheetId,
    spreadsheetUrl: row.spreadsheetUrl ?? null,
    sheetTab: row.sheetTab,
    columns: (row.columns as AiReviewColumn[]) ?? [],
    driveCredentialId: row.driveCredentialId ?? null,
    driveFolderId: row.driveFolderId ?? null,
    driveFolderName: row.driveFolderName ?? null,
    scannerAi: row.scannerAi,
    scheduleTime: row.scheduleTime,
    timezone: row.timezone,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
    lastRunStatus: row.lastRunStatus as "idle" | "ok" | "error",
    lastRunError: row.lastRunError ?? null,
    lastRunCount: row.lastRunCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

// List WhatsApp groups across the owner's channels so the user can pick which
// group to recap. Groups are chats whose phone_number ends in @g.us.
router.get("/groups", reviewView, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const rows = await db
      .select({
        channelId: chatsTable.channelId,
        channelName: channelsTable.label,
        groupJid: chatsTable.phoneNumber,
        name: chatsTable.contactName,
        lastMessageAt: chatsTable.lastMessageAt,
      })
      .from(chatsTable)
      .innerJoin(channelsTable, eq(channelsTable.id, chatsTable.channelId))
      .where(
        and(
          eq(channelsTable.userId, ownerUserId),
          like(chatsTable.phoneNumber, "%@g.us")
        )
      )
      .orderBy(desc(chatsTable.lastMessageAt));
    res.json(
      rows.map((r) => ({
        channelId: r.channelId,
        channelName: r.channelName,
        groupJid: r.groupJid,
        name: r.name,
        lastMessageAt: r.lastMessageAt ? r.lastMessageAt.toISOString() : null,
      }))
    );
  } catch (err) {
    req.log.error({ err }, "ai-review list groups failed");
    res.status(500).json({ error: "Gagal memuat daftar grup" });
  }
});

router.get("/configs", reviewView, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const rows = await db
      .select()
      .from(aiReviewConfigTable)
      .where(eq(aiReviewConfigTable.userId, ownerUserId))
      .orderBy(desc(aiReviewConfigTable.updatedAt));
    res.json(rows.map(publicConfig));
  } catch (err) {
    req.log.error({ err }, "ai-review list configs failed");
    res.status(500).json({ error: "Gagal memuat konfigurasi AI Review" });
  }
});

const ColumnSchema = z.object({
  name: z.string().trim().min(1).max(100),
  hint: z.string().trim().max(300).optional(),
});

const ConfigInput = z.object({
  channelId: z.number().int().positive(),
  groupJid: z.string().min(1).endsWith("@g.us"),
  groupName: z.string().max(200).optional(),
  sheetCredentialId: z.number().int().positive(),
  spreadsheetId: z.string().min(1),
  spreadsheetUrl: z.string().max(2000).nullable().optional(),
  sheetTab: z.string().min(1).max(200),
  columns: z.array(ColumnSchema).min(1).max(50),
  driveCredentialId: z.number().int().positive().nullable().optional(),
  driveFolderId: z.string().max(200).nullable().optional(),
  driveFolderName: z.string().max(300).nullable().optional(),
  scannerAi: z.boolean().optional(),
  scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

// Confirm a channel belongs to the owner; returns its name or null.
async function ownedChannelName(
  ownerUserId: number,
  channelId: number
): Promise<string | null> {
  const [row] = await db
    .select({ name: channelsTable.label })
    .from(channelsTable)
    .where(and(eq(channelsTable.id, channelId), eq(channelsTable.userId, ownerUserId)))
    .limit(1);
  return row?.name ?? null;
}

async function ownsCredential(ownerUserId: number, credId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: credentialsTable.id })
    .from(credentialsTable)
    .where(and(eq(credentialsTable.id, credId), eq(credentialsTable.userId, ownerUserId)))
    .limit(1);
  return !!row;
}

router.post("/configs", reviewManage, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const parsed = ConfigInput.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const d = parsed.data;
    if (d.timezone && !isValidTimezone(d.timezone)) {
      res.status(400).json({ error: "Zona waktu tidak valid" });
      return;
    }
    const chName = await ownedChannelName(ownerUserId, d.channelId);
    if (chName == null) {
      res.status(404).json({ error: "Channel tidak ditemukan" });
      return;
    }
    if (!(await ownsCredential(ownerUserId, d.sheetCredentialId))) {
      res.status(404).json({ error: "Credential Sheets tidak ditemukan" });
      return;
    }
    if (
      d.driveCredentialId != null &&
      !(await ownsCredential(ownerUserId, d.driveCredentialId))
    ) {
      res.status(404).json({ error: "Credential Drive tidak ditemukan" });
      return;
    }
    if (d.driveFolderId && d.driveCredentialId == null) {
      res.status(400).json({
        error: "Pilih credential Drive dulu sebelum memilih folder Drive.",
      });
      return;
    }
    try {
      const [row] = await db
        .insert(aiReviewConfigTable)
        .values({
          userId: ownerUserId,
          channelId: d.channelId,
          groupJid: d.groupJid,
          groupName: d.groupName ?? "",
          sheetCredentialId: d.sheetCredentialId,
          spreadsheetId: d.spreadsheetId,
          spreadsheetUrl: d.spreadsheetUrl ?? null,
          sheetTab: d.sheetTab,
          columns: d.columns,
          driveCredentialId: d.driveCredentialId ?? null,
          driveFolderId: d.driveFolderId ?? null,
          driveFolderName: d.driveFolderName ?? null,
          scannerAi: d.scannerAi ?? false,
          scheduleTime: d.scheduleTime,
          timezone: d.timezone ?? "Asia/Jakarta",
          enabled: d.enabled ?? false,
          updatedAt: new Date(),
        })
        .returning();
      res.status(201).json(publicConfig(row!));
    } catch (err: unknown) {
      // Unique (channel_id, group_jid) violation → group already configured.
      if ((err as { code?: string })?.code === "23505") {
        res.status(409).json({ error: "Grup ini sudah punya konfigurasi AI Review." });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "ai-review create config failed");
    res.status(500).json({ error: "Gagal menyimpan konfigurasi" });
  }
});

const ConfigPatch = ConfigInput.partial();

router.patch("/configs/:id", reviewManage, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const [existing] = await db
      .select()
      .from(aiReviewConfigTable)
      .where(
        and(eq(aiReviewConfigTable.id, id), eq(aiReviewConfigTable.userId, ownerUserId))
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Konfigurasi tidak ditemukan" });
      return;
    }
    const parsed = ConfigPatch.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const d = parsed.data;
    if (d.timezone && !isValidTimezone(d.timezone)) {
      res.status(400).json({ error: "Zona waktu tidak valid" });
      return;
    }
    if (d.channelId != null && (await ownedChannelName(ownerUserId, d.channelId)) == null) {
      res.status(404).json({ error: "Channel tidak ditemukan" });
      return;
    }
    if (
      d.sheetCredentialId != null &&
      !(await ownsCredential(ownerUserId, d.sheetCredentialId))
    ) {
      res.status(404).json({ error: "Credential Sheets tidak ditemukan" });
      return;
    }
    if (
      d.driveCredentialId != null &&
      !(await ownsCredential(ownerUserId, d.driveCredentialId))
    ) {
      res.status(404).json({ error: "Credential Drive tidak ditemukan" });
      return;
    }
    // Validate the merged result, not just the patch, so clearing the Drive
    // credential while a folder stays set (or vice versa) is rejected.
    const effDriveCred =
      d.driveCredentialId !== undefined ? d.driveCredentialId : existing.driveCredentialId;
    const effDriveFolder =
      d.driveFolderId !== undefined ? d.driveFolderId : existing.driveFolderId;
    if (effDriveFolder && effDriveCred == null) {
      res.status(400).json({
        error: "Pilih credential Drive dulu sebelum memilih folder Drive.",
      });
      return;
    }
    const patch: Partial<typeof aiReviewConfigTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (d.channelId != null) patch.channelId = d.channelId;
    if (d.groupJid != null) patch.groupJid = d.groupJid;
    if (d.groupName != null) patch.groupName = d.groupName;
    if (d.sheetCredentialId != null) patch.sheetCredentialId = d.sheetCredentialId;
    if (d.spreadsheetId != null) patch.spreadsheetId = d.spreadsheetId;
    if (d.spreadsheetUrl !== undefined) patch.spreadsheetUrl = d.spreadsheetUrl;
    if (d.sheetTab != null) patch.sheetTab = d.sheetTab;
    if (d.columns != null) patch.columns = d.columns;
    if (d.driveCredentialId !== undefined) patch.driveCredentialId = d.driveCredentialId;
    if (d.driveFolderId !== undefined) patch.driveFolderId = d.driveFolderId;
    if (d.driveFolderName !== undefined) patch.driveFolderName = d.driveFolderName;
    if (d.scannerAi != null) patch.scannerAi = d.scannerAi;
    if (d.scheduleTime != null) patch.scheduleTime = d.scheduleTime;
    if (d.timezone != null) patch.timezone = d.timezone;
    if (d.enabled != null) patch.enabled = d.enabled;
    try {
      const [row] = await db
        .update(aiReviewConfigTable)
        .set(patch)
        .where(eq(aiReviewConfigTable.id, id))
        .returning();
      res.json(publicConfig(row!));
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === "23505") {
        res.status(409).json({ error: "Grup ini sudah punya konfigurasi AI Review." });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "ai-review update config failed");
    res.status(500).json({ error: "Gagal memperbarui konfigurasi" });
  }
});

router.delete("/configs/:id", reviewManage, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    await db
      .delete(aiReviewConfigTable)
      .where(
        and(eq(aiReviewConfigTable.id, id), eq(aiReviewConfigTable.userId, ownerUserId))
      );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "ai-review delete config failed");
    res.status(500).json({ error: "Gagal menghapus konfigurasi" });
  }
});

// Manual "Run now" — runs the recap immediately and records the outcome.
router.post("/configs/:id/run", reviewManage, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await resolveOwnerUserId(req.session.userId!);
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "id tidak valid" });
      return;
    }
    const [cfg] = await db
      .select()
      .from(aiReviewConfigTable)
      .where(
        and(eq(aiReviewConfigTable.id, id), eq(aiReviewConfigTable.userId, ownerUserId))
      )
      .limit(1);
    if (!cfg) {
      res.status(404).json({ error: "Konfigurasi tidak ditemukan" });
      return;
    }
    const result = await runAndRecord(cfg);
    res.json(result);
  } catch (err: unknown) {
    req.log.error({ err }, "ai-review manual run failed");
    res.status(500).json({ error: (err as Error)?.message || "Run gagal" });
  }
});

export default router;
