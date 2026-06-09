import { logger } from "./logger";

// Send an OTP via WhatsApp using the configured MaxiChat OTP channel. When no
// channel is configured (MAXICHAT_OTP_CHANNEL_ID unset) we just log it (dev).
export async function sendWaOtpMessage(
  toPhone: string,
  otp: string
): Promise<void> {
  const otpChannelId = process.env.MAXICHAT_OTP_CHANNEL_ID
    ? parseInt(process.env.MAXICHAT_OTP_CHANNEL_ID, 10)
    : null;

  if (!otpChannelId || Number.isNaN(otpChannelId)) {
    logger.info(
      { toPhone, otp },
      "[DEV] WA OTP — set MAXICHAT_OTP_CHANNEL_ID env var to send via real WA"
    );
    return;
  }

  // Lazy import to avoid a circular dependency: routes/whatsapp.ts pulls in a
  // large dependency graph that would otherwise load at module init time.
  const { getSockForChannel } = await import("../routes/whatsapp");

  const sock = getSockForChannel(otpChannelId);
  if (!sock) {
    logger.warn({ otpChannelId }, "OTP channel socket not available");
    return;
  }

  const cleanPhone = toPhone.replace(/\D/g, "");
  const jid = `${cleanPhone}@s.whatsapp.net`;

  const message = `Kode verifikasi MaxiChat Anda:\n\n*${otp}*\n\nBerlaku 5 menit. Jangan bagikan kode ini ke siapapun.`;

  try {
    await sock.sendMessage(jid, { text: message });
    logger.info({ toPhone: cleanPhone }, "WA OTP sent successfully");
  } catch (err) {
    logger.error({ err, toPhone }, "Failed to send WA OTP via Baileys");
    throw err;
  }
}
