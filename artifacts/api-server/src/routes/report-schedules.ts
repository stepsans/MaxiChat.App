// Report-schedule CRUD + send-now + delivery logs (Laporan & Jadwal, spec 9.6).
// Owner-scoped; chains requirePermission("analytics", action).

import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  reportSchedulesTable,
  reportScheduleLogsTable,
  type ReportScheduleRow,
  type ReportScheduleLogRow,
} from "@workspace/db";
import { CreateReportScheduleBody, UpdateReportScheduleBody, ToggleReportScheduleBody } from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requirePermission } from "../lib/role-permissions";
import { validateScheduleInput, calculateNextScheduledAt, type ReportFrequency } from "../lib/report-schedule-build";
import { sendScheduledReport } from "../lib/report-schedule-runner";
import { logger } from "../lib/logger";

const router: Router = Router();

async function owner(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

function serialize(s: ReportScheduleRow): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    contentTypes: s.contentTypes ?? [],
    frequency: s.frequency,
    recurrenceDays: s.recurrenceDays ?? null,
    sendTime: s.sendTime,
    timezone: s.timezone,
    recipientEmails: s.recipientEmails ?? [],
    isActive: s.isActive,
    lastSentAt: s.lastSentAt ? s.lastSentAt.toISOString() : null,
    lastSendStatus: s.lastSendStatus ?? null,
    lastSendError: s.lastSendError ?? null,
    nextScheduledAt: s.nextScheduledAt ? s.nextScheduledAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}

function serializeLog(l: ReportScheduleLogRow & { scheduleName?: string }): Record<string, unknown> {
  return {
    id: l.id,
    scheduleId: l.scheduleId,
    scheduleName: l.scheduleName ?? null,
    triggeredBy: l.triggeredBy,
    status: l.status,
    recipientEmails: l.recipientEmails ?? [],
    errorMessage: l.errorMessage ?? null,
    sentAt: l.sentAt ? l.sentAt.toISOString() : null,
    createdAt: l.createdAt.toISOString(),
  };
}

const view = requirePermission("analytics", "view");
const create = requirePermission("analytics", "create");
const edit = requirePermission("analytics", "edit");
const del = requirePermission("analytics", "delete");

async function findOwned(ownerUserId: number, id: number): Promise<ReportScheduleRow | null> {
  const rows = await db
    .select()
    .from(reportSchedulesTable)
    .where(and(eq(reportSchedulesTable.id, id), eq(reportSchedulesTable.ownerUserId, ownerUserId)))
    .limit(1);
  return rows[0] ?? null;
}

router.get("/", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const rows = await db
      .select()
      .from(reportSchedulesTable)
      .where(eq(reportSchedulesTable.ownerUserId, ownerUserId))
      .orderBy(desc(reportSchedulesTable.createdAt));
    res.json(rows.map(serialize));
  } catch (err) {
    logger.error({ err }, "list report schedules failed");
    res.status(500).json({ error: "Gagal memuat jadwal" });
  }
});

router.post("/", create, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const parsed = CreateReportScheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const b = parsed.data;
    const verr = validateScheduleInput({
      name: b.name,
      contentTypes: b.contentTypes,
      frequency: b.frequency,
      recurrenceDays: b.recurrenceDays,
      sendTime: b.sendTime,
      recipientEmails: b.recipientEmails,
    });
    if (verr) {
      res.status(400).json({ error: verr.message, field: verr.field });
      return;
    }

    const frequency = b.frequency as ReportFrequency;
    const sendTime = b.sendTime || "07:00";
    const timezone = b.timezone || "Asia/Jakarta";
    const recurrenceDays = b.recurrenceDays ?? null;
    const nextScheduledAt = calculateNextScheduledAt({ frequency, sendTime, recurrenceDays, timezone });

    const [row] = await db
      .insert(reportSchedulesTable)
      .values({
        ownerUserId,
        name: b.name.trim(),
        contentTypes: b.contentTypes,
        frequency,
        recurrenceDays,
        sendTime,
        timezone,
        recipientEmails: b.recipientEmails,
        isActive: b.isActive ?? true,
        nextScheduledAt,
      })
      .returning();

    // A one-time ("sekali kirim") schedule fires immediately in the background
    // and then deactivates.
    if (frequency === "once") {
      void sendScheduledReport(row, "manual")
        .then(() => db.update(reportSchedulesTable).set({ isActive: false }).where(eq(reportSchedulesTable.id, row.id)))
        .catch((err) => logger.error({ err, scheduleId: row.id }, "one-time report send failed"));
    }

    res.status(201).json(serialize(row));
  } catch (err) {
    logger.error({ err }, "create report schedule failed");
    res.status(500).json({ error: "Gagal membuat jadwal" });
  }
});

