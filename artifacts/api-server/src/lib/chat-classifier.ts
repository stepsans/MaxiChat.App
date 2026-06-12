/**
 * Chat Routing Classifier
 *
 * Classifies incoming 1:1 WhatsApp messages into business routing categories
 * (complaint, sales, service, billing, onboarding) and writes the result to
 * chats.tag. Runs in parallel across all pipelines and picks the winner by
 * priority → confidence. Built on top of the tenant's own AI client
 * (resolveAiClient) so BYOK tenants use their own key/model.
 */

import { asc, desc, eq } from "drizzle-orm";
import {
  chatsTable,
  chatMessagesTable,
  db,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { logger } from "./logger";

// ─── Pipeline definitions ──────────────────────────────────────────────────────

export interface ChatPipeline {
  id: string;
  name: string;
  priority: number;   // lower = higher priority when two pipelines both match
  minConfidence: number;
  color: string;
  prompt: string | null; // null = uncategorized fallback
  // Which teamRoles can see chats routed to this pipeline in the dashboard.
  teamRoles: Array<"super_admin" | "supervisor" | "agent">;
}

export const CHAT_PIPELINES: ChatPipeline[] = [
  // ── 1. KOMPLAIN  (priority 1 — always wins when emosi negatif terdeteksi) ──
  {
    id: "complaint",
    name: "Pipeline Komplain",
    priority: 1,
    minConfidence: 60,
    color: "#D4537E",
    teamRoles: ["super_admin", "supervisor"],
    prompt: `
Kamu adalah sistem klasifikasi otomatis untuk routing chat pelanggan.

TUGASMU: Tentukan apakah percakapan berikut harus masuk ke PIPELINE KOMPLAIN.

Masukkan ke Pipeline Komplain jika MINIMAL SATU kondisi terpenuhi:
- Pelanggan menggunakan kata kemarahan, frustrasi, atau kekecewaan (marah, kecewa, tidak puas, menipu, bohong, buruk, parah, dll.)
- Pelanggan meminta kompensasi, ganti rugi, atau refund
- Pelanggan mengancam ulasan negatif, laporan ke BPSK, atau tindakan hukum
- Pelanggan melaporkan janji yang tidak ditepati
- Pelanggan merasa diabaikan setelah menunggu lama
- Nada mengandung urgensi tinggi disertai emosi negatif

JANGAN masukkan jika:
- Pelanggan bertanya dengan nada netral meski topiknya bermasalah
- Pelanggan menyampaikan saran secara konstruktif
- Pelanggan melaporkan kerusakan teknis tanpa emosi negatif

FORMAT RESPONS (JSON saja, tanpa teks lain, tanpa backtick):
{"pipeline":"complaint","match":true atau false,"confidence":angka 0-100,"reason":"penjelasan singkat","keywords":["kata kunci"],"urgency":"low atau medium atau high atau critical"}
`,
  },

  // ── 2. SALES  (priority 2) ──────────────────────────────────────────────────
  {
    id: "sales",
    name: "Pipeline Sales",
    priority: 2,
    minConfidence: 65,
    color: "#e87c4e",
    teamRoles: ["super_admin", "supervisor", "agent"],
    prompt: `
Kamu adalah sistem klasifikasi otomatis untuk routing chat pelanggan.

TUGASMU: Tentukan apakah percakapan berikut harus masuk ke PIPELINE SALES.

Masukkan ke Pipeline Sales jika MINIMAL SATU kondisi terpenuhi:
- Pelanggan menanyakan harga, promo, diskon, atau penawaran produk
- Pelanggan ingin membeli, memesan, atau menanyakan stok
- Pelanggan membandingkan produk atau meminta rekomendasi
- Pelanggan menanyakan spesifikasi sebelum membeli
- Pelanggan menanyakan cara pembayaran, cicilan, DP, atau transfer
- Pelanggan menanyakan estimasi pengiriman produk yang belum dibeli
- Pelanggan ingin upgrade ke paket lebih tinggi

JANGAN masukkan jika:
- Topik utama adalah kerusakan atau malfungsi produk yang sudah dibeli
- Pelanggan meminta teknisi atau jadwal servis
- Pelanggan mengajukan komplain atau meminta refund
- Topik utama adalah tagihan pasca-transaksi

FORMAT RESPONS (JSON saja, tanpa teks lain, tanpa backtick):
{"pipeline":"sales","match":true atau false,"confidence":angka 0-100,"reason":"penjelasan singkat","keywords":["kata kunci"]}
`,
  },

  // ── 3. SERVICE  (priority 2) ────────────────────────────────────────────────
  {
    id: "service",
    name: "Pipeline Service",
    priority: 2,
    minConfidence: 65,
    color: "#1D9E75",
    teamRoles: ["super_admin", "supervisor", "agent"],
    prompt: `
Kamu adalah sistem klasifikasi otomatis untuk routing chat pelanggan.

TUGASMU: Tentukan apakah percakapan berikut harus masuk ke PIPELINE SERVICE.

Masukkan ke Pipeline Service jika MINIMAL SATU kondisi terpenuhi:
- Pelanggan melaporkan produk rusak, tidak berfungsi, error, atau bermasalah
- Pelanggan meminta kunjungan teknisi
- Pelanggan menanyakan jadwal servis, perawatan rutin, atau kalibrasi
- Pelanggan melakukan troubleshooting dan butuh panduan teknis
- Pelanggan menanyakan spare part atau suku cadang
- Pelanggan menanyakan garansi untuk kerusakan atau cacat produk
- Pelanggan meminta update firmware, software, atau konfigurasi teknis

JANGAN masukkan jika:
- Pelanggan belum memiliki produk dan hanya menanyakan spesifikasi
- Topik utama adalah harga atau pembelian baru
- Topik utama adalah tagihan atau invoice

FORMAT RESPONS (JSON saja, tanpa teks lain, tanpa backtick):
{"pipeline":"service","match":true atau false,"confidence":angka 0-100,"reason":"penjelasan singkat","keywords":["kata kunci"]}
`,
  },

  // ── 4. BILLING  (priority 2) ────────────────────────────────────────────────
  {
    id: "billing",
    name: "Pipeline Billing",
    priority: 2,
    minConfidence: 70,
    color: "#7F77DD",
    teamRoles: ["super_admin", "supervisor"],
    prompt: `
Kamu adalah sistem klasifikasi otomatis untuk routing chat pelanggan.

TUGASMU: Tentukan apakah percakapan berikut harus masuk ke PIPELINE BILLING.

Masukkan ke Pipeline Billing jika MINIMAL SATU kondisi terpenuhi:
- Pelanggan menanyakan status pembayaran yang sudah dilakukan
- Pelanggan meminta invoice, kwitansi, atau bukti transaksi
- Pelanggan melaporkan salah tagih, double charge, atau tagihan tidak dikenali
- Pelanggan ingin mengubah metode pembayaran atau data faktur
- Pelanggan menanyakan status cicilan atau kredit aktif
- Pelanggan mempertanyakan biaya recurring atau perpanjangan kontrak
- Pelanggan melaporkan pembayaran gagal atau pending terlalu lama

JANGAN masukkan jika:
- Topik utama adalah kerusakan atau servis teknis
- Pelanggan menanyakan harga sebelum membeli (masuk Sales)
- Komplain non-keuangan seperti pengiriman terlambat

FORMAT RESPONS (JSON saja, tanpa teks lain, tanpa backtick):
{"pipeline":"billing","match":true atau false,"confidence":angka 0-100,"reason":"penjelasan singkat","keywords":["kata kunci"]}
`,
  },

  // ── 5. ONBOARDING  (priority 3) ─────────────────────────────────────────────
  {
    id: "onboarding",
    name: "Pipeline Onboarding",
    priority: 3,
    minConfidence: 65,
    color: "#378ADD",
    teamRoles: ["super_admin", "supervisor", "agent"],
    prompt: `
Kamu adalah sistem klasifikasi otomatis untuk routing chat pelanggan.

TUGASMU: Tentukan apakah percakapan berikut harus masuk ke PIPELINE ONBOARDING.

Masukkan ke Pipeline Onboarding jika MINIMAL SATU kondisi terpenuhi:
- Pelanggan baru saja membeli dan menanyakan langkah selanjutnya
- Pelanggan butuh panduan setup, instalasi, atau aktivasi pertama kali
- Pelanggan menanyakan fitur dasar produk yang baru diterima
- Pelanggan tidak mengerti cara penggunaan produk baru
- Pelanggan menanyakan cara login, registrasi akun, atau aktivasi garansi
- Pelanggan menanyakan hal dari panduan "Cara Memulai"

JANGAN masukkan jika:
- Pelanggan sudah lama menggunakan produk
- Masalahnya kerusakan teknis (masuk Service)
- Masalahnya keuangan (masuk Billing)

FORMAT RESPONS (JSON saja, tanpa teks lain, tanpa backtick):
{"pipeline":"onboarding","match":true atau false,"confidence":angka 0-100,"reason":"penjelasan singkat","keywords":["kata kunci"]}
`,
  },

  // ── FALLBACK — jangan ubah priority 99 ──────────────────────────────────────
  {
    id: "uncategorized",
    name: "Pipeline Uncategorized",
    priority: 99,
    minConfidence: 0,
    color: "#888780",
    teamRoles: ["super_admin", "supervisor"],
    prompt: null,
  },

  // ── AUDIT — percakapan yang di-skip karena outgoing-dominan ─────────────────
  // (kamu yang menghubungi supplier/pihak lain, bukan customer yang datang)
  {
    id: "skipped_outgoing",
    name: "Skipped — Outgoing",
    priority: 999,
    minConfidence: 0,
    color: "#555555",
    teamRoles: ["super_admin", "supervisor"],
    prompt: null,
  },
];

// ─── Role access ───────────────────────────────────────────────────────────────

const ROLE_PIPELINE_ACCESS: Record<string, string[]> = {
  super_admin: ["complaint", "sales", "service", "billing", "onboarding", "uncategorized", "skipped_outgoing"],
  supervisor: ["complaint", "sales", "service", "billing", "onboarding", "uncategorized", "skipped_outgoing"],
  agent: ["sales", "service", "onboarding"],
};

export function getPipelinesForTeamRole(
  teamRole: string,
): ChatPipeline[] {
  const allowed = ROLE_PIPELINE_ACCESS[teamRole] ?? ROLE_PIPELINE_ACCESS.agent;
  return CHAT_PIPELINES.filter((p) => allowed.includes(p.id));
}

// ─── Direction analysis ────────────────────────────────────────────────────────
// Membedakan customer yang menghubungi kamu (incoming-dominan → klasifikasi)
// dari kamu yang menghubungi supplier/pihak lain (outgoing-dominan → skip).
// Berjalan sebelum AI dipanggil, jadi percakapan outgoing tidak menghabiskan token.

export interface DirectionAnalysis {
  direction: "incoming" | "outgoing" | "mixed" | "unknown";
  incomingCount: number;
  outgoingCount: number;
  incomingRatio: number;
  shouldClassify: boolean;
  skipReason: string | null;
}

export function analyzeDirection(
  messages: Array<{ fromMe: boolean }>,
): DirectionAnalysis {
  if (messages.length === 0) {
    return {
      direction: "unknown",
      incomingCount: 0,
      outgoingCount: 0,
      incomingRatio: 0,
      shouldClassify: false,
      skipReason: "Tidak ada pesan untuk dianalisis",
    };
  }

  const incomingCount = messages.filter((m) => !m.fromMe).length;
  const outgoingCount = messages.length - incomingCount;
  const incomingRatio = incomingCount / messages.length;

  let direction: DirectionAnalysis["direction"];
  if (incomingRatio >= 0.6) direction = "incoming";
  else if (incomingRatio <= 0.4) direction = "outgoing";
  else direction = "mixed";

  let shouldClassify = true;
  let skipReason: string | null = null;

  if (direction === "outgoing") {
    shouldClassify = false;
    skipReason = `Percakapan outgoing dominan (${outgoingCount} sent vs ${incomingCount} received) — kemungkinan kamu yang menghubungi supplier, bukan customer yang menghubungi kamu`;
  }

  // Edge case: percakapan masih sangat singkat dan kamu yang memulai.
  if (messages.length <= 3 && messages[0]?.fromMe) {
    shouldClassify = false;
    skipReason = `Pesan pertama adalah outgoing dan percakapan masih sangat singkat (${messages.length} pesan) — kemungkinan kamu yang memulai`;
  }

  return {
    direction,
    incomingCount,
    outgoingCount,
    incomingRatio: Math.round(incomingRatio * 100) / 100,
    shouldClassify,
    skipReason,
  };
}

// ─── Level 2: AI direction check ───────────────────────────────────────────────
// Penghitungan rasio (Level 1) tidak bisa membedakan customer vs supplier pada
// percakapan jual-beli dua arah — jumlah pesannya hampir selalu seimbang. Yang
// membedakan adalah SIAPA yang menyatakan niat beli dan bertanya harga. Untuk
// kasus ambigu (mixed, atau kamu yang membuka percakapan), satu panggilan AI
// kecil menentukan peran lawan bicara sebelum pipeline classifier dijalankan.

const DIRECTION_CHECK_PROMPT = `
Kamu adalah sistem analisis percakapan WhatsApp untuk sebuah bisnis.

Setiap pesan diberi label:
[KAMI]   = pesan yang dikirim oleh bisnis kami
[KONTAK] = pesan dari lawan bicara

TUGASMU: Tentukan peran KONTAK terhadap bisnis kami.

- "customer" : KONTAK adalah pembeli/calon pembeli. Pesan [KONTAK] yang menanyakan
  harga, stok, ongkir, total, atau menyatakan niat beli; pesan [KAMI] yang menjawab
  harga dan menawarkan produk.
- "supplier" : KAMI yang membeli dari KONTAK. Pesan [KAMI] yang menanyakan harga,
  stok, ongkir, total, atau menyatakan niat beli ("mau beli...", "saya ambil...");
  pesan [KONTAK] yang menjawab harga, menawarkan barang, atau menanyakan alamat
  pengiriman kami.
- "unclear"  : tidak cukup bukti untuk menentukan.

Perhatikan SIAPA yang:
1. Memulai percakapan dan menyatakan niat beli
2. Menanyakan harga, stok, total, atau ongkos kirim
3. Memberikan alamat pengiriman (pemberi alamat biasanya pembeli)
4. Menjawab dengan harga dan informasi produk (pihak ini penjual)

FORMAT RESPONS (JSON saja, tanpa teks lain, tanpa backtick):
{"contactRole":"customer" atau "supplier" atau "unclear","confidence":angka 0-100,"reason":"1 kalimat alasan"}
`;

interface DirectionCheckResult {
  contactRole: "customer" | "supplier" | "unclear";
  confidence: number;
  reason: string;
}

async function runDirectionCheck(
  labeledTranscript: string,
  client: Awaited<ReturnType<typeof resolveAiClient>>["client"],
  model: string,
): Promise<DirectionCheckResult> {
  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 200,
      messages: [
        { role: "system", content: DIRECTION_CHECK_PROMPT.trim() },
        {
          role: "user",
          content: `Berikut percakapannya:\n\n---\n${labeledTranscript}\n---\n\nTentukan peran KONTAK dalam format JSON.`,
        },
      ],
      temperature: 0,
    });
    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return {
      contactRole: ["customer", "supplier", "unclear"].includes(parsed.contactRole)
        ? parsed.contactRole
        : "unclear",
      confidence: Number(parsed.confidence) || 0,
      reason: String(parsed.reason ?? ""),
    };
  } catch (err) {
    logger.warn({ err }, "chat-classifier: direction check failed — treating as unclear");
    return { contactRole: "unclear", confidence: 0, reason: "Direction check error" };
  }
}

