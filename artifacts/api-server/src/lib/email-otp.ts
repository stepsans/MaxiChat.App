import crypto from "crypto";
import { db } from "@workspace/db";
import { emailOtpTable } from "@workspace/db";
import { eq, and, desc, gt } from "drizzle-orm";

const MAX_REQUESTS_PER_HOUR = 10;
const MAX_RESEND = 10;
const EXPIRE_MINUTES = 10;

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const genOtp = () => String(Math.floor(100000 + Math.random() * 900000));

export interface OtpResult { ok: boolean; otp?: string; expiresAt: Date; error?: string; }

export async function requestEmailOtp(email: string, purpose: "login" | "signup", ip?: string): Promise<OtpResult> {
  const e = email.toLowerCase().trim();
  const oneHourAgo = new Date(Date.now() - 3600_000);
  const recent = await db.select({ id: emailOtpTable.id }).from(emailOtpTable)
    .where(and(eq(emailOtpTable.email, e), gt(emailOtpTable.createdAt, oneHourAgo)));
  if (recent.length >= MAX_REQUESTS_PER_HOUR)
    return { ok: false, expiresAt: new Date(), error: "Terlalu banyak permintaan OTP. Coba lagi dalam 1 jam." };

  const otp = genOtp();
  const expiresAt = new Date(Date.now() + EXPIRE_MINUTES * 60_000);
  await db.insert(emailOtpTable).values({ email: e, otpHash: hash(otp), purpose, expiresAt, ipAddress: ip ?? null });
  return { ok: true, otp, expiresAt };
}

export async function verifyEmailOtp(email: string, otpInput: string, purpose: "login" | "signup"): Promise<{ ok: boolean; email?: string; error?: string }> {
  const e = email.toLowerCase().trim();
  const [row] = await db.select().from(emailOtpTable)
    .where(and(eq(emailOtpTable.email, e), eq(emailOtpTable.purpose, purpose)))
    .orderBy(desc(emailOtpTable.createdAt)).limit(1);

  if (!row) return { ok: false, error: "Kode OTP tidak ditemukan. Silakan request OTP baru." };
  if (row.verifiedAt) return { ok: false, error: "Kode OTP sudah digunakan." };
  if (row.expiresAt < new Date()) return { ok: false, error: "Kode OTP sudah kadaluarsa. Silakan request OTP baru." };
  if (row.attemptCount >= 10) return { ok: false, error: "Terlalu banyak percobaan. Silakan request OTP baru." };
  if (row.otpHash !== hash(otpInput.trim())) {
    await db.update(emailOtpTable).set({ attemptCount: row.attemptCount + 1 }).where(eq(emailOtpTable.id, row.id));
    return { ok: false, error: "Kode OTP salah." };
  }
  await db.update(emailOtpTable).set({ verifiedAt: new Date() }).where(eq(emailOtpTable.id, row.id));
  return { ok: true, email: e };
}

export async function resendEmailOtp(email: string, purpose: "login" | "signup", ip?: string): Promise<OtpResult> {
  const e = email.toLowerCase().trim();
  const [latest] = await db.select().from(emailOtpTable).where(eq(emailOtpTable.email, e))
    .orderBy(desc(emailOtpTable.createdAt)).limit(1);
  if (latest && latest.resendCount >= MAX_RESEND)
    return { ok: false, expiresAt: new Date(), error: "Batas resend OTP tercapai. Tunggu 1 jam." };

  const otp = genOtp();
  const expiresAt = new Date(Date.now() + EXPIRE_MINUTES * 60_000);
  await db.insert(emailOtpTable).values({
    email: e, otpHash: hash(otp), purpose, expiresAt,
    resendCount: (latest?.resendCount ?? 0) + 1, ipAddress: ip ?? null,
  });
  return { ok: true, otp, expiresAt };
}
