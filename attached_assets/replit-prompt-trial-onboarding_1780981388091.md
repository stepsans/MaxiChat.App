# REPLIT AGENT PROMPT
# MaxiChat — Trial System, OTP WhatsApp, Onboarding Checklist & Customer Health Score
# Copy seluruh isi dokumen ini dan paste ke Replit Agent

---

## KONTEKS SISTEM

Kamu sedang bekerja di codebase MaxiChat, sebuah multi-channel SaaS (WhatsApp + Telegram + AI Chatbot).

**Stack yang dipakai:**
- Backend: Express 5 + TypeScript di `artifacts/api-server/`
- Database schema: Drizzle ORM di `lib/db/src/schema/`
- Schema index: `lib/db/src/schema/index.ts` (semua tabel harus di-export di sini)
- Frontend web: React + Vite di `artifacts/whatsapp-ai/src/`
- Admin panel: React + Vite di `artifacts/admin/src/`

**Pattern wajib diikuti:**
- Semua tabel baru ditulis di `lib/db/src/schema/<nama>.ts` lalu di-export di `lib/db/src/schema/index.ts`
- Schema apply ke database dengan: `pnpm --filter @workspace/db run push` (jalankan dari terminal interaktif, bukan agent shell, karena drizzle-kit butuh TTY)
- Route baru ditulis di `artifacts/api-server/src/routes/<nama>.ts` lalu di-import dan di-mount di `artifacts/api-server/src/routes/index.ts`
- Semua uang dalam satuan Rupiah (integer, bukan desimal)
- Semua timestamp pakai `timestamp with time zone`
- Pakai Drizzle ORM untuk semua query DB — tidak boleh raw SQL kecuali advisory lock

---

## TUJUAN

Implementasi sistem berikut **tanpa mengubah fitur yang sudah ada**:

1. **Trial System Upgrade** — tracking onboarding progress + health score di tabel `users`
2. **Tabel OTP WhatsApp** — untuk verifikasi nomor WA saat signup
3. **Tabel Onboarding Checklist** — tracking per-tenant progress yang bisa dilihat CS team
4. **API routes OTP** — request OTP, verify OTP, resend OTP
5. **API routes Onboarding** — get progress, update step
6. **Customer Health Score** — kalkulasi otomatis dari data existing, tampil di admin panel
7. **Drip campaign engine** — behavior-based (bukan time-based), simpan queue di DB
8. **Admin: Grant Trial Override** — admin bisa beri trial baru untuk kasus khusus
9. **Signup form update** — tambah 2 pertanyaan routing (volume pesan + jumlah tim)
10. **Admin dashboard** — tambah tab "Trial Monitor" dengan health score semua tenant

---

## LANGKAH 1 — TAMBAH KOLOM KE TABEL USERS

**File: `lib/db/src/schema/auth.ts`**

Tambahkan kolom-kolom ini ke `usersTable` (tambahkan setelah kolom `isInfinityOwner` yang sudah ada):

```typescript
// === TRIAL & ONBOARDING FIELDS (tambahkan ke usersTable) ===

// Nomor WhatsApp yang dipakai saat OTP signup (format: 628xxx tanpa + atau spasi).
// Disimpan permanen sebagai fingerprint anti-abuse trial.
trialWhatsapp: text("trial_whatsapp"),

// Flag: apakah akun ini pernah menggunakan trial. Setelah trial digunakan
// (bahkan jika belum expired), flag ini true dan tidak bisa trial lagi
// kecuali admin override via trialGrantedBy.
trialUsed: boolean("trial_used").notNull().default(false),

// Jika admin manual override grant trial baru, catat siapa yang kasih dan kapan.
trialGrantedBy: integer("trial_granted_by"),  // FK ke users.id (admin)
trialGrantedAt: timestamp("trial_granted_at", { withTimezone: true }),

// Tahap onboarding saat ini. Nilai: 'wa_otp' | 'business_profile' | 'complete'
// Update otomatis saat user menyelesaikan langkah.
onboardingStep: text("onboarding_step").notNull().default("wa_otp"),

// Jawaban dari 2 pertanyaan routing saat signup:
// volume: 'lt50' | '50to200' | '200to500' | 'gt500'
businessVolume: text("business_volume"),
// teamSize: 'solo' | '2to5' | '6to20' | 'gt20'
businessTeamSize: text("business_team_size"),

// Kapan user pertama kali berhasil connect WhatsApp channel.
// Null = belum pernah connect.
firstWaConnectedAt: timestamp("first_wa_connected_at", { withTimezone: true }),
```

**PENTING:** Setelah edit file schema, jalankan di terminal (bukan agent shell):
```bash
pnpm --filter @workspace/db run push
```
Jika muncul prompt interaktif, jawab "Yes" / tekan Enter untuk konfirmasi.

---

## LANGKAH 2 — BUAT TABEL OTP WHATSAPP

**Buat file baru: `lib/db/src/schema/wa-otp.ts`**

```typescript
import {
  pgTable,
  serial,
  text,
  integer,
  timestamp,
  boolean,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Tabel untuk OTP verifikasi nomor WhatsApp.
// Dipakai saat: (1) signup baru — verifikasi nomor WA, (2) login WA (opsional masa depan).
// OTP TIDAK disimpan plaintext — disimpan sebagai SHA-256 hash.
// Satu nomor bisa punya beberapa baris (per request), tapi hanya
// baris terbaru yang valid (cek expires_at + verified_at IS NULL).
export const waOtpTable = pgTable(
  "wa_otp_requests",
  {
    id: serial("id").primaryKey(),

    // Nomor WA dalam format E.164 tanpa tanda +, contoh: 6281234567890
    phone: text("phone").notNull(),

    // SHA-256 hash dari 6-digit OTP. Jangan pernah simpan OTP plaintext.
    otpHash: text("otp_hash").notNull(),

    // Tujuan OTP ini dibuat. 'signup' = verifikasi saat daftar.
    purpose: text("purpose").notNull().default("signup"), // 'signup' | 'login'

    // Berapa kali user salah input OTP. Setelah >= 5, row ini dikunci
    // dan harus request OTP baru.
    attemptCount: integer("attempt_count").notNull().default(0),

    // Berapa kali user sudah resend OTP dalam satu sesi.
    // Maksimum 3 kali resend per nomor per jam.
    resendCount: integer("resend_count").notNull().default(0),

    // OTP expired setelah 5 menit dari created_at.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    // Diisi saat OTP berhasil diverifikasi. Row yang sudah verified
    // tidak bisa dipakai lagi (single-use).
    verifiedAt: timestamp("verified_at", { withTimezone: true }),

    // Opsional: FK ke user yang request OTP (jika sudah ada user row).
    // Null untuk signup flow (user belum ada saat request OTP).
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "cascade",
    }),

    // IP address pengirim request, untuk rate limiting tambahan.
    ipAddress: text("ip_address"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Index untuk lookup cepat berdasarkan nomor telepon (untuk cek rate limit)
    index("wa_otp_phone_idx").on(t.phone),
    // Index untuk lookup berdasarkan userId
    index("wa_otp_user_idx").on(t.userId),
  ]
);

export type WaOtpRow = typeof waOtpTable.$inferSelect;
```

---

## LANGKAH 3 — BUAT TABEL ONBOARDING CHECKLIST

**Buat file baru: `lib/db/src/schema/onboarding.ts`**

