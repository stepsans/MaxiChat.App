/**
 * Chat Routing Classifier
 *
 * Classifies incoming 1:1 WhatsApp messages into business routing categories
 * (complaint, sales, service, billing, onboarding) and writes the result to
 * chats.tag. Runs in parallel across all pipelines and picks the winner by
 * priority → confidence. Built on top of the tenant's own AI client
 * (resolveAiClient) so BYOK tenants use their own key/model.
 */

import { desc, eq } from "drizzle-orm";
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
];

// ─── Role access ───────────────────────────────────────────────────────────────

const ROLE_PIPELINE_ACCESS: Record<string, string[]> = {
  super_admin: ["complaint", "sales", "service", "billing", "onboarding", "uncategorized"],
  supervisor: ["complaint", "sales", "service", "billing", "onboarding", "uncategorized"],
  agent: ["sales", "service", "onboarding"],
};

export function getPipelinesForTeamRole(
  teamRole: string,
): ChatPipeline[] {
  const allowed = ROLE_PIPELINE_ACCESS[teamRole] ?? ROLE_PIPELINE_ACCESS.agent;
  return CHAT_PIPELINES.filter((p) => allowed.includes(p.id));
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
          content: `Berikut percakapan pelanggan yang perlu diklasifikasi:\n\n---\n${transcript}\n---\n\nKembalikan hasil dalam format JSON.`,
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
    // Build a short transcript from the last 5 messages for context.
    const recentRows = await db
      .select({
        direction: chatMessagesTable.direction,
        content: chatMessagesTable.content,
      })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, chatId))
      .orderBy(desc(chatMessagesTable.id))
      .limit(5);

    const transcript =
      recentRows.length > 0
        ? recentRows
            .reverse()
            .map((m) =>
              m.direction === "outbound"
                ? `Agent: ${m.content}`
                : `Pelanggan: ${m.content}`,
            )
            .join("\n")
        : `Pelanggan: ${triggerMessage}`;

    const { client, model, provider } = await resolveAiClient(ownerUserId);

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
