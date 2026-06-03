import type { AiReviewColumn } from "@workspace/db";

// The output contract is ALWAYS enforced (reply with one JSON object keyed by
// the exact column names) so the Sheet append never breaks, regardless of the
// per-group task instruction.
const OUTPUT_CONTRACT = `Balas HANYA dengan satu objek JSON, tanpa teks lain. Gunakan nama kolom persis sebagai key JSON. Jika sebuah nilai tidak ada di gambar, isi dengan string kosong "". Untuk nominal uang, tulis angka saja tanpa "Rp" atau pemisah ribuan.`;

// Build the system prompt for one AI Review config run. `prompt` is the
// per-group instruction and is REQUIRED — the module does nothing without it
// (the caller guards against empty/whitespace before reaching here). The output
// contract and the column list are always appended on top so the JSON →
// Google Sheet append contract is preserved.
export function buildAiReviewSystemPrompt(
  prompt: string,
  columns: AiReviewColumn[]
): string {
  const taskInstruction = prompt.trim();
  if (taskInstruction.length === 0) {
    throw new Error("Instruksi AI kosong; AI Review tidak dapat dijalankan.");
  }
  const colList = columns
    .map((c, i) => `${i + 1}. "${c.name}"${c.hint ? ` — ${c.hint}` : ""}`)
    .join("\n");
  return `${taskInstruction}

${OUTPUT_CONTRACT}

KOLOM:
${colList}`;
}