```typescript
import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Tracking checklist onboarding per tenant owner.
// Satu row per owner (uniqueIndex pada owner_user_id).
// CS team MaxiChat bisa lihat progress semua tenant dari admin panel.
export const onboardingChecklistTable = pgTable(
  "onboarding_checklists",
  {
    id: serial("id").primaryKey(),

    // FK ke owner user (parent_user_id IS NULL, team_role = 'super_admin')
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    // ── Checklist Items ──────────────────────────────────────────────
    // Setiap item: boolean (selesai/belum) + timestamp kapan diselesaikan.

    // 1. Hubungkan WhatsApp channel
    waConnected: boolean("wa_connected").notNull().default(false),
    waConnectedAt: timestamp("wa_connected_at", { withTimezone: true }),

    // 2. Tambahkan minimal 1 produk ke katalog
    productAdded: boolean("product_added").notNull().default(false),
    productAddedAt: timestamp("product_added_at", { withTimezone: true }),

    // 3. Tambahkan minimal 1 member tim (agent/supervisor)
    teamMemberAdded: boolean("team_member_added").notNull().default(false),
    teamMemberAddedAt: timestamp("team_member_added_at", { withTimezone: true }),

    // 4. Terima atau kirim minimal 1 pesan
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    // (boolean derivable: firstMessageAt IS NOT NULL)

    // 5. Coba fitur AI (AI pernah generate reply)
    aiTriedAt: timestamp("ai_tried_at", { withTimezone: true }),

    // 6. Buat atau aktifkan 1 chatbot flow
    flowActivated: boolean("flow_activated").notNull().default(false),
    flowActivatedAt: timestamp("flow_activated_at", { withTimezone: true }),

    // ── Health Score (0–100, dihitung ulang setiap kali checklist diupdate) ──
    // Kalkulasi: wa_connected=30, product_added=20, first_message=20,
    //            team_member_added=15, ai_tried=10, flow_activated=5
    healthScore: integer("health_score").notNull().default(0),

    // Risk level berdasarkan health score + hari trial berjalan.
    // 'low' = score >= 70, 'medium' = 40-69, 'high' = < 40
    riskLevel: text("risk_level").notNull().default("high"), // 'low'|'medium'|'high'

    // Kapan CS team MaxiChat terakhir kali follow-up tenant ini.
    lastCsFollowUpAt: timestamp("last_cs_follow_up_at", { withTimezone: true }),
    lastCsNote: text("last_cs_note"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Satu baris per owner
    uniqueIndex("onboarding_owner_unique").on(t.ownerUserId),
  ]
);

export type OnboardingChecklistRow =
  typeof onboardingChecklistTable.$inferSelect;
```

---

## LANGKAH 4 — BUAT TABEL DRIP CAMPAIGN QUEUE

**Buat file baru: `lib/db/src/schema/drip-campaign.ts`**

```typescript
import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Queue untuk behavior-based drip emails/WA messages selama trial.
// Trigger berdasarkan KONDISI (bukan hari), diproses oleh background job.
// Kondisi: 'wa_not_connected_24h' | 'product_empty' | 'no_message_3d' |
//          'trial_expiring_2d' | 'trial_expired' | 'high_engagement'
export const dripCampaignQueueTable = pgTable(
  "drip_campaign_queue",
  {
    id: serial("id").primaryKey(),

    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),

    // Jenis trigger yang memunculkan drip ini
    triggerType: text("trigger_type").notNull(),
    // 'wa_not_connected_24h' — WA belum connect 24 jam setelah signup
    // 'product_empty'        — WA connect tapi produk masih 0
    // 'no_message_3d'        — Ada produk tapi tidak ada pesan 3 hari
    // 'trial_expiring_2d'    — Trial berakhir 2 hari lagi
    // 'trial_expired'        — Trial baru saja expired
    // 'high_engagement'      — Score >= 70, tawarkan upgrade lebih awal

    // Kanal pengiriman: 'email' | 'whatsapp' (kirim via nomor WA owner)
    channel: text("channel").notNull().default("email"),

    // Status antrian
    status: text("status").notNull().default("pending"),
    // 'pending'  — menunggu dikirim
    // 'sent'     — sudah terkirim
    // 'failed'   — gagal, lihat errorMessage
    // 'skipped'  — kondisi tidak relevan lagi (misal WA sudah connect)

    // Jadwal pengiriman (boleh di masa depan untuk delayed send)
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),

    // Kapan benar-benar dikirim
    sentAt: timestamp("sent_at", { withTimezone: true }),

    // Pesan error jika gagal
    errorMessage: text("error_message"),

    // Metadata tambahan (subject email, nomor WA tujuan, dll)
    metadata: jsonb("metadata"),

    // Mencegah duplicate: satu triggerType per owner per periode trial
    // (dihitung dari createdAt, bukan dikirim ulang jika sudah pernah)
    dedupeKey: text("dedupe_key"),
    // Format: '{ownerUserId}:{triggerType}:{trialStartDate}'
    // Contoh: '42:wa_not_connected_24h:2025-06-09'

    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("drip_owner_status_idx").on(t.ownerUserId, t.status),
    index("drip_scheduled_idx").on(t.scheduledAt, t.status),
    // Dedupe index — unique tapi nullable (null = tidak di-dedup)
    index("drip_dedupe_idx").on(t.dedupeKey),
  ]
);

export type DripCampaignQueueRow = typeof dripCampaignQueueTable.$inferSelect;
```

---

## LANGKAH 5 — EXPORT SEMUA TABEL BARU

**Edit file: `lib/db/src/schema/index.ts`**

Tambahkan 3 baris export berikut di **akhir file** (setelah `export * from "./sales-assistant"`):

```typescript
export * from "./wa-otp";
export * from "./onboarding";
export * from "./drip-campaign";
```

---

## LANGKAH 6 — APPLY KE DATABASE

Jalankan di terminal Replit (bukan agent shell, butuh TTY interaktif):

```bash
pnpm --filter @workspace/db run push
```

Jika ada prompt "This will modify..." → ketik `y` lalu Enter.

---

## LANGKAH 7 — BUAT ONBOARDING HELPER LIBRARY

**Buat file baru: `artifacts/api-server/src/lib/onboarding.ts`**

