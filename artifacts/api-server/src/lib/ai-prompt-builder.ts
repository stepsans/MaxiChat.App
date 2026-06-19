// AI Setup Wizard — local (db-free) assembler that turns the wizard answers into
// the persona system prompt: LAPIS A (persona) + LAPIS B-bisnis (business context).
// LAPIS C (AI_HARD_GUARDRAILS) is intentionally NOT included here — it is appended
// at runtime by each AI path so it stays a single source and can never be edited
// away. See lib/ai-guardrails.ts and the 3-layer contract in the spec.

export type WizardTone = "mirror" | "warm" | "formal";
export type WizardEmoji = "sedikit" | "minimal" | "bebas";
export type WizardReplyLanguage = "follow" | "id";
export type WizardSelfIntro = "netral" | "admin" | "named";

export interface WizardAnswers {
  businessName: string;
  businessDesc: string;
  flagshipProduct?: string | null;
  orderFlow?: string | null;
  operatingHours?: string | null;
  tone?: WizardTone | null;
  addressTerm?: string | null;
  emoji?: WizardEmoji | null;
  replyLanguage?: WizardReplyLanguage | null;
  selfIntro?: WizardSelfIntro | null;
  selfName?: string | null;
  forbidden?: string | null;
}

// Instruction sent to the model by the optional "Perhalus dengan AI" feature.
// It only ever receives the persona (Lapis A+B); guardrails are re-attached after.
export const REFINE_PERSONA_INSTRUCTION =
  "Perhalus gaya bahasa teks berikut agar lebih natural, hangat, dan manusiawi. " +
  "JANGAN menambah atau mengubah aturan, harga, klaim, atau fakta apa pun. " +
  "Pertahankan SEMUA poin dan struktur. Balas HANYA dengan teks hasil perbaikan, tanpa penjelasan.";

const TONE_LINE: Record<WizardTone, string> = {
  mirror: "Cermin gaya customer: dia santai kamu santai, dia formal kamu ikut rapi. Jangan kaku duluan.",
  warm: "Selalu ramah, hangat, dan akrab — seperti ngobrol sama teman.",
  formal: "Sopan dan profesional, tetap manusiawi dan tidak kaku.",
};

const EMOJI_LINE: Record<WizardEmoji, string> = {
  sedikit: "Emoji tipis: 1-2 per balasan di tempat yang pas. Jangan dihambur, jangan emoji api.",
  minimal: "Hampir tanpa emoji; andalkan kata-kata yang hangat.",
  bebas: "Emoji bebas selama tidak berlebihan.",
};

function clean(v: string | null | undefined): string {
  return (v ?? "").trim();
}

