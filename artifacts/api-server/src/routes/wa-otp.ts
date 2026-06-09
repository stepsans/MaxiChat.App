import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requestWaOtp, verifyWaOtp, isPhoneUsedForTrial } from "../lib/wa-otp";
import { sendWaOtpMessage } from "../lib/wa-otp-sender";

const router = Router();

// Strict rate limit for the OTP endpoints.
const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan OTP. Coba lagi dalam 1 jam." },
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Terlalu banyak percobaan verifikasi. Coba lagi sebentar.",
  },
});

// POST /auth/wa-otp/request
// Body: { phone: string, purpose: 'signup' }
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

    // Has this number already been used for a trial?
    const alreadyUsed = await isPhoneUsedForTrial(phone);
    if (alreadyUsed) {
      res.status(409).json({
        error:
          "Nomor WhatsApp ini sudah pernah digunakan untuk trial MaxiChat. Hubungi tim kami jika ada pertanyaan.",
        reason: "phone_already_used",
      });
      return;
    }

    const result = await requestWaOtp(phone, purpose, req.ip ?? undefined);

    if (!result.ok) {
      if (result.reason === "rate_limited") {
        res.status(429).json({
          error:
            "Terlalu banyak permintaan OTP untuk nomor ini. Coba lagi dalam 1 jam.",
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

    // Deliver via WhatsApp (dev fallback logs the OTP when unconfigured).
    try {
      await sendWaOtpMessage(phone, result.otp);
    } catch (err) {
      req.log.error({ err, phone }, "Failed to send WA OTP message");
      // Don't fail the request — the OTP is still valid in the DB.
    }

    res.json({
      ok: true,
      expiresAt: result.expiresAt.toISOString(),
      // Surface the OTP in dev mode for testing.
      ...(process.env.NODE_ENV !== "production" ? { devOtp: result.otp } : {}),
    });
  } catch (err) {
    req.log.error({ err }, "WA OTP request failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /auth/wa-otp/verify
// Body: { phone: string, otp: string, purpose: 'signup' }
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
