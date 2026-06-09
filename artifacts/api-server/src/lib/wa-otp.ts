import { createHash, randomInt } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db, waOtpTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5; // Max wrong inputs
const MAX_REQUESTS_PER_HOUR = 5; // Max OTP requests per number per hour

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function generateOtp(): string {
  // 6 digits, zero-padded.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export type RequestOtpResult =
  | { ok: true; otp: string; expiresAt: Date }
  | { ok: false; reason: "rate_limited" | "phone_invalid" };

// Create a new OTP for a phone number. Returns the plaintext OTP — the caller
// must deliver it via WA/SMS. Only the hash is persisted.
export async function requestWaOtp(
  phone: string,
  purpose: "signup",
  ipAddress?: string
): Promise<RequestOtpResult> {
  const cleanPhone = phone.replace(/\D/g, "");
  if (cleanPhone.length < 10 || cleanPhone.length > 15) {
    return { ok: false, reason: "phone_invalid" };
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Rate limit: max 5 requests per number per hour.
  const recentCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waOtpTable)
    .where(
      and(eq(waOtpTable.phone, cleanPhone), gt(waOtpTable.createdAt, oneHourAgo))
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
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "already_used"
        | "max_attempts"
        | "wrong_code";
      attemptsLeft?: number;
    };

// Verify an OTP. Side effects: increment attempt_count, set verified_at on
// success.
export async function verifyWaOtp(
  phone: string,
  otpInput: string,
  purpose: "signup"
): Promise<VerifyOtpResult> {
  const cleanPhone = phone.replace(/\D/g, "");
  const now = new Date();

  // Latest un-verified OTP for this number.
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
  if (row.attemptCount >= MAX_ATTEMPTS)
    return { ok: false, reason: "max_attempts" };

  const inputHash = sha256(otpInput.trim());

  if (inputHash !== row.otpHash) {
    await db
      .update(waOtpTable)
      .set({ attemptCount: row.attemptCount + 1 })
      .where(eq(waOtpTable.id, row.id));
    const attemptsLeft = MAX_ATTEMPTS - row.attemptCount - 1;
    return { ok: false, reason: "wrong_code", attemptsLeft };
  }

  await db
    .update(waOtpTable)
    .set({ verifiedAt: now })
    .where(eq(waOtpTable.id, row.id));

  logger.info({ phone: cleanPhone, purpose }, "WA OTP verified successfully");
  return { ok: true };
}

// Whether this WA number was ever used for a trial (users.trial_whatsapp).
export async function isPhoneUsedForTrial(phone: string): Promise<boolean> {
  const cleanPhone = phone.replace(/\D/g, "");
  const [row] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.trialWhatsapp, cleanPhone))
    .limit(1);
  return !!row;
}
