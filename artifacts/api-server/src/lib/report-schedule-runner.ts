import { db } from "@workspace/db";
import { reportSchedulesTable, reportScheduleLogsTable, type ReportScheduleRow } from "@workspace/db";
import { and, eq, lte, isNotNull } from "drizzle-orm";
import { sendEmail } from "./email";
import { buildReportContent } from "./report-content-builder";
import { calculateNextScheduledAt, type ReportFrequency } from "./report-schedule-build";
import { logger } from "./logger";

// ===========================================================================
// Report-schedule poller — sends due scheduled reports via email, mirroring the
// ACR poller's safety pattern (in-flight guard; advance next_scheduled_at
// BEFORE sending so a crash never re-fires the same slot).
// ===========================================================================

let schedulerStarted = false;
let inFlight = false;

/**
 * Build + send a report to every recipient and record the attempt. Returns
 * true if at least one recipient was delivered. Best-effort: a per-recipient
 * failure is captured in the log row, not thrown.
 */
export async function sendScheduledReport(
  schedule: ReportScheduleRow,
  triggeredBy: "scheduler" | "manual",
): Promise<boolean> {
  const now = new Date();
  const recipients = schedule.recipientEmails ?? [];

  let content;
  try {
    content = await buildReportContent({
      ownerUserId: schedule.ownerUserId,
      scheduleName: schedule.name,
      contentTypes: schedule.contentTypes ?? [],
      frequency: schedule.frequency as ReportFrequency,
      now,
    });
  } catch (err) {
    await recordLog(schedule, triggeredBy, "failed", recipients, `Gagal menyusun laporan: ${String(err)}`);
    await markSchedule(schedule.id, "failed", String(err), now);
    return false;
  }

  const errors: string[] = [];
  let sent = 0;
  for (const to of recipients) {
    try {
      await sendEmail({ to, subject: content.subject, text: content.text, html: content.html });
      sent++;
    } catch (err) {
      errors.push(`${to}: ${String(err)}`);
    }
  }

  const ok = sent > 0 && errors.length === 0;
  const status = ok ? "sent" : sent > 0 ? "failed" : "failed";
  const errMsg = errors.length ? errors.join("; ") : null;
  await recordLog(schedule, triggeredBy, sent > 0 && !errors.length ? "sent" : "failed", recipients, errMsg);
  await markSchedule(schedule.id, status, errMsg, sent > 0 ? now : null);
  return ok;
}

async function recordLog(
  schedule: ReportScheduleRow,
  triggeredBy: "scheduler" | "manual",
  status: "sent" | "failed",
  recipients: string[],
  errorMessage: string | null,
): Promise<void> {
  await db.insert(reportScheduleLogsTable).values({
    scheduleId: schedule.id,
    ownerUserId: schedule.ownerUserId,
    triggeredBy,
    status,
    recipientEmails: recipients,
    errorMessage,
    sentAt: status === "sent" ? new Date() : null,
  });
}

async function markSchedule(
  id: number,
  status: string,
  error: string | null,
  sentAt: Date | null,
): Promise<void> {
  await db
    .update(reportSchedulesTable)
    .set({
      lastSendStatus: status,
      lastSendError: error,
      ...(sentAt ? { lastSentAt: sentAt } : {}),
    })
    .where(eq(reportSchedulesTable.id, id));
}

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const now = new Date();
    const due = await db
      .select()
      .from(reportSchedulesTable)
      .where(
        and(
          eq(reportSchedulesTable.isActive, true),
          isNotNull(reportSchedulesTable.nextScheduledAt),
          lte(reportSchedulesTable.nextScheduledAt, now),
        ),
      );

    for (const schedule of due) {
      try {
        // Advance the next slot FIRST so a crash mid-send never re-fires it.
        const next = calculateNextScheduledAt(
          {
            frequency: schedule.frequency as ReportFrequency,
            sendTime: schedule.sendTime,
            recurrenceDays: schedule.recurrenceDays,
            timezone: schedule.timezone,
          },
          now,
        );
        await db
          .update(reportSchedulesTable)
          .set({
            nextScheduledAt: next,
            // A 'once' schedule (next === null) deactivates after this fire.
            ...(next === null ? { isActive: false } : {}),
          })
          .where(eq(reportSchedulesTable.id, schedule.id));

        await sendScheduledReport(schedule, "scheduler");
      } catch (err) {
        logger.error({ err, scheduleId: schedule.id }, "report schedule send failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "report-schedule poller tick failed");
  } finally {
    inFlight = false;
  }
}

export function startReportSchedulePoller(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  // First tick after 60s to let the server fully boot.
  setTimeout(() => {
    void tick();
    setInterval(() => void tick(), 60_000);
  }, 60_000);
  logger.info("report-schedule poller started");
}
