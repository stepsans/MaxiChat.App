import type { AiReviewColumn } from "@workspace/db";

// The output contract is ALWAYS enforced (reply with a JSON array of objects,
// each keyed by the exact column names) so the Sheet append never breaks,
// regardless of the per-group task instruction. One object = one Sheet row, and
// a single nota with several line items must produce several objects.
const OUTPUT_CONTRACT = `Balas HANYA dengan JSON array berisi objek, tanpa teks lain. Setiap objek mewakili SATU baris/item pada nota — jika satu nota memuat 5 item, balas 5 objek (5 baris). Gunakan nama kolom persis sebagai key JSON pada setiap objek. Nilai yang berlaku untuk seluruh nota (mis. tanggal, nomor nota, nama toko, total keseluruhan) diulang sama di setiap objek; nilai khusus per item (mis. nama barang, qty, harga satuan, subtotal) diisi sesuai item masing-masing. Jika sebuah nilai tidak ada di gambar, isi dengan string kosong "". Untuk nominal uang, tulis angka saja tanpa "Rp" atau pemisah ribuan. Jika nota tidak memiliki rincian item, balas array berisi satu objek.`;

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
