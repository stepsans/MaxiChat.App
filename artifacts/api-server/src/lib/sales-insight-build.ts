// Pure (db-free) helpers for AI Sales Assistant lead detection. All heuristics,
// the AI output contract, transcript formatting, and the model-output parser
// live here so they are unit-testable without importing the database layer.

// ---- Score categories -------------------------------------------------------

export type ScoreCategory = "Low" | "Medium" | "High";

export function scoreCategory(score: number): ScoreCategory {
  const s = clampScore(score);
  if (s >= 70) return "High";
  if (s >= 40) return "Medium";
  return "Low";
}

export function clampScore(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(0, Math.round(v)));
}

// ---- Waiting status ---------------------------------------------------------

export type WaitingStatus = "waiting_customer" | "waiting_company";

export function deriveWaitingStatus(
  lastDirection: "inbound" | "outbound" | null | undefined
): WaitingStatus | null {
  if (lastDirection === "outbound") return "waiting_customer";
  if (lastDirection === "inbound") return "waiting_company";
  return null;
}

// ---- Money ------------------------------------------------------------------

export function sanitizeEstimatedValue(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

// ---- Transcript -------------------------------------------------------------

export interface TranscriptMessage {
  direction: "inbound" | "outbound" | string;
  content: string | null | undefined;
  senderName?: string | null;
}

export function buildTranscript(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => {
      const who = m.direction === "outbound" ? "Company" : "Customer";
      const body = (m.content ?? "").trim();
      return `${who}: ${body || "[media/non-text message]"}`;
    })
    .join("\n");
}

// ---- AI output contract -----------------------------------------------------

// Key quotes extracted by the AI for one opportunity's evidence panel.
export interface KeyQuotes {
  positive: string[]; // paraphrase of positive purchase signals
  negative: string[]; // paraphrase of objections / hesitation signals
  verbatim: string[]; // exact customer quotes (word-for-word)
}

// One detected intent cluster = one opportunity candidate.
export interface OpportunityCandidate {
  intentKey: string;        // stable slug, e.g. "mesin-lem-x200-purchase"
  intentType: "purchase" | "service" | "renewal" | "other";
  pipelineType: "sales" | "service" | "custom";
  products: string[];       // product names/codes relevant to this cluster
  intentCategory: string;   // "hot" | "warm" | "cold"
  leadScore: number;        // 0–100
  estimatedValueIdr: number;
  scoreReason: string | null;
  aiNotes: string | null;
  recommendation: string | null;
  // Follow-up anchors (§3.5): the unresolved point / objection the customer
  // last raised, and why the chat stalled. null when none — never fabricated.
  lastOpenPoint: string | null;
  stalledReason: string | null;
  keyQuotes: KeyQuotes;
}

// Full AI response (array of candidates, may be empty).
export interface SalesInsightAnalysis {
  opportunities: OpportunityCandidate[];
  // Top-level aggregate for the chat insight row (backwards-compat with sidebar).
  leadScore: number;
  intentCategory: string | null;
  estimatedValueIdr: number;
  productInterest: string[];
  scoreReason: string | null;
  aiNotes: string | null;
  recommendation: string | null;
  lastOpenPoint: string | null;
  stalledReason: string | null;
}

// ---- System prompt ----------------------------------------------------------

export function buildAnalysisSystemPrompt(catalogText: string): string {
  return `Anda adalah AI Sales Assistant yang menganalisa percakapan WhatsApp antara CUSTOMER dan COMPANY (toko) untuk mendeteksi peluang penjualan (opportunity).

TUGAS UTAMA:
Identifikasi SEMUA intent pembelian/layanan yang BERBEDA dalam percakapan ini. Setiap produk atau layanan yang berbeda = satu opportunity terpisah.

ATURAN PENGELOMPOKAN:
- Tanya harga produk A + tanya stok produk A = SATU opportunity (topik sama)
- Tanya produk A + tanya produk B = DUA opportunity terpisah
- Permintaan service/perbaikan = opportunity dengan pipeline_type "service"
- Jika tidak ada intent yang jelas, kembalikan "opportunities": []

ATURAN intent_key:
- Buat slug lowercase-hyphen yang STABIL dan unik per topik
- Contoh: "mesin-lem-x200-purchase", "service-mesin-laminasi", "laminasi-beli"
- Harus konsisten walau percakapan berlanjut di masa mendatang

ATURAN key_quotes:
- verbatim: salin PERSIS kata-kata customer, jangan parafrase, maksimal 3 kutipan
- positive: sinyal kuat pembelian (parafrase singkat), maksimal 3
- negative: keberatan atau sinyal negatif (parafrase singkat), maksimal 2
- Boleh array kosong jika tidak ada

ATURAN uang: semua nilai dalam Rupiah bulat (integer), tanpa titik/koma/teks. "Rp 1.500.000" → 1500000.

PANDUAN SKOR (0–100):
Tinggi (70–100): sebut jumlah unit, sebut budget, tanya jadwal kirim, minta penawaran resmi, ada urgensi
Sedang (40–69): tanya harga/spesifikasi detail, bandingkan produk, diskusi serius
Rendah (0–39): hanya menyapa, basa-basi, pertanyaan sangat umum

ATURAN MUTLAK: Balas HANYA dengan satu objek JSON valid. Tanpa teks lain, tanpa code fence.
Bahasa teks (scoreReason, aiNotes, recommendation, intentCategory): Bahasa Indonesia.

FORMAT JSON WAJIB:
{
  "opportunities": [
    {
      "intent_key": "<slug-stabil>",
      "intent_type": "purchase" | "service" | "renewal" | "other",
      "pipeline_type": "sales" | "service",
      "products": ["<nama produk dari katalog>"],
      "intent_category": "hot" | "warm" | "cold",
      "lead_score": <0–100>,
      "estimated_value_idr": <integer Rupiah, 0 jika belum bisa diperkirakan>,
      "score_reason": "<sinyal positif dan negatif di balik skor>",
      "ai_notes": "<ringkasan kebutuhan customer untuk topik ini>",
      "recommendation": "<saran tindakan berikutnya untuk sales>",
      "last_open_point": "<hal terakhir yang menggantung / pertanyaan customer yang belum tuntas dijawab / keberatan yang dia sampaikan. null kalau tidak ada yang jelas — JANGAN mengarang>",
      "stalled_reason": "<alasan percakapan berhenti, sependek mungkin. null kalau tidak jelas>",
      "key_quotes": {
        "positive": ["<sinyal positif 1>", "..."],
        "negative": ["<keberatan 1>"],
        "verbatim": ["<kutipan langsung customer 1>", "..."]
      }
    }
  ]
}

--- KATALOG PRODUK ---
${catalogText || "Belum ada produk di katalog."}
--- END KATALOG PRODUK ---`;
}

