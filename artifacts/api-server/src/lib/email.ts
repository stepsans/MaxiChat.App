import { logger } from "./logger";

// Transactional email helper. In production we send via Resend when a
// `RESEND_API_KEY` is present in the environment (set up the Resend
// integration in Replit and the variable becomes available). Without a
// key we run in "dev fallback" mode: the verification link is logged to
// the server console AND returned in the signup/resend API response so
// the operator can manually open it during local testing.
//
// The default "from" address uses `onboarding@resend.dev` which Resend
// allows for testing without a verified domain. Once the user owns
// maxichat.com they can set `EMAIL_FROM=MaxiChat <noreply@maxichat.com>`.

const DEV_FROM = "MaxiChat <onboarding@resend.dev>";

export function emailSenderConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

export interface SendVerificationEmailInput {
  to: string;
  name: string | null;
  verifyUrl: string;
}

export interface SendVerificationEmailResult {
  sent: boolean;
  // Returned only when running in dev-fallback mode so the signup
  // response can surface the link for manual testing. Never populated
  // when an actual provider is configured — we don't want to leak
  // production verify URLs back through the JSON response.
  devVerifyUrl?: string;
}

export async function sendVerificationEmail(
  input: SendVerificationEmailInput
): Promise<SendVerificationEmailResult> {
  const subject = "Verify Your MaxiChat Account";
  const greeting = input.name?.trim() || input.to.split("@")[0];
  const html = renderVerificationHtml({ greeting, verifyUrl: input.verifyUrl });
  const text = renderVerificationText({ greeting, verifyUrl: input.verifyUrl });

  if (!emailSenderConfigured()) {
    // Dev fallback: log the link so a local operator can verify by
    // hand. We only surface the link back through the API response when
    // explicitly running in development — in production a missing
    // provider must NOT leak verification tokens over the public API,
    // since anyone calling /auth/resend-verification with a known email
    // could otherwise harvest live tokens without mailbox access.
    logger.warn(
      { to: input.to, verifyUrl: input.verifyUrl },
      "Email provider not configured — verification link logged (dev fallback)"
    );
    const isDev = process.env.NODE_ENV !== "production";
    return { sent: false, devVerifyUrl: isDev ? input.verifyUrl : undefined };
  }

  const from = process.env.EMAIL_FROM?.trim() || DEV_FROM;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from,
        to: input.to,
        subject,
        html,
        text,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body, to: input.to },
        "Resend send failed"
      );
      return { sent: false };
    }
    logger.info({ to: input.to }, "Verification email sent");
    return { sent: true };
  } catch (err) {
    logger.error({ err, to: input.to }, "Email send threw");
    return { sent: false };
  }
}

function renderVerificationHtml(args: {
  greeting: string;
  verifyUrl: string;
}): string {
  // Inline-styled email template — keeps it readable in Gmail/Outlook
  // which strip <head> styles. Two CTAs: the button and a copyable link.
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6fb;font-family:Inter,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 0">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:36px;box-shadow:0 4px 24px rgba(15,23,42,.06)">
        <tr><td style="padding-bottom:8px">
          <div style="font-weight:700;font-size:20px;color:#2563eb">MaxiChat</div>
        </td></tr>
        <tr><td>
          <h1 style="font-size:22px;margin:16px 0 8px">Hi ${escapeHtml(args.greeting)},</h1>
          <p style="font-size:14px;line-height:1.6;margin:0 0 24px;color:#475569">Welcome to MaxiChat — your all-in-one AI omnichannel platform. Please verify your email address to activate your account.</p>
          <p style="margin:0 0 28px">
            <a href="${args.verifyUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;font-size:14px">Verify Email</a>
          </p>
          <p style="font-size:12px;color:#64748b;margin:0 0 8px">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="font-size:12px;word-break:break-all;color:#2563eb;margin:0 0 24px"><a href="${args.verifyUrl}" style="color:#2563eb">${args.verifyUrl}</a></p>
          <p style="font-size:12px;color:#94a3b8;margin:0">This link expires in 24 hours. If you didn't sign up for MaxiChat, you can safely ignore this email.</p>
        </td></tr>
        <tr><td style="padding-top:32px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">© ${new Date().getFullYear()} MaxiChat. Maximizing Your Chat.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderVerificationText(args: {
  greeting: string;
  verifyUrl: string;
}): string {
  return [
    `Hi ${args.greeting},`,
    ``,
    `Welcome to MaxiChat. Verify your email by opening this link:`,
    args.verifyUrl,
    ``,
    `This link expires in 24 hours.`,
    `If you didn't sign up for MaxiChat, ignore this email.`,
    ``,
    `— MaxiChat`,
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;"
  );
}