```typescript
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  onboardingChecklistTable,
  usersTable,
  channelsTable,
  chatMessagesTable,
  productsTable,
  aiUsageEventsTable,
  chatbotFlowsTable,
  chatbotFlowChannelsTable,
} from "@workspace/db";

// Hitung health score dari checklist row
export function calcHealthScore(
  row: Omit<
    typeof onboardingChecklistTable.$inferSelect,
    "id" | "ownerUserId" | "healthScore" | "riskLevel" | "createdAt" | "updatedAt" | "lastCsFollowUpAt" | "lastCsNote"
  >
): { score: number; riskLevel: "low" | "medium" | "high" } {
  let score = 0;
  if (row.waConnected) score += 30;
  if (row.productAdded) score += 20;
  if (row.firstMessageAt) score += 20;
  if (row.teamMemberAdded) score += 15;
  if (row.aiTriedAt) score += 10;
  if (row.flowActivated) score += 5;

  const riskLevel: "low" | "medium" | "high" =
    score >= 70 ? "low" : score >= 40 ? "medium" : "high";

  return { score, riskLevel };
}

// Get or create checklist row untuk satu owner.
// Dipanggil dari berbagai event handler (channel connected, product created, dll)
export async function getOrCreateChecklist(ownerUserId: number) {
  const [existing] = await db
    .select()
    .from(onboardingChecklistTable)
    .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(onboardingChecklistTable)
    .values({ ownerUserId })
    .onConflictDoNothing()
    .returning();

  // Fallback jika conflict (race condition)
  if (!created) {
    const [refetched] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
      .limit(1);
    return refetched!;
  }
  return created;
}

// Recompute checklist dari data aktual di DB.
// Dipanggil saat: channel connect, produk tambah, pesan masuk/kirim, AI reply, flow aktif.
export async function refreshChecklist(ownerUserId: number): Promise<void> {
  const now = new Date();

  // 1. WA connected?
  const [waChannel] = await db
    .select({ id: channelsTable.id, status: channelsTable.status, createdAt: channelsTable.createdAt })
    .from(channelsTable)
    .where(
      and(
        eq(channelsTable.userId, ownerUserId),
        eq(channelsTable.status, "connected")
      )
    )
    .limit(1);

  // 2. Ada produk?
  const [product] = await db
    .select({ id: productsTable.id, createdAt: productsTable.createdAt })
    .from(productsTable)
    .where(eq(productsTable.userId, ownerUserId))
    .limit(1);

  // 3. Ada team member (child user)?
  const [teamMember] = await db
    .select({ id: usersTable.id, createdAt: usersTable.createdAt })
    .from(usersTable)
    .where(eq(usersTable.parentUserId, ownerUserId))
    .limit(1);

  // 4. Pernah ada pesan (inbound atau outbound)?
  // Chat messages perlu join ke chats → channels untuk filter by owner
  // (query sederhana: cek channels owner, lalu cari message pertama)
  const ownerChannels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId));

  let firstMessage: Date | null = null;
  if (ownerChannels.length > 0) {
    // Cek via chatsTable jika ada — skip jika tidak ada pesan sama sekali
    // (query ringan: cukup cari 1 row)
    try {
      const { chatsTable } = await import("@workspace/db");
      const [chat] = await db
        .select({ lastMessageAt: chatsTable.lastMessageAt })
        .from(chatsTable)
        .where(
          and(
            ...ownerChannels.map((c) => eq(chatsTable.channelId, c.id))
          )
        )
        .limit(1);
      if (chat?.lastMessageAt) firstMessage = chat.lastMessageAt;
    } catch {
      // best-effort
    }
  }

  // 5. AI pernah reply?
  const [aiUsage] = await db
    .select({ createdAt: aiUsageEventsTable.createdAt })
    .from(aiUsageEventsTable)
    .where(eq(aiUsageEventsTable.userId, ownerUserId))
    .limit(1);

  // 6. Ada flow aktif?
  const [activeFlow] = await db
    .select({ id: chatbotFlowChannelsTable.channelId })
    .from(chatbotFlowChannelsTable)
    .innerJoin(
      chatbotFlowsTable,
      eq(chatbotFlowsTable.id, chatbotFlowChannelsTable.flowId)
    )
    .where(eq(chatbotFlowsTable.userId, ownerUserId))
    .limit(1);

  const patch = {
    waConnected: !!waChannel,
    waConnectedAt: waChannel ? (waChannel.createdAt ?? now) : null,
    productAdded: !!product,
    productAddedAt: product ? (product.createdAt ?? now) : null,
    teamMemberAdded: !!teamMember,
    teamMemberAddedAt: teamMember ? (teamMember.createdAt ?? now) : null,
    firstMessageAt: firstMessage,
    aiTriedAt: aiUsage ? (aiUsage.createdAt ?? now) : null,
    flowActivated: !!activeFlow,
    flowActivatedAt: activeFlow ? now : null,
  };

  const { score, riskLevel } = calcHealthScore(patch);

  await db
    .insert(onboardingChecklistTable)
    .values({
      ownerUserId,
      ...patch,
      healthScore: score,
      riskLevel,
    })
    .onConflictDoUpdate({
      target: onboardingChecklistTable.ownerUserId,
      set: {
        ...patch,
        healthScore: score,
        riskLevel,
        updatedAt: now,
      },
    });
}
```

---

## LANGKAH 8 — BUAT OTP HELPER LIBRARY

**Buat file baru: `artifacts/api-server/src/lib/wa-otp.ts`**

```typescript
import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db, waOtpTable } from "@workspace/db";
import { logger } from "./logger";

const OTP_TTL_MS = 5 * 60 * 1000;        // 5 menit
const MAX_ATTEMPTS = 5;                    // Maks salah input
const MAX_RESENDS_PER_HOUR = 3;            // Maks resend per nomor per jam
const MAX_REQUESTS_PER_HOUR = 5;           // Maks total request OTP per nomor per jam

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function generateOtp(): string {
  // 6 digit, zero-padded
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export type RequestOtpResult =
  | { ok: true; otp: string; expiresAt: Date }
  | { ok: false; reason: "rate_limited" | "phone_invalid" };

// Buat OTP baru untuk nomor telepon.
// Mengembalikan OTP plaintext — caller wajib kirim via WA/SMS.
// Setelah dikembalikan, OTP hanya disimpan sebagai hash di DB.
export async function requestWaOtp(
  phone: string,
  purpose: "signup",
  ipAddress?: string
): Promise<RequestOtpResult> {
  // Validasi format nomor (hanya digit, 10-15 karakter, mulai 62 untuk Indonesia)
  const cleanPhone = phone.replace(/\D/g, "");
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return { ok: false, reason: "phone_invalid" };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Rate limit: maks 5 request per nomor per jam
  const recentCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waOtpTable)
    .where(
      and(
        eq(waOtpTable.phone, cleanPhone),
        gt(waOtpTable.createdAt, oneHourAgo)
      )
    );

  if ((recentCount[0]?.count ?? 0) >= MAX_REQUESTS_PER_HOUR) {
    return { ok: false, reason: "rate_limited" };
  }

  const otp = generateOtp();
  const otpHash = sha256(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await db.insert(waOtpTable).values({
    phone: cleanPhone,
    otpHash,
    purpose,
    expiresAt,
    ipAddress: ipAddress ?? null,
  });

  logger.info({ phone: cleanPhone, purpose }, "WA OTP requested");
  return { ok: true, otp, expiresAt };
}

export type VerifyOtpResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "expired" | "already_used" | "max_attempts" | "wrong_code"; attemptsLeft?: number };

// Verifikasi OTP. Mengembalikan ok:true jika berhasil.
// Side effect: increment attempt_count, set verified_at jika benar.
export async function verifyWaOtp(
  phone: string,
  otpInput: string,
  purpose: "signup"
): Promise<VerifyOtpResult> {
  const cleanPhone = phone.replace(/\D/g, "");
  const now = new Date();

  // Cari OTP terbaru yang belum diverifikasi untuk nomor ini
  const [row] = await db
    .select()
    .from(waOtpTable)
    .where(
      and(
        eq(waOtpTable.phone, cleanPhone),
        eq(waOtpTable.purpose, purpose),
        isNull(waOtpTable.verifiedAt)
      )
    )
    .orderBy(sql`${waOtpTable.createdAt} DESC`)
    .limit(1);

  if (!row) return { ok: false, reason: "not_found" };
  if (row.verifiedAt) return { ok: false, reason: "already_used" };
  if (row.expiresAt < now) return { ok: false, reason: "expired" };
  if (row.attemptCount >= MAX_ATTEMPTS) return { ok: false, reason: "max_attempts" };

  const inputHash = sha256(otpInput.trim());

  if (inputHash !== row.otpHash) {
    // Increment attempt counter
    await db
      .update(waOtpTable)
      .set({ attemptCount: row.attemptCount + 1 })
      .where(eq(waOtpTable.id, row.id));
    const attemptsLeft = MAX_ATTEMPTS - row.attemptCount - 1;
    return { ok: false, reason: "wrong_code", attemptsLeft };
  }

  // OTP benar — tandai sebagai sudah diverifikasi
  await db
    .update(waOtpTable)
    .set({ verifiedAt: now })
    .where(eq(waOtpTable.id, row.id));

  logger.info({ phone: cleanPhone, purpose }, "WA OTP verified successfully");
  return { ok: true };
}

// Cek apakah nomor WA ini pernah dipakai untuk trial sebelumnya.
// Query ke tabel users, kolom trial_whatsapp.
export async function isPhoneUsedForTrial(phone: string): Promise<boolean> {
  const { usersTable } = await import("@workspace/db");
  const cleanPhone = phone.replace(/\D/g, "");
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.trialWhatsapp, cleanPhone))
    .limit(1);
  return !!row;
}
```

