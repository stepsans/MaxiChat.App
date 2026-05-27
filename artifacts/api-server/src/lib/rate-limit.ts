import rateLimit from "express-rate-limit";

// Conservative limits tuned for an auth UI. The window/max numbers are
// per-IP — they're intentionally lenient enough that legitimate users
// who fat-finger a password can recover within seconds, but strict
// enough to slow down credential-stuffing or signup-spam scripts.

export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan pendaftaran. Coba lagi dalam 1 jam." },
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan login. Coba lagi sebentar lagi." },
});

export const verifyEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan verifikasi. Coba lagi sebentar." },
});

export const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Terlalu banyak permintaan resend. Coba lagi dalam 1 jam." },
});