// ---- Parser -----------------------------------------------------------------

function toStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length ? t : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function toStringArray(v: unknown, max = 50): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x.length > 0)
    .slice(0, max);
}

function parseKeyQuotes(v: unknown): KeyQuotes {
  const empty: KeyQuotes = { positive: [], negative: [], verbatim: [] };
  if (!v || typeof v !== "object" || Array.isArray(v)) return empty;
  const o = v as Record<string, unknown>;
  return {
    positive: toStringArray(o.positive, 3),
    negative: toStringArray(o.negative, 2),
    verbatim: toStringArray(o.verbatim, 3),
  };
}

function parseCandidate(raw: unknown): OpportunityCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const intentKey = toStr(o.intent_key);
  if (!intentKey) return null; // intent_key is required

  const intentTypeRaw = toStr(o.intent_type) ?? "purchase";
  const intentType = (
    ["purchase", "service", "renewal", "other"].includes(intentTypeRaw)
      ? intentTypeRaw
      : "purchase"
  ) as OpportunityCandidate["intentType"];

  const pipelineTypeRaw = toStr(o.pipeline_type) ?? "sales";
  const pipelineType = (
    ["sales", "service", "custom"].includes(pipelineTypeRaw)
      ? pipelineTypeRaw
      : "sales"
  ) as OpportunityCandidate["pipelineType"];

  return {
    intentKey,
    intentType,
    pipelineType,
    products: toStringArray(o.products, 20),
    intentCategory: toStr(o.intent_category) ?? "warm",
    leadScore: clampScore(o.lead_score),
    estimatedValueIdr: sanitizeEstimatedValue(o.estimated_value_idr),
    scoreReason: toStr(o.score_reason),
    aiNotes: toStr(o.ai_notes),
    recommendation: toStr(o.recommendation),
    lastOpenPoint: toAnchorText(o.last_open_point),
    stalledReason: toAnchorText(o.stalled_reason),
    keyQuotes: parseKeyQuotes(o.key_quotes),
  };
}

// Like toStr but also drops a literal "null" string, so a model that emits
// "null" (instead of JSON null) never becomes a fabricated follow-up anchor.
function toAnchorText(v: unknown): string | null {
  const s = toStr(v);
  if (!s || s.toLowerCase() === "null") return null;
  return s;
}

// Defensively parse the model output into a validated analysis. Returns null
// only when no JSON object can be recovered at all — the caller treats null as
// an explicit failure and MUST NOT fabricate a result.
export function parseInsight(content: string): SalesInsightAnalysis | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return null;

  const tryParse = (s: string): unknown => {
    try { return JSON.parse(s); } catch { return undefined; }
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
  const rawOpps = Array.isArray(obj.opportunities) ? obj.opportunities : [];
  const opportunities = rawOpps
    .map(parseCandidate)
    .filter((c): c is OpportunityCandidate => c !== null);

  // Aggregate top-level fields from the highest-scored opportunity (backwards
  // compat for the per-chat insights sidebar which expects a single score).
  const top = [...opportunities].sort((a, b) => b.leadScore - a.leadScore)[0];

  return {
    opportunities,
    leadScore: top?.leadScore ?? 0,
    intentCategory: top?.intentCategory ?? null,
    estimatedValueIdr: top?.estimatedValueIdr ?? 0,
    productInterest: [
      ...new Set(opportunities.flatMap((o) => o.products)),
    ],
    scoreReason: top?.scoreReason ?? null,
    aiNotes: top?.aiNotes ?? null,
    recommendation: top?.recommendation ?? null,
    lastOpenPoint: top?.lastOpenPoint ?? null,
    stalledReason: top?.stalledReason ?? null,
  };
}