---

## LANGKAH 9 — BUAT DRIP CAMPAIGN ENGINE

**Buat file baru: `artifacts/api-server/src/lib/drip-engine.ts`**

```typescript
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  dripCampaignQueueTable,
  onboardingChecklistTable,
  subscriptionsTable,
  usersTable,
} from "@workspace/db";
import { logger } from "./logger";
import { sendTransactionalEmail } from "./email";

// Konten email per trigger type.
// Sesuaikan subject dan body sesuai brand voice MaxiChat.
const DRIP_CONTENT: Record<
  string,
  { subject: string; body: (data: { name: string; companyName: string }) => string }
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

// Enqueue drip message, idempotent via dedupeKey.
export async function enqueueDrip(
  ownerUserId: number,
  triggerType: string,
  scheduledAt: Date,
  trialStartDate: string // format: YYYY-MM-DD
): Promise<void> {
  const dedupeKey = `${ownerUserId}:${triggerType}:${trialStartDate}`;

  // Cek apakah sudah pernah dienqueue (idempotent)
  const [existing] = await db
    .select({ id: dripCampaignQueueTable.id })
    .from(dripCampaignQueueTable)
    .where(eq(dripCampaignQueueTable.dedupeKey, dedupeKey))
    .limit(1);

  if (existing) return; // Sudah ada, skip

  await db.insert(dripCampaignQueueTable).values({
    ownerUserId,
    triggerType,
    scheduledAt,
    dedupeKey,
    status: "pending",
    channel: "email",
  });
}

// Jalankan semua drip yang sudah dijadwalkan dan belum terkirim.
// Dipanggil oleh background scheduler setiap 5 menit.
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
    .limit(50); // Proses max 50 per tick

  for (const item of pending) {
    try {
      // Ambil data owner
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
        // User sudah dihapus, skip
        await db
          .update(dripCampaignQueueTable)
          .set({ status: "skipped" })
          .where(eq(dripCampaignQueueTable.id, item.id));
        continue;
      }

      // Cek kondisi masih relevan (smart skip)
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
        logger.warn({ triggerType: item.triggerType }, "Unknown drip trigger type");
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

// Cek apakah drip ini masih relevan atau sudah di-resolve oleh user.
// Return true = skip pengiriman.
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
      return checklist.waConnected; // Sudah connect → skip
    case "product_empty":
      return checklist.productAdded; // Sudah ada produk → skip
    case "no_message_3d":
      return !!checklist.firstMessageAt; // Sudah ada pesan → skip
    case "high_engagement":
      return checklist.healthScore < 70; // Score turun → skip
    default:
      return false;
  }
}

// Scheduler: evaluasi semua tenant trial aktif dan enqueue drip yang diperlukan.
// Dipanggil setiap 15 menit oleh background job.
export async function evaluateDripTriggers(): Promise<void> {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  // Ambil semua owner yang masih dalam masa trial
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
        isNull(usersTable.parentUserId), // Hanya owner (bukan child user)
        gt(subscriptionsTable.currentPeriodEnd, now) // Trial masih aktif
      )
    );

  for (const owner of trialOwners) {
    const trialStartDate = owner.createdAt.toISOString().slice(0, 10);

    const [checklist] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, owner.userId))
      .limit(1);

    // Trigger 1: WA belum connect 24 jam setelah signup
    if (
      owner.createdAt < oneDayAgo &&
      (!checklist || !checklist.waConnected)
    ) {
      await enqueueDrip(owner.userId, "wa_not_connected_24h", now, trialStartDate);
    }

    // Trigger 2: WA connect tapi produk masih kosong
    if (checklist?.waConnected && !checklist.productAdded) {
      await enqueueDrip(owner.userId, "product_empty", now, trialStartDate);
    }

    // Trigger 3: 3 hari tidak ada pesan sama sekali
    if (
      owner.createdAt < threeDaysAgo &&
      (!checklist || !checklist.firstMessageAt)
    ) {
      await enqueueDrip(owner.userId, "no_message_3d", now, trialStartDate);
    }

    // Trigger 4: Trial expired 2 hari lagi
    if (
      owner.periodEnd &&
      owner.periodEnd < twoDaysFromNow &&
      owner.periodEnd > now
    ) {
      await enqueueDrip(owner.userId, "trial_expiring_2d", now, trialStartDate);
    }

    // Trigger 5: High engagement, tawarkan upgrade lebih awal
    if (checklist && checklist.healthScore >= 70) {
      await enqueueDrip(owner.userId, "high_engagement", now, trialStartDate);
    }
  }
}

let dripSchedulerStarted = false;

export function startDripScheduler(): void {
  if (dripSchedulerStarted) return;
  dripSchedulerStarted = true;
  // Evaluasi trigger setiap 15 menit
  setTimeout(() => {
    void evaluateDripTriggers();
    setInterval(() => void evaluateDripTriggers(), 15 * 60_000);
  }, 2 * 60_000); // Mulai 2 menit setelah boot
  // Proses queue setiap 5 menit
  setTimeout(() => {
    void processDripQueue();
    setInterval(() => void processDripQueue(), 5 * 60_000);
  }, 3 * 60_000); // Mulai 3 menit setelah boot
  logger.info("Drip campaign scheduler started");
}
```

---

## LANGKAH 10 — UPDATE EMAIL HELPER

**Edit file: `artifacts/api-server/src/lib/email.ts`**

Tambahkan fungsi `sendTransactionalEmail` di bagian bawah file (setelah fungsi yang sudah ada):

```typescript
// Generic transactional email untuk drip campaign.
// Menggunakan provider yang sama (Resend) dengan verification email.
export interface SendTransactionalEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput
): Promise<void> {
  const from = process.env.EMAIL_FROM?.trim() || "MaxiChat <onboarding@resend.dev>";

  if (!emailSenderConfigured()) {
    logger.warn(
      { to: input.to, subject: input.subject },
      "Email provider not configured — transactional email skipped (dev mode)"
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
      html: input.html ?? `<pre style="font-family:sans-serif">${input.text}</pre>`,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}
```

---

## LANGKAH 11 — BUAT API ROUTES OTP

**Buat file baru: `artifacts/api-server/src/routes/wa-otp.ts`**

