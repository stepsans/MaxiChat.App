// Daftar domain email sekali-pakai yang diblokir untuk TRIAL signup.
// Bukan daftar lengkap — perluas berkala (atau muat dari sumber eksternal
// jika perlu). Owner override (grant-trial) TIDAK terkena blokir ini.
export const DISPOSABLE_DOMAINS = new Set<string>([
  "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
  "temp-mail.org", "yopmail.com", "throwawaymail.com", "getnada.com",
  "trashmail.com", "sharklasers.com", "maildrop.cc", "mintemail.com",
  "fakeinbox.com", "mohmal.com", "dispostable.com", "tempr.email",
  "moakt.com", "emailondeck.com", "spamgourmet.com", "mailnesia.com",
  // tambah sesuai temuan abuse di produksi
]);
