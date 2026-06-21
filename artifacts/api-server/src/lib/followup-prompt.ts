// Shared, db-free follow-up prompt assembly. Used by BOTH follow-up generators
// (sales-assistant `follow-up-message.ts` and ai-pipeline `ai-pipeline-followup.ts`)
// so the two paths can never diverge again: same persona source (Lapis A from
// AI Studio), same task instruction (Lapis B), same locked guardrails (Lapis C),
// same per-touch tone (TONE_BY_FU).
//
// 3-lapis contract (see lib/ai-guardrails.ts):
//   Lapis A — tenant.systemPrompt  (persona, edited in AI Studio / wizard)
//   Lapis B — INSTRUKSI_FOLLOWUP   (task + conversation anchor, built here)
//   Lapis C — AI_HARD_GUARDRAILS   (locked, always last)
import { AI_HARD_GUARDRAILS } from "./ai-guardrails";

// Per-touch tone guidance. FU number → message direction. The further into the
// sequence, the lighter the touch. SINGLE SOURCE for both generators.
export const TONE_BY_FU: Record<number, string> = {
  1: "santai, sekadar menyambung konteks obrolan sebelumnya tanpa menagih",
  2: "helpful — beri nilai/info yang berguna, bukan sekadar menanyakan jadi atau tidak",
  3: "tulus; ini pesan terakhir, tutup dengan ramah dan biarkan pintu tetap terbuka",
};

export function toneForFollowup(followupNumber: number): string {
  return TONE_BY_FU[followupNumber] ?? TONE_BY_FU[1]!;
}

export interface FollowupContext {
  // 1-based touch number (1..3).
  followupNumber: number;
  // The unresolved thing the customer last raised / their objection — the
  // PRIMARY anchor for a non-template follow-up. null when none was detected.
  lastOpenPoint?: string | null;
  // Why the conversation stalled, as short as possible. null when unknown.
  stalledReason?: string | null;
  // Products of interest from the prior analysis (priority context, not a
  // default answer).
  productInterest?: string | null;
  // Free-text analysis notes about the customer's need.
  aiNotes?: string | null;
  // Customer's language register/tone, detected ONCE at analysis time. When set,
  // it's the authoritative style for every touch (FU1..FU3) so the voice stays
  // consistent; when null, the generator falls back to mirroring the last message.
  customerTone?: string | null;
  // Customer display name, if known.
  contactName?: string | null;
  // Pre-formatted recent conversation (oldest → newest), one line per message.
  // Empty string when there is no prior conversation.
  recentMessages?: string | null;
}

function orNone(v: string | null | undefined, fallback: string): string {
  const t = (v ?? "").toString().trim();
  return t.length > 0 ? t : fallback;
}