```typescript
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requestWaOtp, verifyWaOtp, isPhoneUsedForTrial } from "../lib/wa-otp";
import { sendWaOtpMessage } from "../lib/wa-otp-sender";

const router = Router();

// Rate limit ketat untuk OTP endpoint
const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 jam
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan OTP. Coba lagi dalam 1 jam." },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan verifikasi. Coba lagi sebentar." },
});

// POST /auth/wa-otp/request
// Body: { phone: string, purpose: 'signup' }
// Response: { ok: true, expiresAt: string } | { ok: false, reason: string }
router.post("/request", otpRequestLimiter, async (req, res): Promise<void> => {
  try {
    const phone = String(req.body?.phone ?? "").trim();
    const purpose = req.body?.purpose === "signup" ? "signup" : null;

    if (!phone) {
      res.status(400).json({ error: "Nomor WhatsApp wajib diisi" });
      return;
    }
    if (!purpose) {
      res.status(400).json({ error: "Purpose tidak valid" });
      return;
    }

    // Cek apakah nomor ini sudah pernah dipakai untuk trial
    const alreadyUsed = await isPhoneUsedForTrial(phone);
    if (alreadyUsed) {
      res.status(409).json({
        error:
          "Nomor WhatsApp ini sudah pernah digunakan untuk trial MaxiChat. Hubungi tim kami jika ada pertanyaan.",
        reason: "phone_already_used",
      });
      return;
    }

    const result = await requestWaOtp(
      phone,
      purpose,
      req.ip ?? undefined
    );

    if (!result.ok) {
      if (result.reason === "rate_limited") {
        res.status(429).json({
          error: "Terlalu banyak permintaan OTP untuk nomor ini. Coba lagi dalam 1 jam.",
        });
        return;
      }
      if (result.reason === "phone_invalid") {
        res.status(400).json({ error: "Format nomor WhatsApp tidak valid" });
        return;
      }
      res.status(400).json({ error: "Gagal membuat OTP" });
      return;
    }

    // Kirim OTP via WhatsApp menggunakan channel aktif MaxiChat
    // (jika belum ada channel aktif, fallback ke log dev)
    try {
      await sendWaOtpMessage(phone, result.otp);
    } catch (err) {
      req.log.error({ err, phone }, "Failed to send WA OTP message");
      // Jangan gagalkan request — log saja, OTP tetap valid di DB
    }

    res.json({
      ok: true,
      expiresAt: result.expiresAt.toISOString(),
      // Di dev mode tampilkan OTP di response untuk testing
      ...(process.env.NODE_ENV !== "production" ? { devOtp: result.otp } : {}),
    });
  } catch (err) {
    req.log.error({ err }, "WA OTP request failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/wa-otp/verify
// Body: { phone: string, otp: string, purpose: 'signup' }
// Response: { ok: true } | { ok: false, reason: string, attemptsLeft?: number }
router.post("/verify", otpVerifyLimiter, async (req, res): Promise<void> => {
  try {
    const phone = String(req.body?.phone ?? "").trim();
    const otp = String(req.body?.otp ?? "").trim();
    const purpose = req.body?.purpose === "signup" ? "signup" : null;

    if (!phone || !otp || !purpose) {
      res.status(400).json({ error: "phone, otp, dan purpose wajib diisi" });
      return;
    }

    const result = await verifyWaOtp(phone, otp, purpose);

    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: "OTP tidak ditemukan. Minta OTP baru.",
        expired: "OTP sudah kedaluwarsa. Minta OTP baru.",
        already_used: "OTP sudah pernah dipakai.",
        max_attempts: "Terlalu banyak percobaan. Minta OTP baru.",
        wrong_code: "Kode OTP salah.",
      };
      res.status(400).json({
        error: messages[result.reason] ?? "Verifikasi gagal",
        reason: result.reason,
        attemptsLeft: result.attemptsLeft,
      });
      return;
    }

    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "WA OTP verify failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
```

---

## LANGKAH 12 — BUAT WA OTP SENDER

**Buat file baru: `artifacts/api-server/src/lib/wa-otp-sender.ts`**

```typescript
import { eq } from "drizzle-orm";
import { db, channelsTable } from "@workspace/db";
import { logger } from "./logger";
import { getSockForChannel } from "./channel-context"; // pakai helper existing

// Kirim OTP via WhatsApp menggunakan channel MaxiChat yang sedang aktif (connected).
// Jika tidak ada channel aktif, log saja (dev mode).
export async function sendWaOtpMessage(
  toPhone: string,
  otp: string
): Promise<void> {
  // Cari channel WhatsApp MaxiChat internal yang connected
  // (gunakan channel operator yang sudah tersimpan, atau env var MAXICHAT_OTP_CHANNEL_ID)
  const otpChannelId = process.env.MAXICHAT_OTP_CHANNEL_ID
    ? parseInt(process.env.MAXICHAT_OTP_CHANNEL_ID, 10)
    : null;

  if (!otpChannelId) {
    // Dev mode: log saja
    logger.info(
      { toPhone, otp },
      "[DEV] WA OTP — set MAXICHAT_OTP_CHANNEL_ID env var untuk kirim via WA nyata"
    );
    return;
  }

  try {
    const sock = await getSockForChannel(otpChannelId);
    if (!sock) {
      logger.warn({ otpChannelId }, "OTP channel socket not available");
      return;
    }

    // Format nomor ke JID WhatsApp
    const cleanPhone = toPhone.replace(/\D/g, "");
    const jid = `${cleanPhone}@s.whatsapp.net`;

    const message =
      `Kode verifikasi MaxiChat Anda:\n\n*${otp}*\n\nBerlaku 5 menit. Jangan bagikan kode ini ke siapapun.`;

    await sock.sendMessage(jid, { text: message });
    logger.info({ toPhone: cleanPhone }, "WA OTP sent successfully");
  } catch (err) {
    logger.error({ err, toPhone }, "Failed to send WA OTP via Baileys");
    throw err;
  }
}
```

---

## LANGKAH 13 — BUAT API ROUTES ONBOARDING

**Buat file baru: `artifacts/api-server/src/routes/onboarding.ts`**

```typescript
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, onboardingChecklistTable } from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { refreshChecklist } from "../lib/onboarding";

const router = Router();

// GET /onboarding/checklist
// Ambil progress checklist owner yang sedang login.
router.get("/checklist", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const ownerUserId = await getEffectiveOwnerUserId(userId);

    // Refresh dari data aktual dulu
    await refreshChecklist(ownerUserId);

    const [row] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
      .limit(1);

    res.json({
      waConnected: row?.waConnected ?? false,
      productAdded: row?.productAdded ?? false,
      teamMemberAdded: row?.teamMemberAdded ?? false,
      firstMessageAt: row?.firstMessageAt?.toISOString() ?? null,
      aiTriedAt: row?.aiTriedAt?.toISOString() ?? null,
      flowActivated: row?.flowActivated ?? false,
      healthScore: row?.healthScore ?? 0,
      riskLevel: row?.riskLevel ?? "high",
    });
  } catch (err) {
    req.log.error({ err }, "GET /onboarding/checklist failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /onboarding/refresh
// Force-refresh checklist dari data aktual (dipanggil setelah event penting).
router.post("/refresh", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const ownerUserId = await getEffectiveOwnerUserId(userId);
    await refreshChecklist(ownerUserId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/refresh failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
```

---

## LANGKAH 14 — MOUNT ROUTES BARU

**Edit file: `artifacts/api-server/src/routes/index.ts`**

**Tambahkan import** di bagian atas bersama import lainnya:

```typescript
import waOtpRouter from "./wa-otp";
import onboardingRouter from "./onboarding";
```

**Tambahkan mount** di bagian public routes (sebelum `router.use(requireAuth)`):

```typescript
// WA OTP — public (dipakai sebelum signup, tidak butuh session)
router.use("/auth/wa-otp", waOtpRouter);
```

**Tambahkan mount** setelah `router.use(requireAuth)`:

```typescript
router.use("/onboarding", onboardingRouter);
```

---

## LANGKAH 15 — REGISTRASI DRIP SCHEDULER DI INDEX.TS

**Edit file: `artifacts/api-server/src/index.ts`**

Tambahkan import:

```typescript
import { startDripScheduler } from "./lib/drip-engine";
```

Tambahkan pemanggilan setelah scheduler lain sudah dimulai (cari baris `startFollowUpScheduler()` dan tambahkan setelahnya):

```typescript
startDripScheduler();
```

---

## LANGKAH 16 — UPDATE SIGNUP ROUTE (TAMBAH BUSINESS QUESTIONS)

**Edit file: `artifacts/api-server/src/routes/auth.ts`**

Di dalam `router.post("/signup", ...)`, tambahkan parsing dua field baru setelah `mobilePhone`:

