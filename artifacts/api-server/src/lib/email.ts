import nodemailer from "nodemailer";
import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db";
import { logger } from "./logger";

let smtpCache: SmtpConfig | null = null;
let smtpCachedAt = 0;
const CACHE_TTL = 60_000;

interface SmtpConfig {
  host: string; port: number; secure: boolean;
  user: string; pass: string; from: string; fromName: string;
}

const SMTP_DEFAULT: SmtpConfig = {
  host: "smtp.gmail.com", port: 587, secure: false,
  user: "info@maxichat.app", pass: "zjug flkm fcpr vtkk",
  from: "info@maxichat.app", fromName: "MaxiChat",
};

export function invalidateSmtpCache(): void {
  smtpCache = null; smtpCachedAt = 0;
}

async function getSmtpConfig(): Promise<SmtpConfig> {
  const now = Date.now();
  if (smtpCache && now - smtpCachedAt < CACHE_TTL) return smtpCache;

  try {
    const rows = await db.select().from(platformSettingsTable);
    const m: Record<string, string> = {};
    for (const r of rows) m[r.key] = r.value;

    const host = m["smtp_host"]?.trim();
    const portStr = m["smtp_port"]?.trim();
    const user = m["smtp_user"]?.trim();
    const pass = m["smtp_pass"]?.trim();

    if (!host || !portStr || !user || !pass) {
      smtpCache = { ...SMTP_DEFAULT, from: m["smtp_from"]?.trim() || SMTP_DEFAULT.from, fromName: m["smtp_from_name"]?.trim() || SMTP_DEFAULT.fromName };
      smtpCachedAt = now;
      return smtpCache;
    }

    const port = parseInt(portStr, 10);
    const secureStr = m["smtp_secure"]?.trim().toLowerCase();
    const secure = secureStr === "true" || port === 465;

    smtpCache = {
      host, port, secure, user, pass,
      from: m["smtp_from"]?.trim() || SMTP_DEFAULT.from,
      fromName: m["smtp_from_name"]?.trim() || SMTP_DEFAULT.fromName,
    };
    smtpCachedAt = now;
    return smtpCache;
  } catch (err) {
    logger.error({ err }, "Failed to load SMTP from DB — using hardcode fallback");
    return SMTP_DEFAULT;
  }
}

export interface SendEmailInput {
  to: string; subject: string; text: string; html?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const config = await getSmtpConfig();

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
  });

  await transporter.sendMail({
    from: `"${config.fromName}" <${config.from}>`,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html ?? `<div style="font-family:sans-serif;max-width:600px">${input.text.replace(/\n/g, "<br>")}</div>`,
  });

  logger.info({ to: input.to, subject: input.subject }, "Email sent");
}

export async function sendOtpEmail(to: string, otp: string, purpose: "login" | "signup"): Promise<void> {
  const subject = purpose === "signup" ? "Kode Verifikasi MaxiChat" : "Kode Login MaxiChat";
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
      <h2 style="color:#1a1a1a">${purpose === "signup" ? "Verifikasi Pendaftaran" : "Login ke MaxiChat"}</h2>
      <p style="color:#555">Masukkan kode berikut di halaman MaxiChat:</p>
      <div style="background:#f4f4f4;border-radius:12px;padding:32px;text-align:center;margin:24px 0">
        <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#1a1a1a;font-family:monospace">${otp}</span>
      </div>
      <p style="color:#666;font-size:14px">Berlaku <strong>10 menit</strong>. Jangan bagikan kepada siapapun.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Jika Anda tidak merasa request ini, abaikan email ini.</p>
    </div>`;
  await sendEmail({ to, subject, text: `Kode OTP Anda: ${otp}\n\nBerlaku 10 menit.\n\n— Tim MaxiChat`, html });
}

export async function sendAgentInvitationEmail(
  to: string, invitedByName: string, invitationToken: string, appUrl: string
): Promise<void> {
  const link = `${appUrl}/invite/verify?token=${invitationToken}`;
  const subject = `Undangan bergabung ke tim MaxiChat dari ${invitedByName}`;
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
      <h2 style="color:#1a1a1a">Undangan Tim MaxiChat</h2>
      <p style="color:#555"><strong>${invitedByName}</strong> mengundang Anda bergabung ke tim MaxiChat.</p>
      <div style="text-align:center;margin:32px 0">
        <a href="${link}" style="background:#2563eb;color:#fff;padding:16px 32px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block">
          Verifikasi Email &amp; Bergabung
        </a>
      </div>
      <p style="color:#666;font-size:13px">Link: <a href="${link}" style="color:#2563eb">${link}</a><br>Berlaku <strong>24 jam</strong>.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Setelah verifikasi, login ke MaxiChat menggunakan OTP yang dikirim ke email ini.</p>
    </div>`;
  await sendEmail({ to, subject, text: `${invitedByName} mengundang Anda ke MaxiChat.\n\nKlik: ${link}\n\nBerlaku 24 jam.\n\n— Tim MaxiChat`, html });
}

// Legacy: kept for drip campaign compatibility
export function emailSenderConfigured(): boolean {
  return true;
}

export interface SendVerificationEmailInput {
  to: string;
  name: string | null;
  verifyUrl: string;
}

export async function sendVerificationEmail(input: SendVerificationEmailInput): Promise<{ sent: boolean; devVerifyUrl?: string }> {
  try {
    await sendEmail({
      to: input.to,
      subject: "Verify Your MaxiChat Account",
      text: `Hi ${input.name || input.to},\n\nVerify your email: ${input.verifyUrl}\n\nExpires in 24 hours.\n\n— MaxiChat`,
    });
    return { sent: true };
  } catch (err) {
    logger.error({ err, to: input.to }, "sendVerificationEmail failed");
    return { sent: false, devVerifyUrl: process.env.NODE_ENV !== "production" ? input.verifyUrl : undefined };
  }
}

export interface SendTransactionalEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<void> {
  await sendEmail(input);
}
