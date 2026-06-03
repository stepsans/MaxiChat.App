import type { AiReviewColumn } from "@workspace/db";

// The output contract is ALWAYS enforced (reply with one JSON object keyed by
// the exact column names) so the Sheet append never breaks, regardless of the
// per-group task instruction.
const OUTPUT_CONTRACT = `Balas HANYA dengan satu objek JSON, tanpa teks lain. Gunakan nama kolom persis sebagai key JSON. Jika sebuah nilai tidak ada di gambar, isi dengan string kosong "". Untuk nominal uang, tulis angka saja tanpa "Rp" atau pemisah ribuan.`;

// Default task = receipt OCR. A non-empty per-group prompt overrides only the
// task description, letting each group's AI behave differently while the output
// contract + KOLOM list stay constant.
const DEFAULT_TASK = `Anda adalah asisten OCR untuk merekap nota/struk pengeluaran toko berbahasa Indonesia. Baca foto nota lalu ekstrak data sesuai daftar kolom.`;

// Build the system prompt for one AI Review config run. `prompt` is the optional
// per-group instruction; when null/empty/whitespace, the default receipt-OCR
// task is used so existing groups keep their current behavior. The output
// contract and the column list are always appended on top so the JSON →
// Google Sheet append contract is preserved either way.
export function buildAiReviewSystemPrompt(
  prompt: string | null | undefined,
  columns: AiReviewColumn[]
): string {
  const colList = columns
    .map((c, i) => `${i + 1}. "${c.name}"${c.hint ? ` — ${c.hint}` : ""}`)
    .join("\n");
  const customTask = (prompt ?? "").trim();
  const taskInstruction = customTask.length > 0 ? customTask : DEFAULT_TASK;
  return `${taskInstruction}

${OUTPUT_CONTRACT}

KOLOM:
${colList}`;
}