```typescript
// Tambahkan setelah baris: const mobilePhone = ...
const businessVolume =
  typeof req.body?.businessVolume === "string" &&
  ["lt50", "50to200", "200to500", "gt500"].includes(req.body.businessVolume)
    ? req.body.businessVolume
    : null;

const businessTeamSize =
  typeof req.body?.businessTeamSize === "string" &&
  ["solo", "2to5", "6to20", "gt20"].includes(req.body.businessTeamSize)
    ? req.body.businessTeamSize
    : null;

const trialWhatsapp =
  typeof req.body?.trialWhatsapp === "string"
    ? req.body.trialWhatsapp.replace(/\D/g, "").slice(0, 20) || null
    : null;
```

Di dalam `db.insert(usersTable).values({...})`, tambahkan field baru:

```typescript
// Tambahkan di dalam .values({ ... }):
businessVolume,
businessTeamSize,
trialWhatsapp,
trialUsed: true, // Tandai trial sudah digunakan
```

---

## LANGKAH 17 — ADMIN: GRANT TRIAL OVERRIDE

**Edit file: `artifacts/api-server/src/routes/admin.ts`**

Tambahkan route baru di bagian bawah file (sebelum `export default router`):

```typescript
// POST /admin/users/:id/grant-trial
// Admin bisa grant trial baru untuk user yang sudah pernah trial.
router.post("/users/:id/grant-trial", async (req, res): Promise<void> => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: "Invalid user id" });
      return;
    }
    const adminId = getSessionUserId(req);

    // Verifikasi target user ada dan adalah owner (bukan child user)
    const [target] = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        parentUserId: usersTable.parentUserId,
        trialUsed: usersTable.trialUsed,
      })
      .from(usersTable)
      .where(eq(usersTable.id, targetId))
      .limit(1);

    if (!target) {
      res.status(404).json({ error: "User tidak ditemukan" });
      return;
    }
    if (target.parentUserId !== null) {
      res.status(400).json({ error: "Hanya owner (super_admin) yang bisa diberikan trial" });
      return;
    }

    const trialDays = Number(req.body?.trialDays ?? 7);
    if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 30) {
      res.status(400).json({ error: "trialDays harus antara 1-30" });
      return;
    }

    const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 200) : null;

    // Reset subscription ke trial baru
    const newEnd = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
    await db
      .insert(subscriptionsTable)
      .values({
        userId: targetId,
        status: "trial",
        currentPeriodEnd: newEnd,
      })
      .onConflictDoUpdate({
        target: subscriptionsTable.userId,
        set: {
          status: "trial",
          currentPeriodEnd: newEnd,
          dunningStartedAt: null,
          graceUntil: null,
          updatedAt: new Date(),
        },
      });

    // Update user: tandai trial granted by admin
    await db
      .update(usersTable)
      .set({
        trialGrantedBy: adminId,
        trialGrantedAt: new Date(),
      })
      .where(eq(usersTable.id, targetId));

    req.log.info(
      { adminId, targetId, trialDays, note },
      "Admin granted new trial to user"
    );

    res.json({
      ok: true,
      message: `Trial ${trialDays} hari berhasil diberikan ke ${target.email}`,
      trialEndsAt: newEnd.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "POST /admin/users/:id/grant-trial failed");
    res.status(500).json({ error: "Internal server error" });
  }
});
```

---

## LANGKAH 18 — ADMIN PANEL: TRIAL MONITOR PAGE

**Buat file baru: `artifacts/admin/src/pages/TrialMonitor.tsx`**

```tsx
import { useEffect, useState } from "react";

interface TrialTenant {
  id: number;
  email: string;
  name: string | null;
  companyName: string | null;
  businessVolume: string | null;
  businessTeamSize: string | null;
  trialEndsAt: string | null;
  trialDaysLeft: number;
  healthScore: number;
  riskLevel: "low" | "medium" | "high";
  waConnected: boolean;
  productAdded: boolean;
  teamMemberAdded: boolean;
  firstMessageAt: string | null;
  aiTriedAt: string | null;
  flowActivated: boolean;
  lastCsFollowUpAt: string | null;
}

function RiskBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    high: "bg-red-100 text-red-800",
    medium: "bg-yellow-100 text-yellow-800",
    low: "bg-green-100 text-green-800",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-semibold ${colors[level] ?? ""}`}>
      {level.toUpperCase()}
    </span>
  );
}

function ProgressBar({ score }: { score: number }) {
  const color = score >= 70 ? "bg-green-500" : score >= 40 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-200 rounded-full h-2">
        <div
          className={`h-2 rounded-full ${color}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs font-mono w-8 text-right">{score}</span>
    </div>
  );
}

function CheckIcon({ done }: { done: boolean }) {
  return (
    <span className={done ? "text-green-500" : "text-gray-300"}>
      {done ? "✓" : "○"}
    </span>
  );
}

export default function TrialMonitor() {
  const [tenants, setTenants] = useState<TrialTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [grantModal, setGrantModal] = useState<{ userId: number; email: string } | null>(null);
  const [grantDays, setGrantDays] = useState(7);
  const [grantNote, setGrantNote] = useState("");

  useEffect(() => {
    fetch("/api/admin/trial-monitor", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setTenants(data.tenants ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = tenants.filter(
    (t) => filter === "all" || t.riskLevel === filter
  );

  const handleGrantTrial = async () => {
    if (!grantModal) return;
    await fetch(`/api/admin/users/${grantModal.userId}/grant-trial`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trialDays: grantDays, note: grantNote }),
    });
    setGrantModal(null);
    // Refresh
    window.location.reload();
  };

  const volumeLabels: Record<string, string> = {
    lt50: "< 50 msg/hari",
    "50to200": "50–200 msg/hari",
    "200to500": "200–500 msg/hari",
    gt500: "> 500 msg/hari",
  };
  const teamLabels: Record<string, string> = {
    solo: "Solo",
    "2to5": "2–5 orang",
    "6to20": "6–20 orang",
    gt20: "> 20 orang",
  };

  if (loading) return <div className="p-8 text-gray-500">Memuat data trial...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-2">Trial Monitor</h1>
      <p className="text-gray-500 text-sm mb-6">
        {tenants.length} tenant aktif trial —{" "}
        {tenants.filter((t) => t.riskLevel === "high").length} high risk
      </p>

      {/* Filter */}
      <div className="flex gap-2 mb-4">
        {(["all", "high", "medium", "low"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded text-sm font-medium border ${
              filter === f
                ? "bg-gray-800 text-white border-gray-800"
                : "bg-white text-gray-600 border-gray-300 hover:bg-gray-50"
            }`}
          >
            {f === "all" ? "Semua" : f.charAt(0).toUpperCase() + f.slice(1)}{" "}
            {f !== "all" && `(${tenants.filter((t) => t.riskLevel === f).length})`}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">Tenant</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">Profil Bisnis</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">Sisa Trial</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">Health Score</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-600">WA</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-600">Produk</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-600">Pesan</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-600">AI</th>
              <th className="px-4 py-3 text-center font-semibold text-gray-600">Tim</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">Aksi</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr key={t.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">
                    {t.companyName || t.name || "—"}
                  </div>
                  <div className="text-gray-400 text-xs">{t.email}</div>
                  <div className="mt-1">
                    <RiskBadge level={t.riskLevel} />
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-500">
                  <div className="text-xs">
                    {t.businessVolume ? volumeLabels[t.businessVolume] : "—"}
                  </div>
                  <div className="text-xs">
                    {t.businessTeamSize ? teamLabels[t.businessTeamSize] : "—"}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`font-mono font-bold ${
                      t.trialDaysLeft <= 1
                        ? "text-red-600"
                        : t.trialDaysLeft <= 3
                        ? "text-yellow-600"
                        : "text-gray-700"
                    }`}
                  >
                    {t.trialDaysLeft}h
                  </span>
                </td>
                <td className="px-4 py-3 min-w-[120px]">
                  <ProgressBar score={t.healthScore} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={t.waConnected} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={t.productAdded} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={!!t.firstMessageAt} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={!!t.aiTriedAt} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={t.teamMemberAdded} />
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() =>
                      setGrantModal({ userId: t.id, email: t.email })
                    }
                    className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
                  >
                    Grant Trial
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-4 py-8 text-center text-gray-400">
                  Tidak ada tenant dengan filter ini.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Grant Trial Modal */}
      {grantModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-96 shadow-xl">
            <h2 className="font-bold text-lg mb-1">Grant Trial Baru</h2>
            <p className="text-gray-500 text-sm mb-4">{grantModal.email}</p>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Durasi Trial (hari)
            </label>
            <input
              type="number"
              min={1}
              max={30}
              value={grantDays}
              onChange={(e) => setGrantDays(Number(e.target.value))}
              className="w-full border rounded px-3 py-2 mb-3 text-sm"
            />
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Catatan (opsional)
            </label>
            <textarea
              value={grantNote}
              onChange={(e) => setGrantNote(e.target.value)}
              placeholder="Alasan grant trial..."
              className="w-full border rounded px-3 py-2 mb-4 text-sm h-20 resize-none"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setGrantModal(null)}
                className="px-4 py-2 text-sm rounded border border-gray-300 hover:bg-gray-50"
              >
                Batal
              </button>
              <button
                onClick={handleGrantTrial}
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700"
              >
                Grant Trial
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## LANGKAH 19 — ADMIN API: TRIAL MONITOR ENDPOINT