router.get("/:id", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const row = await findOwned(ownerUserId, Number(req.params.id));
    if (!row) {
      res.status(404).json({ error: "Jadwal tidak ditemukan" });
      return;
    }
    res.json(serialize(row));
  } catch (err) {
    logger.error({ err }, "get report schedule failed");
    res.status(500).json({ error: "Gagal memuat jadwal" });
  }
});

router.put("/:id", edit, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const existing = await findOwned(ownerUserId, Number(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan" });
      return;
    }
    const parsed = UpdateReportScheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const b = parsed.data;
    const verr = validateScheduleInput({
      name: b.name,
      contentTypes: b.contentTypes,
      frequency: b.frequency,
      recurrenceDays: b.recurrenceDays,
      sendTime: b.sendTime,
      recipientEmails: b.recipientEmails,
    });
    if (verr) {
      res.status(400).json({ error: verr.message, field: verr.field });
      return;
    }

    const frequency = b.frequency as ReportFrequency;
    const sendTime = b.sendTime || "07:00";
    const timezone = b.timezone || "Asia/Jakarta";
    const recurrenceDays = b.recurrenceDays ?? null;
    const nextScheduledAt = calculateNextScheduledAt({ frequency, sendTime, recurrenceDays, timezone });

    const [row] = await db
      .update(reportSchedulesTable)
      .set({
        name: b.name.trim(),
        contentTypes: b.contentTypes,
        frequency,
        recurrenceDays,
        sendTime,
        timezone,
        recipientEmails: b.recipientEmails,
        isActive: b.isActive ?? existing.isActive,
        nextScheduledAt,
      })
      .where(eq(reportSchedulesTable.id, existing.id))
      .returning();
    res.json(serialize(row));
  } catch (err) {
    logger.error({ err }, "update report schedule failed");
    res.status(500).json({ error: "Gagal memperbarui jadwal" });
  }
});

router.delete("/:id", del, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const existing = await findOwned(ownerUserId, Number(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan" });
      return;
    }
    await db.delete(reportSchedulesTable).where(eq(reportSchedulesTable.id, existing.id));
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "delete report schedule failed");
    res.status(500).json({ error: "Gagal menghapus jadwal" });
  }
});

router.patch("/:id/toggle", edit, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const existing = await findOwned(ownerUserId, Number(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan" });
      return;
    }
    const parsed = ToggleReportScheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body" });
      return;
    }
    const isActive = parsed.data.isActive;
    // Re-arm next run when re-activating a recurring schedule.
    const next =
      isActive && existing.frequency !== "once"
        ? calculateNextScheduledAt({
            frequency: existing.frequency as ReportFrequency,
            sendTime: existing.sendTime,
            recurrenceDays: existing.recurrenceDays,
            timezone: existing.timezone,
          })
        : existing.nextScheduledAt;
    const [row] = await db
      .update(reportSchedulesTable)
      .set({ isActive, nextScheduledAt: next })
      .where(eq(reportSchedulesTable.id, existing.id))
      .returning();
    res.json(serialize(row));
  } catch (err) {
    logger.error({ err }, "toggle report schedule failed");
    res.status(500).json({ error: "Gagal mengubah status jadwal" });
  }
});

router.post("/:id/send-now", edit, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const existing = await findOwned(ownerUserId, Number(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan" });
      return;
    }
    // Fire in the background so the request returns immediately.
    void sendScheduledReport(existing, "manual").catch((err) =>
      logger.error({ err, scheduleId: existing.id }, "manual report send failed"),
    );
    res.status(202).json({ ok: true });
  } catch (err) {
    logger.error({ err }, "send-now report schedule failed");
    res.status(500).json({ error: "Gagal memulai pengiriman" });
  }
});

router.get("/:id/logs", view, async (req, res): Promise<void> => {
  try {
    const ownerUserId = await owner(req, res);
    if (ownerUserId == null) return;
    const existing = await findOwned(ownerUserId, Number(req.params.id));
    if (!existing) {
      res.status(404).json({ error: "Jadwal tidak ditemukan" });
      return;
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const rows = await db
      .select()
      .from(reportScheduleLogsTable)
      .where(eq(reportScheduleLogsTable.scheduleId, existing.id))
      .orderBy(desc(reportScheduleLogsTable.createdAt))
      .limit(limit);
    res.json(rows.map((l) => serializeLog({ ...l, scheduleName: existing.name })));
  } catch (err) {
    logger.error({ err }, "list report schedule logs failed");
    res.status(500).json({ error: "Gagal memuat riwayat pengiriman" });
  }
});

export default router;