export function buildPersonaPrompt(a: WizardAnswers): string {
  const tone = (a.tone ?? "mirror") as WizardTone;
  const emoji = (a.emoji ?? "sedikit") as WizardEmoji;
  const selfIntro = (a.selfIntro ?? "netral") as WizardSelfIntro;
  const addressTerm = clean(a.addressTerm) || "kak";
  const businessName = clean(a.businessName) || "bisnis ini";

  const toneLine = TONE_LINE[tone] ?? TONE_LINE.mirror;
  const emojiLine = EMOJI_LINE[emoji] ?? EMOJI_LINE.sedikit;
  const langLine =
    (a.replyLanguage ?? "follow") === "id"
      ? "Selalu balas dalam Bahasa Indonesia."
      : "Balas pakai bahasa yang sama dengan customer (ID/EN/campuran).";
  const introLine =
    selfIntro === "admin"
      ? "Kalau perlu menyebut diri, sebut sebagai admin/CS toko."
      : selfIntro === "named" && clean(a.selfName)
        ? `Kalau ditanya, perkenalkan diri sebagai ${clean(a.selfName)} dari ${businessName}.`
        : "";

  const lines: string[] = [];
  lines.push(
    `Kamu customer service yang ngobrol santai kayak teman — ramah, cepat tanggap, manusiawi, dan bantu customer sampai mantap beli. Santai bukan berarti asal: kamu tetap rapi dan bisa diandalkan. Kamu mewakili ${businessName}.`
  );

  lines.push("");
  lines.push("GAYA NGOBROL:");
  lines.push(`- Panggil customer "${addressTerm}". Kalau dia minta dipanggil lain, ikuti.`);
  lines.push(`- ${toneLine}`);
  lines.push('- Ngobrol natural kayak chat WA beneran, bukan template. Boleh "aku", "iya", "oke deh", "siap".');
  lines.push('- Boleh sisipkan reaksi kecil manusiawi: "oh gitu", "bentar aku cek ya", "wah pas nih". Ini yang bikin nggak kaku.');
  lines.push("- Sambungkan konteks pesan sebelumnya; jangan jawab seperti baru kenal.");
  lines.push("- JANGAN buka dengan kalimat template yang sama berulang. Variasikan pembuka.");
  lines.push('- Kalau minta maaf, yang manusiawi ("duh maaf ya"), bukan "mohon maaf atas ketidaknyamanannya".');
  lines.push("- Singkat: 2-4 kalimat. Hangat boleh, jangan ceramah.");
  lines.push(`- ${emojiLine}`);
  lines.push(`- ${langLine}`);
  if (introLine) lines.push(`- ${introLine}`);

  // Few-shot GAYA (rasa, BUKAN produk) — agar tidak terasa robot. Sengaja tidak
  // memakai produk nyata sebagai contoh (hindari few-shot answer anchoring).
  lines.push("");
  lines.push("Contoh GAYA bicara (tiru rasanya, BUKAN produknya):");
  lines.push('❌ "Selamat datang. Ada yang bisa kami bantu?"');
  lines.push(`✅ "Halo ${addressTerm}! Lagi cari yang mana nih? 😊"`);
  lines.push('❌ "Mohon maaf atas ketidaknyamanannya. Silakan hubungi admin."');
  lines.push(`✅ "Duh maaf ya ${addressTerm}, itu aku belum ada infonya. Nanti admin bantu cek ya 🙏"`);
  lines.push('❌ "Baik. Produk tersebut tersedia dengan harga Rp150.000."');
  lines.push(`✅ "Oh yang itu Rp150.000 ${addressTerm}. Mau aku bantuin lanjut ordernya?"`);

  // Konteks bisnis (Lapis B-bisnis). flagshipProduct ditanam HANYA sebagai konteks
  // prioritas berlabel — bukan jawaban default (lihat memory ai-reply-context-anchoring).
  lines.push("");
  lines.push("KONTEKS BISNIS:");
  lines.push(`- Yang dijual: ${clean(a.businessDesc)}`);
  if (clean(a.flagshipProduct)) {
    lines.push(
      `- Produk yang sering ditanya: ${clean(a.flagshipProduct)}. (Ini hanya konteks prioritas — BUKAN jawaban default. Selalu cek knowledge base untuk pertanyaan apa pun.)`
    );
  }
  if (clean(a.orderFlow)) lines.push(`- Cara order & bayar: ${clean(a.orderFlow)}`);
  if (clean(a.operatingHours)) {
    lines.push(
      `- Jam operasional: ${clean(a.operatingHours)}. Di luar jam, sampaikan admin akan balas pada jam kerja.`
    );
  }
  if (clean(a.forbidden)) lines.push(`- Hal yang tidak boleh kamu lakukan (dari owner): ${clean(a.forbidden)}`);

  return lines.join("\n").trim();
}

// Validate + normalize a raw wizard payload (from the client) into WizardAnswers.
// Returns null when a required field is missing.
const VALID_TONE = new Set<WizardTone>(["mirror", "warm", "formal"]);
const VALID_EMOJI = new Set<WizardEmoji>(["sedikit", "minimal", "bebas"]);
const VALID_LANG = new Set<WizardReplyLanguage>(["follow", "id"]);
const VALID_INTRO = new Set<WizardSelfIntro>(["netral", "admin", "named"]);

export function normalizeWizardAnswers(body: unknown): WizardAnswers | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number): string =>
    typeof v === "string" ? v.trim().slice(0, max) : "";
  const optStr = (v: unknown, max: number): string | null => str(v, max) || null;

  const businessName = str(b.businessName, 120);
  const businessDesc = str(b.businessDesc, 2000);
  if (!businessName || !businessDesc) return null;

  const tone = VALID_TONE.has(b.tone as WizardTone) ? (b.tone as WizardTone) : "mirror";
  const emoji = VALID_EMOJI.has(b.emoji as WizardEmoji) ? (b.emoji as WizardEmoji) : "sedikit";
  const replyLanguage = VALID_LANG.has(b.replyLanguage as WizardReplyLanguage)
    ? (b.replyLanguage as WizardReplyLanguage)
    : "follow";
  const selfIntro = VALID_INTRO.has(b.selfIntro as WizardSelfIntro)
    ? (b.selfIntro as WizardSelfIntro)
    : "netral";

  return {
    businessName,
    businessDesc,
    flagshipProduct: optStr(b.flagshipProduct, 300),
    orderFlow: optStr(b.orderFlow, 300),
    operatingHours: optStr(b.operatingHours, 200),
    tone,
    addressTerm: optStr(b.addressTerm, 40) ?? "kak",
    emoji,
    replyLanguage,
    selfIntro,
    selfName: selfIntro === "named" ? optStr(b.selfName, 60) : null,
    forbidden: optStr(b.forbidden, 500),
  };
}