// ─── Classifier engine ─────────────────────────────────────────────────────────

interface ClassifierResult {
  pipeline: string;
  match: boolean;
  confidence: number;
  reason: string;
  keywords: string[];
  urgency?: string;
  priority: number;
  minConfidence: number;
}

async function runSingleClassifier(
  transcript: string,
  pipeline: ChatPipeline,
  client: Awaited<ReturnType<typeof resolveAiClient>>["client"],
  model: string,
): Promise<ClassifierResult> {
  try {
    const response = await client.chat.completions.create({
      model,
      max_tokens: 300,
      messages: [
        { role: "system", content: pipeline.prompt!.trim() },
        {
          role: "user",
          content: `KONTEKS ARAH PERCAKAPAN: Percakapan ini sudah diverifikasi bahwa yang banyak bertanya adalah pihak luar (customer/pelanggan), bukan pihak internal bisnis.\n\nBerikut percakapan pelanggan yang perlu diklasifikasi:\n\n---\n${transcript}\n---\n\nKembalikan hasil dalam format JSON.`,
        },
      ],
      temperature: 0,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as ClassifierResult;

    return {
      ...parsed,
      priority: pipeline.priority,
      minConfidence: pipeline.minConfidence,
    };
  } catch (err) {
    logger.warn(
      { err, pipelineId: pipeline.id },
      "chat-classifier: single pipeline failed",
    );
    return {
      pipeline: pipeline.id,
      match: false,
      confidence: 0,
      reason: `Error: ${(err as Error).message}`,
      keywords: [],
      priority: pipeline.priority,
      minConfidence: pipeline.minConfidence,
    };
  }
}

/**
 * Classify a chat and write the result to chats.tag.
 * Fire-and-forget safe: catches all errors internally and logs them.
 * Returns the winning pipeline id, or "uncategorized" on failure.
 */
export async function classifyAndTagChat(
  chatId: number,
  triggerMessage: string,
  ownerUserId: number,
): Promise<string> {
  try {
    // Opening messages reveal who initiated the relationship; recent messages
    // feed the ratio analysis and the classification transcript.
    const [firstRows, recentRows] = await Promise.all([
      db
        .select({
          id: chatMessagesTable.id,
          direction: chatMessagesTable.direction,
          content: chatMessagesTable.content,
        })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatId, chatId))
        .orderBy(asc(chatMessagesTable.id))
        .limit(5),
      db
        .select({
          id: chatMessagesTable.id,
          direction: chatMessagesTable.direction,
          content: chatMessagesTable.content,
        })
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatId, chatId))
        .orderBy(desc(chatMessagesTable.id))
        .limit(20),
    ]);

    const ordered = recentRows.reverse();

    // ── Level 1: ratio filter (free, no AI call) ──────────────────────────
    // Skip clearly outgoing-dominant conversations (kamu yang menghubungi
    // supplier). The trigger message is always inbound, so an empty history
    // still counts as incoming.
    const directionInput =
      ordered.length > 0
        ? ordered.map((m) => ({ fromMe: m.direction === "outbound" }))
        : [{ fromMe: false }];
    const dir = analyzeDirection(directionInput);

    const skipChat = async (skipReason: string): Promise<string> => {
      await db
        .update(chatsTable)
        .set({ tag: "skipped_outgoing" })
        .where(eq(chatsTable.id, chatId));
      logger.info(
        {
          chatId,
          direction: dir.direction,
          incoming: dir.incomingCount,
          outgoing: dir.outgoingCount,
          skipReason,
        },
        "chat-classifier: skipped — kontak bukan customer",
      );
      return "skipped_outgoing";
    };

    if (!dir.shouldClassify) return skipChat(dir.skipReason ?? "outgoing dominan");

    const { client, model, provider } = await resolveAiClient(ownerUserId);

    // ── Level 2: AI direction check for ambiguous cases ───────────────────
    // Two-way buy/sell chats have near-equal message counts, so the ratio
    // can't tell customer from supplier — who states buying intent can.
    // Triggered when the ratio is mixed OR we opened the conversation.
    const openerFromMe = firstRows[0]?.direction === "outbound";
    if (dir.direction === "mixed" || openerFromMe) {
      const seen = new Set(firstRows.map((m) => m.id));
      const labeledTranscript = [
        ...firstRows,
        ...ordered.filter((m) => !seen.has(m.id)),
      ]
        .map((m) =>
          m.direction === "outbound"
            ? `[KAMI] ${m.content}`
            : `[KONTAK] ${m.content}`,
        )
        .join("\n");

      const check = await runDirectionCheck(labeledTranscript, client, model);
      logger.info(
        { chatId, ...check, openerFromMe },
        "chat-classifier: direction check",
      );
      if (check.contactRole === "supplier" && check.confidence >= 60) {
        return skipChat(`AI direction check: kontak adalah supplier (${check.confidence}%) — ${check.reason}`);
      }
    }

    const transcript =
      ordered.length > 0
        ? ordered
            .slice(-6)
            .map((m) =>
              m.direction === "outbound"
                ? `Agent: ${m.content}`
                : `Pelanggan: ${m.content}`,
            )
            .join("\n")
        : `Pelanggan: ${triggerMessage}`;

    const activePipelines = CHAT_PIPELINES.filter(
      (p) => p.id !== "uncategorized" && p.prompt !== null,
    );

    const results = await Promise.all(
      activePipelines.map((p) => runSingleClassifier(transcript, p, client, model)),
    );

    // Best-effort usage recording — never let it block the routing result.
    void recordAiUsage({
      ownerUserId,
      channelId: 0, // classifier is not channel-specific
      provider,
      model,
      usage: undefined,
    }).catch(() => {});

    const matched = results
      .filter((r) => r.match && r.confidence >= r.minConfidence)
      .sort((a, b) =>
        a.priority !== b.priority
          ? a.priority - b.priority
          : b.confidence - a.confidence,
      );

    const winner = matched[0]?.pipeline ?? "uncategorized";

    await db
      .update(chatsTable)
      .set({ tag: winner })
      .where(eq(chatsTable.id, chatId));

    logger.info(
      { chatId, winner, confidence: matched[0]?.confidence ?? 0 },
      "chat-classifier: routed",
    );

    return winner;
  } catch (err) {
    logger.warn({ err, chatId }, "chat-classifier: classification failed (non-fatal)");
    return "uncategorized";
  }
}
