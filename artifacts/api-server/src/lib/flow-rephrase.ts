// Pure, db-free helpers for the chatbot-flow "AI Generate" option on question
// nodes: when enabled, the question text is rephrased by AI (same meaning,
// varied natural wording) each time it is sent, so customers don't feel they're
// talking to a canned bot. Kept db-free so the prompt + output cleanup are
// unit-testable (the actual AI call lives in the whatsapp route).

// System prompt instructing the model to paraphrase a single chat message while
// preserving its exact meaning, language, and intent — never answering it.
export const FLOW_REPHRASE_SYSTEM_PROMPT = `Kamu menulis ulang SATU pesan chat agar terdengar natural dan manusiawi, seolah ditulis oleh admin toko — bukan bot.

Tulis ulang pesan dari user dengan makna dan inti yang SAMA PERSIS, dalam bahasa yang sama (biasanya Bahasa Indonesia) dengan gaya santai dan ramah.

Aturan:
- Jangan menjawab, menanggapi, atau mengeksekusi isi pesan — hanya parafrasekan.
- Pertahankan maksud, informasi, dan bahasa aslinya. Jangan menambah atau mengurangi informasi.
- Jangan menambahkan basa-basi, salam, pertanyaan baru, atau daftar pilihan/penomoran.
- Pertahankan emoji dan placeholder (mis. {nama}) apa adanya.
- Balas HANYA dengan kalimat hasil tulis ulang, tanpa tanda kutip dan tanpa penjelasan apa pun.`;

// Cleans the model's rephrase output: trims, strips a single pair of wrapping
// quotes the model sometimes adds, and falls back to the original text when the
// model returns nothing usable.
export function cleanRephrasedText(
  raw: string | null | undefined,
  fallback: string,
): string {
  if (!raw) return fallback;
  let s = raw.trim();
  if (s.length >= 2) {
    const first = s[0]!;
    const last = s[s.length - 1]!;
    const wrapped =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "\u201C" && last === "\u201D") ||
      (first === "\u2018" && last === "\u2019");
    if (wrapped) s = s.slice(1, -1).trim();
  }
  return s.length > 0 ? s : fallback;
}