**Edit file: `artifacts/api-server/src/routes/admin.ts`**

Tambahkan route baru (tambahkan bersama import di atas file):

```typescript
import {
  onboardingChecklistTable,
  subscriptionsTable,
  dripCampaignQueueTable,
} from "@workspace/db";
```

Tambahkan route endpoint di bawah:

```typescript
// GET /admin/trial-monitor
// Semua tenant yang sedang trial beserta health score mereka.
router.get("/trial-monitor", async (req, res): Promise<void> => {
  try {
    const now = new Date();

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        name: usersTable.name,
        companyName: usersTable.companyName,
        businessVolume: usersTable.businessVolume,
        businessTeamSize: usersTable.businessTeamSize,
        trialEnd: subscriptionsTable.currentPeriodEnd,
        waConnected: onboardingChecklistTable.waConnected,
        productAdded: onboardingChecklistTable.productAdded,
        teamMemberAdded: onboardingChecklistTable.teamMemberAdded,
        firstMessageAt: onboardingChecklistTable.firstMessageAt,
        aiTriedAt: onboardingChecklistTable.aiTriedAt,
        flowActivated: onboardingChecklistTable.flowActivated,
        healthScore: onboardingChecklistTable.healthScore,
        riskLevel: onboardingChecklistTable.riskLevel,
        lastCsFollowUpAt: onboardingChecklistTable.lastCsFollowUpAt,
      })
      .from(usersTable)
      .innerJoin(
        subscriptionsTable,
        and(
          eq(subscriptionsTable.userId, usersTable.id),
          eq(subscriptionsTable.status, "trial")
        )
      )
      .leftJoin(
        onboardingChecklistTable,
        eq(onboardingChecklistTable.ownerUserId, usersTable.id)
      )
      .where(isNull(usersTable.parentUserId))
      .orderBy(onboardingChecklistTable.healthScore);

    const tenants = rows.map((r) => {
      const trialDaysLeft = r.trialEnd
        ? Math.max(
            0,
            Math.ceil(
              (r.trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
            )
          )
        : 0;
      return {
        id: r.id,
        email: r.email,
        name: r.name,
        companyName: r.companyName,
        businessVolume: r.businessVolume,
        businessTeamSize: r.businessTeamSize,
        trialEndsAt: r.trialEnd?.toISOString() ?? null,
        trialDaysLeft,
        healthScore: r.healthScore ?? 0,
        riskLevel: r.riskLevel ?? "high",
        waConnected: r.waConnected ?? false,
        productAdded: r.productAdded ?? false,
        teamMemberAdded: r.teamMemberAdded ?? false,
        firstMessageAt: r.firstMessageAt?.toISOString() ?? null,
        aiTriedAt: r.aiTriedAt?.toISOString() ?? null,
        flowActivated: r.flowActivated ?? false,
        lastCsFollowUpAt: r.lastCsFollowUpAt?.toISOString() ?? null,
      };
    });

    res.json({ tenants });
  } catch (err) {
    req.log.error({ err }, "GET /admin/trial-monitor failed");
    res.status(500).json({ error: "Internal server error" });
  }
});
```

---

## LANGKAH 20 — TAMBAH TRIAL MONITOR KE ADMIN APP ROUTING

**Edit file: `artifacts/admin/src/App.tsx`**

Tambahkan import:
```tsx
import TrialMonitor from "./pages/TrialMonitor";
```

Tambahkan route (sesuaikan dengan pola router yang sudah ada):
```tsx
<Route path="/trial-monitor" component={TrialMonitor} />
```

Tambahkan nav link (di sidebar/menu yang sudah ada):
```tsx
<a href="/trial-monitor">Trial Monitor</a>
```

---

## LANGKAH 21 — TRIGGER REFRESH CHECKLIST DARI EVENT EXISTING

Tambahkan panggilan `refreshChecklist(ownerUserId)` di lokasi-lokasi berikut (best-effort, wrapped dalam try-catch agar tidak ganggu flow utama):

**1. Di `artifacts/api-server/src/routes/channels.ts`**, setelah channel berhasil terkoneksi (status = 'connected'):
```typescript
// Setelah channel status update ke connected:
import { refreshChecklist } from "../lib/onboarding";
import { resolveOwnerUserId } from "../lib/seed";
try {
  const ownerUserId = await resolveOwnerUserId(getSessionUserId(req)!);
  await refreshChecklist(ownerUserId);
} catch { /* best-effort */ }
```

**2. Di `artifacts/api-server/src/routes/products.ts`**, setelah produk pertama berhasil dibuat:
```typescript
try {
  const ownerUserId = await resolveOwnerUserId(getSessionUserId(req)!);
  await refreshChecklist(ownerUserId);
} catch { /* best-effort */ }
```

**3. Di `artifacts/api-server/src/routes/agents.ts`**, setelah agent pertama berhasil diinvite:
```typescript
try {
  const ownerUserId = await resolveOwnerUserId(getSessionUserId(req)!);
  await refreshChecklist(ownerUserId);
} catch { /* best-effort */ }
```

---

## LANGKAH 22 — ONBOARDING CHECKLIST DI FRONTEND (WEB APP)

