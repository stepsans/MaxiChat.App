import { and, eq, gt, isNull, lt } from "drizzle-orm";
import {
  db,
  dripCampaignQueueTable,
  onboardingChecklistTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { sendTransactionalEmail } from "./email";

// Email content per trigger type.
const DRIP_CONTENT: Record<
  string,
  {
    subject: string;
    body: (data: { name: string; companyName: string }) => string;
  }
> = {
  wa_not_connected_24h: {
    subject: "Butuh bantuan menghubungkan WhatsApp?",
    body: ({ name }) =>
      `Halo ${name},\n\nKami lihat WhatsApp Anda belum terhubung ke MaxiChat. Langkah ini penting agar bisa mulai terima dan balas pesan.\n\nButuh bantuan? Reply pesan ini atau klik: https://maxichat.app/channels\n\nTim MaxiChat`,
  },
  product_empty: {
    subject: "WhatsApp aktif! Langkah berikut: tambah produk",
    body: ({ name }) =>
      `Halo ${name},\n\nBagus, WhatsApp sudah terhubung! Sekarang tambahkan produk Anda agar AI bisa menjawab pertanyaan customer dengan akurat.\n\nTambah produk: https://maxichat.app/products\n\nTim MaxiChat`,
  },
  no_message_3d: {
    subject: "Coba kirim pesan test ke nomor Anda sendiri",
    body: ({ name }) =>
      `Halo ${name},\n\nSemua sudah siap di MaxiChat! Coba kirim pesan WhatsApp ke nomor bisnis Anda, lalu lihat bagaimana AI merespons.\n\nLihat panduan: https://maxichat.app/chats\n\nTim MaxiChat`,
  },
  trial_expiring_2d: {
    subject: "Trial MaxiChat berakhir 2 hari lagi",
    body: ({ name, companyName }) =>
      `Halo ${name} dari ${companyName || "tim Anda"},\n\nTrial MaxiChat Anda berakhir 2 hari lagi. Jangan sampai kehilangan akses ke semua percakapan dan data yang sudah terkumpul.\n\nLihat paket harga: https://maxichat.app/billing\n\nTim MaxiChat`,
  },
  trial_expired: {
    subject: "Akun MaxiChat Anda dalam mode baca-saja",
    body: ({ name }) =>
      `Halo ${name},\n\nTrial Anda sudah berakhir. Data Anda aman dan tersimpan selama 180 hari. Aktifkan kembali kapan saja untuk lanjutkan.\n\nAktifkan sekarang: https://maxichat.app/billing\n\nTim MaxiChat`,
  },
  high_engagement: {
    subject: "Anda sudah siap upgrade MaxiChat!",
    body: ({ name }) =>
      `Halo ${name},\n\nTim kami melihat Anda aktif menggunakan MaxiChat — bagus sekali! Ingin unlock fitur lebih seperti lebih banyak channel dan anggota tim?\n\nLihat paket: https://maxichat.app/billing\n\nTim MaxiChat`,
  },
};

// Enqueue a drip message, idempotent via dedupeKey.
export async function enqueueDrip(
  ownerUserId: number,
  triggerType: string,
  scheduledAt: Date,
  trialStartDate: string // format: YYYY-MM-DD
): Promise<void> {
  const dedupeKey = `${ownerUserId}:${triggerType}:${trialStartDate}`;

  const [existing] = await db
    .select({ id: dripCampaignQueueTable.id })
    .from(dripCampaignQueueTable)
    .where(eq(dripCampaignQueueTable.dedupeKey, dedupeKey))
    .limit(1);

  if (existing) return; // Already enqueued, skip.

  await db.insert(dripCampaignQueueTable).values({
    ownerUserId,
    triggerType,
    scheduledAt,
    dedupeKey,
    status: "pending",
    channel: "email",
  });
}

// Send all scheduled, un-sent drips. Called by the scheduler every 5 minutes.
export async function processDripQueue(): Promise<void> {
  const now = new Date();

  const pending = await db
    .select()
    .from(dripCampaignQueueTable)
    .where(
      and(
        eq(dripCampaignQueueTable.status, "pending"),
        lt(dripCampaignQueueTable.scheduledAt, now)
      )
    )
    .limit(50); // Max 50 per tick.

  for (const item of pending) {
    try {
      const [owner] = await db
        .select({
          email: usersTable.email,
          name: usersTable.name,
          companyName: usersTable.companyName,
        })
        .from(usersTable)
        .where(eq(usersTable.id, item.ownerUserId))
        .limit(1);

      if (!owner) {
        await db
          .update(dripCampaignQueueTable)
          .set({ status: "skipped" })
          .where(eq(dripCampaignQueueTable.id, item.id));
        continue;
      }

      // Smart skip: is the condition still relevant?
      const shouldSkip = await checkShouldSkipDrip(
        item.ownerUserId,
        item.triggerType
      );
      if (shouldSkip) {
        await db
          .update(dripCampaignQueueTable)
          .set({ status: "skipped" })
          .where(eq(dripCampaignQueueTable.id, item.id));
        continue;
      }

      const content = DRIP_CONTENT[item.triggerType];
      if (!content) {
        logger.warn(
          { triggerType: item.triggerType },
          "Unknown drip trigger type"
        );
        await db
          .update(dripCampaignQueueTable)
          .set({ status: "skipped" })
          .where(eq(dripCampaignQueueTable.id, item.id));
        continue;
      }

      const name = owner.name ?? owner.email.split("@")[0];
      const companyName = owner.companyName ?? "tim Anda";

      await sendTransactionalEmail({
        to: owner.email,
        subject: content.subject,
        text: content.body({ name, companyName }),
      });

      await db
        .update(dripCampaignQueueTable)
        .set({ status: "sent", sentAt: now })
        .where(eq(dripCampaignQueueTable.id, item.id));

      logger.info(
        { ownerUserId: item.ownerUserId, triggerType: item.triggerType },
        "Drip email sent"
      );
    } catch (err) {
      logger.error({ err, dripId: item.id }, "Drip email failed");
      await db
        .update(dripCampaignQueueTable)
        .set({ status: "failed", errorMessage: String(err) })
        .where(eq(dripCampaignQueueTable.id, item.id));
    }
  }
}

// Whether this drip is still relevant or already resolved by the user.
// Returns true = skip sending.
async function checkShouldSkipDrip(
  ownerUserId: number,
  triggerType: string
): Promise<boolean> {
  const [checklist] = await db
    .select()
    .from(onboardingChecklistTable)
    .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
    .limit(1);

  if (!checklist) return false;

  switch (triggerType) {
    case "wa_not_connected_24h":
      return checklist.waConnected;
    case "product_empty":
      return checklist.productAdded;
    case "no_message_3d":
      return !!checklist.firstMessageAt;
    case "high_engagement":
      return checklist.healthScore < 70;
    default:
      return false;
  }
}

// Evaluate every active-trial tenant and enqueue any needed drips.
// Called every 15 minutes by the scheduler.
export async function evaluateDripTriggers(): Promise<void> {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  const trialOwners = await db
    .select({
      userId: usersTable.id,
      createdAt: usersTable.createdAt,
      periodEnd: subscriptionsTable.currentPeriodEnd,
    })
    .from(usersTable)
    .innerJoin(
      subscriptionsTable,
      and(
        eq(subscriptionsTable.userId, usersTable.id),
        eq(subscriptionsTable.status, "trial")
      )
    )
    .where(
      and(
        isNull(usersTable.parentUserId),
        gt(subscriptionsTable.currentPeriodEnd, now)
      )
    );

  for (const owner of trialOwners) {
    const trialStartDate = owner.createdAt.toISOString().slice(0, 10);

    const [checklist] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, owner.userId))
      .limit(1);

    // Trigger 1: WA not connected 24h after signup.
    if (owner.createdAt < oneDayAgo && (!checklist || !checklist.waConnected)) {
      await enqueueDrip(
        owner.userId,
        "wa_not_connected_24h",
        now,
        trialStartDate
      );
    }

    // Trigger 2: WA connected but no products yet.
    if (checklist?.waConnected && !checklist.productAdded) {
      await enqueueDrip(owner.userId, "product_empty", now, trialStartDate);
    }

    // Trigger 3: no messages at all for 3 days.
    if (
      owner.createdAt < threeDaysAgo &&
      (!checklist || !checklist.firstMessageAt)
    ) {
      await enqueueDrip(owner.userId, "no_message_3d", now, trialStartDate);
    }

    // Trigger 4: trial expiring in 2 days.
    if (
      owner.periodEnd &&
      owner.periodEnd < twoDaysFromNow &&
      owner.periodEnd > now
    ) {
      await enqueueDrip(owner.userId, "trial_expiring_2d", now, trialStartDate);
    }

    // Trigger 5: high engagement — offer an upgrade early.
    if (checklist && checklist.healthScore >= 70) {
      await enqueueDrip(owner.userId, "high_engagement", now, trialStartDate);
    }
  }
}

let dripSchedulerStarted = false;

export function startDripScheduler(): void {
  if (dripSchedulerStarted) return;
  dripSchedulerStarted = true;
  // Guard each tick so a transient DB error (e.g. a dropped connection) is
  // logged instead of bubbling up as an unhandledRejection that exits the
  // whole process (crash loop in prod).
  const safeEvaluate = () =>
    evaluateDripTriggers().catch((err: unknown) => {
      logger.error({ err }, "drip evaluateDripTriggers tick failed");
    });
  const safeProcess = () =>
    processDripQueue().catch((err: unknown) => {
      logger.error({ err }, "drip processDripQueue tick failed");
    });
  // Evaluate triggers every 15 minutes.
  setTimeout(() => {
    void safeEvaluate();
    setInterval(() => void safeEvaluate(), 15 * 60_000);
  }, 2 * 60_000); // Start 2 minutes after boot.
  // Process the queue every 5 minutes.
  setTimeout(() => {
    void safeProcess();
    setInterval(() => void safeProcess(), 5 * 60_000);
  }, 3 * 60_000); // Start 3 minutes after boot.
  logger.info("Drip campaign scheduler started");
}
