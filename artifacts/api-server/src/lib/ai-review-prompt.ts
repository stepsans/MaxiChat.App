import type { AiReviewColumn } from "@workspace/db";

// The output contract is ALWAYS enforced (reply with a JSON array of objects,
// each keyed by the exact column names) so the Sheet append never breaks,
// regardless of the per-group task instruction. One object = one Sheet row, and
// a single nota with several line items must produce several objects.
const OUTPUT_CONTRACT = `Balas HANYA dengan JSON array berisi objek, tanpa teks lain. Setiap objek mewakili SATU baris/item pada nota — jika satu nota memuat 5 item, balas 5 objek (5 baris). Gunakan nama kolom persis sebagai key JSON pada setiap objek. Nilai yang berlaku untuk seluruh nota (mis. tanggal, nomor nota, nama toko, total keseluruhan) diulang sama di setiap objek; nilai khusus per item (mis. nama barang, qty, harga satuan, subtotal) diisi sesuai item masing-masing. Jika sebuah nilai tidak ada di dokumen, isi dengan string kosong "". Jika dokumen tidak memiliki rincian item, balas array berisi satu objek.

ATURAN ANGKA/UANG (WAJIB): Nota & invoice berbahasa Indonesia memakai titik "." sebagai pemisah RIBUAN dan koma "," sebagai DESIMAL. Maka "34.000" = 34000 (bukan 34), "1.250.500" = 1250500, "150.000" = 150000, dan "12.500,75" = 12500.75. JANGAN PERNAH menafsirkan titik pada angka rupiah sebagai desimal. Tulis setiap nominal sebagai angka polos TANPA "Rp" dan TANPA pemisah ribuan; pakai titik "." hanya bila benar-benar ada nilai desimal (mis. tulis 12500.75). Contoh: dari teks "Rp 34.000" tulis 34000; dari "Rp 1.250.500" tulis 1250500.`;

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

// System prompt for the "Generate by AI" button: the model reads the per-group
// instruction and proposes the set of output columns (Sheet headers) needed to
// fulfil it. It must reply with ONLY a JSON array of {name, hint} objects so the
// caller can map it straight into the column editor.
export function buildAiReviewColumnSuggestionPrompt(): string {
  return `Anda membantu menyiapkan kolom output Google Sheet untuk fitur rekap foto nota/dokumen. Berdasarkan instruksi pengguna, tentukan daftar kolom (header Sheet) yang paling cocok untuk menampung hasil ekstraksi.

Balas HANYA dengan JSON array berisi objek, tanpa teks lain. Setiap objek mewakili satu kolom dengan bentuk: {"name": "Nama Kolom", "hint": "petunjuk singkat untuk AI mengisi kolom ini"}.

Aturan:
- Gunakan Bahasa Indonesia untuk nama kolom dan petunjuk.
- "name" wajib ringkas dan jelas (mis. "Tanggal", "Nama Barang", "Qty", "Harga Satuan", "Total").
- "hint" menjelaskan secara singkat nilai apa yang diisi di kolom itu.
- Jika instruksi menyiratkan rincian per item (mis. daftar belanja), sertakan kolom per item (nama barang, qty, harga satuan, subtotal) di samping kolom tingkat nota (tanggal, nama toko, total).
- Berikan antara 3 sampai 12 kolom yang relevan. Jangan menambah kolom yang tidak diperlukan.`;
}
