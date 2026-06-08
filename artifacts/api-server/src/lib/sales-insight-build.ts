// Pure (db-free) helpers for AI Sales Assistant lead detection. All heuristics,
// the AI output contract, transcript formatting, and the model-output parser
// live here so they are unit-testable without importing the database layer.
//
// The marketing/user-facing name is always "AI Sales Assistant" — never "CRM".
// All money is whole-integer Rupiah.

// ---- Score categories ------------------------------------------------------

export type ScoreCategory = "Low" | "Medium" | "High";

// 0–39 Low / 40–69 Medium / 70–100 High. Out-of-range input is clamped first.
export function scoreCategory(score: number): ScoreCategory {
  const s = clampScore(score);
  if (s >= 70) return "High";
  if (s >= 40) return "Medium";
  return "Low";
}

// Clamp any numeric-ish input to an integer 0–100. Non-finite → 0.
export function clampScore(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

// ---- Waiting status --------------------------------------------------------

export type WaitingStatus = "waiting_customer" | "waiting_company";

// Who the conversation is waiting on, derived from the direction of the LAST
// message — never from the model:
//   - company (we) sent last  → outbound → WAITING CUSTOMER (their move)
//   - customer sent last      → inbound  → WAITING COMPANY (our move)
//   - no messages             → null
export function deriveWaitingStatus(
  lastDirection: "inbound" | "outbound" | null | undefined
): WaitingStatus | null {
  if (lastDirection === "outbound") return "waiting_customer";
  if (lastDirection === "inbound") return "waiting_company";
  return null;
}

// ---- Money -----------------------------------------------------------------

// Whole-Rupiah sanitiser. Floors to an integer ≥ 0; non-finite/negative → 0.
// The route boundary still re-checks Number.isInteger per repo convention; this
// keeps the model from ever producing a fractional or negative estimate.
export function sanitizeEstimatedValue(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

// ---- Transcript ------------------------------------------------------------

export interface TranscriptMessage {
  direction: "inbound" | "outbound" | string;
  content: string | null | undefined;
  senderName?: string | null;
}

// Render a chronological transcript for the model. Inbound = "Customer",
// outbound = "Company". Empty/whitespace-only messages (e.g. media-only) are
// labelled so the model knows a turn happened without inventing text.
export function buildTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => {
      const who = m.direction === "outbound" ? "Company" : "Customer";
      const body = (m.content ?? "").trim();
      return `${who}: ${body || "[media/non-text message]"}`;
    })
    .join("\n");
}

// ---- AI output contract ----------------------------------------------------

// The strict JSON object the model must return. Waiting status is intentionally
// NOT part of the contract — it is derived deterministically from message
// direction, never trusted to the model.
export interface SalesInsightAnalysis {
  leadScore: number; // 0–100 (clamped)
  intentCategory: string | null; // free-text e.g. "hot"/"warm"/"cold"
  productInterest: string[]; // product names/codes mentioned
  estimatedValueIdr: number; // whole Rupiah ≥ 0
  scoreReason: string | null; // positive/negative signals behind the score
  aiNotes: string | null; // short conversation summary
  recommendation: string | null; // suggested next action
}

// System prompt enforcing the JSON-only output contract. `catalogText` is the
// tenant's live product catalog (already excludes internal tier prices/stock).
export function buildAnalysisSystemPrompt(catalogText: string): string {
  return `Anda adalah AI Sales Assistant yang menganalisa percakapan WhatsApp/Telegram antara CUSTOMER dan COMPANY (toko) untuk menilai potensi penjualan (lead).

Tugas Anda: baca seluruh percakapan, lalu nilai customer ini sebagai calon pembeli.

ATURAN MUTLAK:
- Balas HANYA dengan satu objek JSON valid. Tanpa teks lain, tanpa penjelasan di luar JSON, tanpa code fence.
- Semua nilai uang dalam Rupiah bulat (angka bilangan bulat, tanpa titik/koma/teks). Contoh "Rp 1.500.000" → 1500000.
- Gunakan KATALOG PRODUK di bawah sebagai acuan nama/kode produk. Jangan mengarang produk yang tidak relevan.
- Bahasa untuk teks (scoreReason, aiNotes, recommendation, intentCategory) adalah Bahasa Indonesia.

Format JSON yang WAJIB:
{
  "leadScore": <bilangan bulat 0-100, seberapa besar potensi closing>,
  "intentCategory": <"hot" | "warm" | "cold" — tingkat minat customer>,
  "productInterest": [<nama atau kode produk yang diminati customer; [] jika belum jelas>],
  "estimatedValueIdr": <perkiraan nilai transaksi dalam Rupiah bulat; 0 jika belum bisa diperkirakan>,
  "scoreReason": <penjelasan singkat sinyal POSITIF dan NEGATIF di balik skor>,
  "aiNotes": <ringkasan singkat percakapan dan kebutuhan customer>,
  "recommendation": <saran langkah berikutnya untuk tim sales>
}

Penilaian skor (panduan): tanya harga/stok/ketersediaan, minta penawaran, menyebut budget/jumlah, atau menunjukkan urgensi = sinyal kuat (skor tinggi). Hanya menyapa, basa-basi, atau pertanyaan umum = skor rendah.

--- KATALOG PRODUK ---
${catalogText || "Belum ada produk di katalog."}
--- END KATALOG PRODUK ---`;
}

// ---- Parser ----------------------------------------------------------------

function toStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .slice(0, 50);
}

// Defensively parse the model output into a validated analysis. Models may wrap
// JSON in ``` fences or prose, so we accept a raw object, then fall back to
// substring extraction of the outermost {...}. Returns null when no JSON object
// can be recovered — the caller MUST treat null as an explicit failure and NOT
// fabricate an analysis.
export function parseInsight(content: string): SalesInsightAnalysis | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return null;

  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(trimmed);
  if (parsed === undefined) {
    const os = trimmed.indexOf("{");
    const oe = trimmed.lastIndexOf("}");
    if (os >= 0 && oe > os) parsed = tryParse(trimmed.slice(os, oe + 1));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  return {
    leadScore: clampScore(obj.leadScore),
    intentCategory: toStr(obj.intentCategory),
    productInterest: toStringArray(obj.productInterest),
    estimatedValueIdr: sanitizeEstimatedValue(obj.estimatedValueIdr),
    scoreReason: toStr(obj.scoreReason),
    aiNotes: toStr(obj.aiNotes),
    recommendation: toStr(obj.recommendation),
  };
}
