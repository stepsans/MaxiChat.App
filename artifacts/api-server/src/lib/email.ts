import nodemailer from "nodemailer";
import { Resend } from "resend";
import { db } from "@workspace/db";
import { platformSettingsTable } from "@workspace/db";
import { logger } from "./logger";

let emailCache: EmailConfig | null = null;
let emailCachedAt = 0;
const CACHE_TTL = 60_000;

type EmailProvider = "resend" | "gmail";

interface EmailConfig {
  provider: EmailProvider | null;
  from: string;
  fromName: string;
  resendApiKey?: string;
  gmail?: {
    user: string;
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  };
}

export function invalidateEmailCache(): void {
  emailCache = null;
  emailCachedAt = 0;
}

async function getEmailConfig(): Promise<EmailConfig> {
  const now = Date.now();
  if (emailCache && now - emailCachedAt < CACHE_TTL) return emailCache;

  const rows = await db.select().from(platformSettingsTable);
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value;

  const provider = m["email_provider"]?.trim() as EmailProvider | undefined;

  const resendApiKey = m["resend_api_key"]?.trim();
  const gmailUser = m["gmail_user"]?.trim();
  const gmailClientId = m["gmail_client_id"]?.trim();
  const gmailClientSecret = m["gmail_client_secret"]?.trim();
  const gmailRefreshToken = m["gmail_refresh_token"]?.trim();
  const gmailConfigured = !!(gmailUser && gmailClientId && gmailClientSecret && gmailRefreshToken);

  if (provider === "gmail" && gmailConfigured) {
    emailCache = {
      provider: "gmail",
      from: gmailUser!,
      fromName: m["gmail_from_name"]?.trim() || "MaxiChat",
      gmail: { user: gmailUser!, clientId: gmailClientId!, clientSecret: gmailClientSecret!, refreshToken: gmailRefreshToken! },
    };
  } else if (provider === "resend" && resendApiKey) {
    emailCache = {
      provider: "resend",
      resendApiKey,
      from: m["resend_from"]?.trim() || "noreply@maxichat.app",
      fromName: m["resend_from_name"]?.trim() || "MaxiChat",
    };
  } else {
    // No explicit provider, or the chosen one is incomplete — use whichever is fully configured
    if (resendApiKey) {
      emailCache = {
        provider: "resend",
        resendApiKey,
        from: m["resend_from"]?.trim() || "noreply@maxichat.app",
        fromName: m["resend_from_name"]?.trim() || "MaxiChat",
      };
    } else if (gmailConfigured) {
      emailCache = {
        provider: "gmail",
        from: gmailUser!,
        fromName: m["gmail_from_name"]?.trim() || "MaxiChat",
        gmail: { user: gmailUser!, clientId: gmailClientId!, clientSecret: gmailClientSecret!, refreshToken: gmailRefreshToken! },
      };
    } else {
      emailCache = { provider: null, from: "", fromName: "MaxiChat" };
    }
  }

  emailCachedAt = now;
  return emailCache;
}

export interface SendEmailInput {
  to: string; subject: string; text: string; html?: string;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  const config = await getEmailConfig();
  const html = input.html ?? `<div style="font-family:sans-serif;max-width:600px">${input.text.replace(/\n/g, "<br>")}</div>`;

  if (config.provider === "resend") {
    const resend = new Resend(config.resendApiKey!);
    const { error } = await resend.emails.send({
      from: `${config.fromName} <${config.from}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html,
    });
    if (error) throw new Error(`Resend error: ${error.message}`);
    logger.info({ to: input.to, subject: input.subject, provider: "resend" }, "Email sent");
    return;
  }

  if (config.provider === "gmail") {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        type: "OAuth2",
        user: config.gmail!.user,
        clientId: config.gmail!.clientId,
        clientSecret: config.gmail!.clientSecret,
        refreshToken: config.gmail!.refreshToken,
      },
    });
    await transporter.sendMail({
      from: `"${config.fromName}" <${config.from}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html,
    });
    logger.info({ to: input.to, subject: input.subject, provider: "gmail" }, "Email sent");
    return;
  }

  throw new Error(
    "Email provider belum dikonfigurasi. Pilih Resend atau Gmail OAuth di Platform Settings."
  );
}

export async function sendOtpEmail(to: string, otp: string, purpose: "login" | "signup"): Promise<void> {
  const subject = purpose === "signup" ? "Kode Verifikasi MaxiChat" : "Kode Login MaxiChat";
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
      <h2 style="color:#1a1a1a">${purpose === "signup" ? "Verifikasi Pendaftaran" : "Login ke MaxiChat"}</h2>
      <p style="color:#555">Masukkan kode berikut di halaman MaxiChat:</p>
      <div style="background:#fff7ed;border-radius:12px;padding:32px;text-align:center;margin:24px 0;border:2px solid #fed7aa">
        <span style="font-size:40px;font-weight:bold;letter-spacing:12px;color:#ea580c;font-family:monospace">${otp}</span>
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
        <a href="${link}" style="background:#ea580c;color:#fff;padding:16px 32px;border-radius:10px;text-decoration:none;font-weight:bold;display:inline-block">
          Verifikasi Email &amp; Bergabung
        </a>
      </div>
      <p style="color:#666;font-size:13px">Link: <a href="${link}" style="color:#ea580c">${link}</a><br>Berlaku <strong>24 jam</strong>.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Setelah verifikasi, login ke MaxiChat menggunakan OTP yang dikirim ke email ini.</p>
    </div>`;
  await sendEmail({ to, subject, text: `${invitedByName} mengundang Anda ke MaxiChat.\n\nKlik: ${link}\n\nBerlaku 24 jam.\n\n— Tim MaxiChat`, html });
}

export interface SendVerificationEmailInput {
  to: string; name: string | null; verifyUrl: string;
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
  to: string; subject: string; text: string; html?: string;
}

export async function sendTransactionalEmail(input: SendTransactionalEmailInput): Promise<void> {
  await sendEmail(input);
}