**Buat file baru: `artifacts/whatsapp-ai/src/components/OnboardingChecklist.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

interface ChecklistData {
  waConnected: boolean;
  productAdded: boolean;
  teamMemberAdded: boolean;
  firstMessageAt: string | null;
  aiTriedAt: string | null;
  flowActivated: boolean;
  healthScore: number;
  riskLevel: "low" | "medium" | "high";
}

const CHECKLIST_ITEMS = [
  {
    key: "waConnected" as const,
    label: "Hubungkan WhatsApp",
    desc: "Scan QR code di menu Channels",
    href: "/channels",
    points: 30,
  },
  {
    key: "productAdded" as const,
    label: "Tambahkan Produk",
    desc: "Isi katalog produk agar AI bisa jawab pertanyaan",
    href: "/products",
    points: 20,
  },
  {
    key: "firstMessage" as const,
    label: "Terima atau Kirim Pesan",
    desc: "Coba kirim pesan WA ke nomor bisnis Anda",
    href: "/chats",
    points: 20,
  },
  {
    key: "teamMemberAdded" as const,
    label: "Tambahkan Anggota Tim",
    desc: "Invite agent atau supervisor",
    href: "/agents",
    points: 15,
  },
  {
    key: "aiTried" as const,
    label: "Coba Fitur AI",
    desc: "Aktifkan auto-reply AI di Settings",
    href: "/settings",
    points: 10,
  },
  {
    key: "flowActivated" as const,
    label: "Aktifkan Chatbot Flow",
    desc: "Buat flow di menu Flows",
    href: "/flows",
    points: 5,
  },
];

export function OnboardingChecklist() {
  const { data, isLoading } = useQuery<ChecklistData>({
    queryKey: ["onboarding-checklist"],
    queryFn: () =>
      fetch("/api/onboarding/checklist", { credentials: "include" }).then(
        (r) => r.json()
      ),
    refetchInterval: 30_000, // Refresh setiap 30 detik
  });

  if (isLoading || !data) return null;
  if (data.healthScore >= 100) return null; // Semua selesai, sembunyikan

  const completedCount = [
    data.waConnected,
    data.productAdded,
    !!data.firstMessageAt,
    data.teamMemberAdded,
    !!data.aiTriedAt,
    data.flowActivated,
  ].filter(Boolean).length;

  const isDoneMap: Record<string, boolean> = {
    waConnected: data.waConnected,
    productAdded: data.productAdded,
    firstMessage: !!data.firstMessageAt,
    teamMemberAdded: data.teamMemberAdded,
    aiTried: !!data.aiTriedAt,
    flowActivated: data.flowActivated,
  };

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-800">Setup MaxiChat</h3>
        <span className="text-sm text-gray-500">
          {completedCount}/6 selesai
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-gray-100 rounded-full mb-4">
        <div
          className="h-2 rounded-full bg-green-500 transition-all duration-500"
          style={{ width: `${data.healthScore}%` }}
        />
      </div>

      {/* Items */}
      <div className="space-y-2">
        {CHECKLIST_ITEMS.map((item) => {
          const done = isDoneMap[item.key];
          return (
            <a
              key={item.key}
              href={done ? undefined : item.href}
              className={`flex items-start gap-3 p-2 rounded-lg transition-colors ${
                done
                  ? "opacity-50 cursor-default"
                  : "hover:bg-gray-50 cursor-pointer"
              }`}
            >
              <span
                className={`mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-xs flex-shrink-0 ${
                  done
                    ? "bg-green-500 text-white"
                    : "border-2 border-gray-300 text-transparent"
                }`}
              >
                ✓
              </span>
              <div className="flex-1 min-w-0">
                <div
                  className={`text-sm font-medium ${
                    done ? "line-through text-gray-400" : "text-gray-700"
                  }`}
                >
                  {item.label}
                </div>
                {!done && (
                  <div className="text-xs text-gray-400">{item.desc}</div>
                )}
              </div>
              {!done && (
                <span className="text-xs text-gray-400 flex-shrink-0">
                  +{item.points}
                </span>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
```

Tambahkan komponen ini ke halaman Dashboard (`artifacts/whatsapp-ai/src/pages/Dashboard.tsx`):

```tsx
import { OnboardingChecklist } from "../components/OnboardingChecklist";

// Tambahkan di JSX Dashboard, misalnya di sidebar atau bagian atas:
<OnboardingChecklist />
```

---

## RINGKASAN SEMUA FILE YANG PERLU DIBUAT / DIUBAH

### File Baru (create):
| File | Keterangan |
|------|-----------|
| `lib/db/src/schema/wa-otp.ts` | Schema tabel OTP WA |
| `lib/db/src/schema/onboarding.ts` | Schema tabel checklist onboarding |
| `lib/db/src/schema/drip-campaign.ts` | Schema tabel drip queue |
| `artifacts/api-server/src/lib/onboarding.ts` | Helper: refresh & kalkulasi checklist |
| `artifacts/api-server/src/lib/wa-otp.ts` | Helper: request & verify OTP |
| `artifacts/api-server/src/lib/wa-otp-sender.ts` | Helper: kirim OTP via WA Baileys |
| `artifacts/api-server/src/lib/drip-engine.ts` | Engine drip campaign |
| `artifacts/api-server/src/routes/wa-otp.ts` | Route: POST /auth/wa-otp/* |
| `artifacts/api-server/src/routes/onboarding.ts` | Route: GET/POST /onboarding/* |
| `artifacts/admin/src/pages/TrialMonitor.tsx` | UI: halaman Trial Monitor admin |
| `artifacts/whatsapp-ai/src/components/OnboardingChecklist.tsx` | UI: widget checklist di dashboard |

### File yang Diubah (edit):
| File | Perubahan |
|------|----------|
| `lib/db/src/schema/auth.ts` | Tambah 8 kolom baru ke `usersTable` |
| `lib/db/src/schema/index.ts` | Export 3 schema baru |
| `artifacts/api-server/src/lib/email.ts` | Tambah `sendTransactionalEmail()` |
| `artifacts/api-server/src/routes/auth.ts` | Parse `businessVolume`, `businessTeamSize`, `trialWhatsapp` di signup |
| `artifacts/api-server/src/routes/index.ts` | Mount 2 route baru |
| `artifacts/api-server/src/routes/admin.ts` | Tambah 2 endpoint: `/trial-monitor` & `/users/:id/grant-trial` |
| `artifacts/api-server/src/index.ts` | Start `dripScheduler` |
| `artifacts/admin/src/App.tsx` | Tambah route & nav Trial Monitor |
| `artifacts/whatsapp-ai/src/pages/Dashboard.tsx` | Tambah `<OnboardingChecklist />` |
| `artifacts/api-server/src/routes/channels.ts` | Trigger `refreshChecklist` setelah WA connect |
| `artifacts/api-server/src/routes/products.ts` | Trigger `refreshChecklist` setelah produk dibuat |
| `artifacts/api-server/src/routes/agents.ts` | Trigger `refreshChecklist` setelah agent diinvite |

---

## CATATAN PENTING UNTUK REPLIT

1. **Jangan jalankan `drizzle-kit push` dari agent shell** — harus dari terminal interaktif (ada prompt konfirmasi yang perlu dijawab).

2. **Environment variable baru yang perlu ditambahkan:**
   - `MAXICHAT_OTP_CHANNEL_ID` — ID channel WA internal MaxiChat untuk kirim OTP. Set setelah channel pertama berhasil connect. Tanpa ini OTP hanya di-log (dev mode).

3. **Tabel `productsTable` di `@workspace/db`** — pastikan nama export-nya benar. Cek di `lib/db/src/schema/` jika ada error import.

4. **`getSockForChannel`** di `wa-otp-sender.ts` — cek nama dan lokasi exact function ini di codebase existing (mungkin ada di `channel-context.ts` atau `whatsapp.ts`). Sesuaikan import-nya.

5. **Setelah semua selesai**, test dengan flow berikut:
   - POST `/api/auth/wa-otp/request` dengan `{ phone: "6281234567890", purpose: "signup" }` → harus dapat `devOtp` di dev mode
   - POST `/api/auth/wa-otp/verify` dengan OTP yang didapat → harus `{ ok: true }`
   - POST `/api/auth/signup` dengan tambahan field `businessVolume`, `businessTeamSize`, `trialWhatsapp`
   - GET `/api/onboarding/checklist` setelah login → harus dapat health score
   - GET `/api/admin/trial-monitor` dari admin session → harus dapat list tenant

---

*Prompt ini disiapkan berdasarkan analisis source code MaxiChat (1057 files, 63 tabel) pada tanggal 9 Juni 2026.*