// Lapis B — task + conversation anchor. Persona lives in Lapis A, so this never
// redefines speaking style; it only states the task and the context to read,
// prioritizing the open point over the product label (§3.5 anti-template).
export function buildFollowupInstruction(ctx: FollowupContext): string {
  const recent = orNone(
    ctx.recentMessages,
    "(belum ada percakapan sebelumnya — tulis pembuka follow-up yang hangat dan menyambung)"
  );

  // When analysis already detected the customer's register, lead with it so the
  // tone is consistent across FU1..FU3 instead of drifting per message.
  const tone = (ctx.customerTone ?? "").trim();
  const toneLine = tone
    ? `\n- REGISTER CUSTOMER (hasil analisa percakapan — INI ACUAN UTAMA, ikuti konsisten): ${tone}. Tetap cek pesan terakhir, tapi jangan menyimpang dari gaya ini.`
    : "";

  return `TUGAS SAAT INI: kamu menulis SATU pesan follow-up WhatsApp untuk customer yang sebelumnya ngobrol tapi belum lanjut. LANJUTKAN obrolan sebelumnya — jangan menyapa seperti baru kenal. Pakai gaya & panggilan yang sama seperti yang sudah ditetapkan di atas (jangan berubah jadi formal).

GAYA BAHASA (PALING PENTING — bikin pesan terasa dari manusia, bukan bot):${toneLine}
- Tulis seperti kamu lagi chat ke TEMAN yang kamu kenal, bukan customer service korporat. Santai dan hangat.
- BACA dulu cara customer ngetik di "Pesan terakhir", lalu CERMIN register-nya:
  • Kalau dia santai/akrab (singkatan, "gpp", "oke kak", emoji, huruf kecil) → balas santai juga, boleh pakai singkatan & sapaan yang sama.
  • Kalau dia sopan tapi tetap luwes → balas sopan tapi tetap akrab, jangan kaku.
  • Pakai sapaan yang DIA pakai / yang cocok (kak, bro, mas, dll) — jangan ganti-ganti.
- Default condong ke SANTAI & ramah. Lebih baik kurang formal daripada terlalu formal.
- HINDARI frasa kaku ala template CS: "Dengan ini kami informasikan", "Mohon konfirmasinya", "Baik kak, untuk hal tersebut", "Terima kasih atas waktunya", "Apakah ada yang bisa kami bantu". Ganti dengan bahasa ngobrol biasa.
- Boleh pakai 1 emoji ringan kalau cocok dengan nada customer (jangan dipaksa).
- Pesan pendek, langsung, terasa diketik orang — bukan paragraf rapi yang sempurna.

CARA MENULIS (urutan prioritas konteks):
1. Kalau ada "Hal yang menggantung", JADIKAN ITU inti pesan — singgung hal spesifik itu, lalu tawarkan bantuan menyelesaikannya. Ini yang bikin pesan terasa nyambung, bukan template.
2. Kalau tidak ada hal menggantung, rujuk produk yang diminati secukupnya dengan ramah, tanpa memaksa.
3. Selalu bercermin pada pesan terakhir untuk nada & bahasa. Balas pakai bahasa yang sama dengan percakapan sebelumnya.

KONTEKS PERCAKAPAN (baca dulu sebelum menulis):
- Pesan terakhir:
${recent}
- Hal yang menggantung (prioritas utama): ${orNone(ctx.lastOpenPoint, "(tidak ada yang spesifik)")}
- Kenapa percakapan berhenti: ${orNone(ctx.stalledReason, "(tidak diketahui)")}
- Produk yang diminati: ${orNone(ctx.productInterest, "(belum spesifik)")}
- Catatan analisa: ${orNone(ctx.aiNotes, "(tidak ada)")}
- Nama customer (kalau ada): ${orNone(ctx.contactName, "(tidak diketahui)")}

- Ini follow-up nomor ${ctx.followupNumber} dari maksimal 3.
- Arah pesan: ${toneForFollowup(ctx.followupNumber)}

Contoh (tiru cara merujuk konteksnya, BUKAN produknya):
❌ "Halo kak, masih minat produknya?"  (template, tidak nyambung)
❌ "Halo kak, masih mempertimbangkan Mesin UV DTF-nya?"  (cuma label produk)
❌ "Selamat siang, kami ingin menindaklanjuti percakapan sebelumnya mengenai Mesin UV DTF. Apakah ada yang bisa kami bantu?"  (kaku, formal, jelas bot)
✅ "Halo kak! Soal Mesin UV DTF kemarin — tadi sempat nanya bisa cicilan atau nggak ya. Itu bisa kok, mau aku bantu jelasin? 😊"  (menyinggung hal yang menggantung → terasa lanjutan obrolan)

Contoh CERMIN register (samakan nada dengan customer):
- Customer santai ("gpp kak nanti aku pikir2 dulu") → ✅ "Sip kak, santai aja 😄 btw soal cicilan yg kemarin, kalau mau aku bantu itungin tinggal bilang ya"
- Customer sopan ("Baik, terima kasih infonya, saya pertimbangkan dulu") → ✅ "Siap kak, monggo dipikir dulu 🙏 kalau ada yang mau ditanya soal cicilannya, aku bantu ya"

Pakai nama customer kalau tersedia. Output HANYA teks pesan yang akan dikirim: tanpa penjelasan, tanpa JSON, tanpa preamble.`;
}

// Assemble the full 3-lapis follow-up system prompt. `tenantSystemPrompt` is
// Lapis A (persona); Lapis C (AI_HARD_GUARDRAILS) is always appended LAST so the
// hard rules win even if the persona is edited or "perhalus"-ed.
export function buildFollowupSystemPrompt(
  tenantSystemPrompt: string,
  ctx: FollowupContext
): string {
  const persona = (tenantSystemPrompt ?? "").trim();
  return `${persona}\n\n${buildFollowupInstruction(ctx)}\n\n${AI_HARD_GUARDRAILS}`;
}
