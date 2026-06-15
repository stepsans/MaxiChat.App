import { eq } from "drizzle-orm";
import { db, acrJobsTable } from "@workspace/db";
import { generateAndStoreJobPdf, sendAutoScheduleNotifications } from "./acr-engine";
import { sendScheduledPdfWa } from "./acr-wa-sender";
import { logger } from "./logger";

// Shared post-run delivery (v2.6). Runs the resolved actions stored on a job —
// in-app notification, PDF generation, and (opt-in) WhatsApp PDF delivery — for
// BOTH manual and scheduled reports, so both behave identically.
//
// The super admin (owner) is always a recipient; extra recipients come from the
// job's notify_user_ids (resolved at creation from the request or global
// defaults). Every step is best-effort: a failure is logged and never blocks
// the others or fails the job.
export async function deliverJobOutputs(jobId: string): Promise<void> {
  const job = await db.query.acrJobsTable.findFirst({ where: eq(acrJobsTable.id, jobId) });
  if (!job) return;
  const ownerUserId = job.ownerUserId;
  // Super admin always notified; merge with the extra recipients.
  const recipients = [...new Set([ownerUserId, ...(job.notifyUserIds ?? [])])];

  if (job.generatePdf) {
    try {
      await generateAndStoreJobPdf(jobId);
    } catch (err) {
      logger.error({ err, jobId }, "[acr-deliver] PDF generation failed");
    }
  }
  if (job.sendWhatsappPdf && recipients.length > 0) {
    try {
      await sendScheduledPdfWa(ownerUserId, jobId, recipients);
    } catch (err) {
      logger.error({ err, jobId }, "[acr-deliver] WhatsApp PDF delivery failed");
    }
  }
  try {
    await sendAutoScheduleNotifications(jobId, ownerUserId, recipients);
  } catch (err) {
    logger.error({ err, jobId }, "[acr-deliver] in-app notification failed");
  }
}
