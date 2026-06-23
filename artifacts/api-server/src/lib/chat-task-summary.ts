import { db } from "@workspace/db";
import { chatMessagesTable, chatsTable, channelsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { hasAutomatedSignature } from "./sender-tag-pure.js";
import { logger } from "./logger";

// Berapa pesan terakhir yang dibaca AI untuk merangkum. Cap di server —
// biaya token terprediksi (langsung memotong wallet tenant). 30 cukup untuk
// menangkap satu sesi tanya-jawab SMB tanpa boros.
const SUMMARY_MESSAGE_LIMIT = 30;

export class ChatNotFoundError extends Error {
  constructor() {
    super("Chat tidak ditemukan.");
    this.name = "ChatNotFoundError";
  }
}

export class NoConversationError extends Error {
  constructor() {
    super("Belum ada percakapan untuk dirangkum.");
    this.name = "NoConversationError";
  }
}

interface SummaryRow {
  direction: string;
  content: string;
  isAiGenerated: boolean;
  sentByUserId: number | null;
  senderName: string | null;
}

// Label peran tiap pesan untuk prompt. Pelanggan = inbound; "Agen" = human
// outbound; "AI" = balasan otomatis AI (konteks: apa yang sudah dijawab).
function roleLabel(row: SummaryRow, contactName: string): string {
  if (row.direction === "inbound") return row.senderName?.trim() || contactName;
  if (row.isAiGenerated) return "AI";
  return "Agen";
}

// Buang pesan otomatis bot-flow/follow-up (bukan AI auto-reply). AI auto-reply
// (is_ai_generated=true) TETAP disertakan sebagai konteks jawaban. Memakai
// hasAutomatedSignature (sender-tag-pure) — sumber kebenaran yang sama dengan
// ACR engine, jadi predikat noise tetap sinkron tanpa duplikasi regex.
function isNoiseAutomated(row: SummaryRow): boolean {
  if (row.direction !== "outbound") return false;
  if (row.isAiGenerated) return false; // AI auto-reply bukan noise
  if (row.sentByUserId != null) return false; // dashboard human
  return hasAutomatedSignature(row.content);
}

/**
 * Rangkum percakapan chat menjadi deskripsi task naratif singkat (Bahasa
 * Indonesia). Melalui mesin AI terpusat (resolveAiClient) → otomatis kena
 * prepaid gate + circuit breaker + usage accounting. Prompt TERPISAH dari AI
 * Pipeline; TIDAK menyertakan lead scoring.
 *
 * Lempar: ChatNotFoundError (chat bukan milik tenant), NoConversationError
 * (tak ada pesan), InsufficientCreditsError (kredit habis), AllEnginesDownError
 * / PlatformInactiveError (engine bermasalah). Route memetakan ke status HTTP.
 */
export async function summarizeChatForTask(
  userId: number,
  ownerUserId: number,
  chatId: number,
): Promise<string> {
  void userId; // dipertahankan untuk simetri tanda tangan; scoping pakai owner.

  // 1) Chat WAJIB milik tenant (owner) yang sama.
  const [chat] = await db
    .select({
      id: chatsTable.id,
      contactName: chatsTable.contactName,
      nickname: chatsTable.nickname,
      channelId: chatsTable.channelId,
    })
    .from(chatsTable)
    .innerJoin(channelsTable, eq(channelsTable.id, chatsTable.channelId))
    .where(and(eq(chatsTable.id, chatId), eq(channelsTable.userId, ownerUserId)))
    .limit(1);
  if (!chat) throw new ChatNotFoundError();

  const contactName = chat.nickname?.trim() || chat.contactName;

  // 2) Ambil N pesan terakhir (DESC), buang media-only kosong & noise otomatis.
  const rows = await db
    .select({
      direction: chatMessagesTable.direction,
      content: chatMessagesTable.content,
      isAiGenerated: chatMessagesTable.isAiGenerated,
      sentByUserId: chatMessagesTable.sentByUserId,
      senderName: chatMessagesTable.senderName,
    })
    .from(chatMessagesTable)
    .where(eq(chatMessagesTable.chatId, chatId))
    .orderBy(desc(chatMessagesTable.createdAt), desc(chatMessagesTable.id))
    .limit(SUMMARY_MESSAGE_LIMIT);

  // rows datang DESC (terbaru dulu) → balik ke kronologis untuk transkrip.
  const chronological = rows
    .reverse()
    .filter((r) => !isNoiseAutomated(r))
    .filter((r) => (r.content ?? "").trim().length > 0);

  if (chronological.length === 0) throw new NoConversationError();

  const transcript = chronological
    .map((r) => `${roleLabel(r, contactName)}: ${r.content.trim()}`)
    .join("\n");

  // 3) Prompt rangkuman task (TERPISAH, tanpa lead scoring).
  const system =
    "Anda asisten yang merangkum percakapan WhatsApp customer service/penjualan " +
    "menjadi deskripsi tugas (task) yang ringkas untuk tim. Tulis dalam Bahasa " +
    "Indonesia, 2-4 kalimat, fokus pada: apa yang diinginkan/ditanyakan pelanggan, " +
    "dan tindak lanjut konkret yang perlu dilakukan. JANGAN beri skor lead, JANGAN " +
    "beri estimasi nilai, JANGAN menebak status pelanggan. Tulis langsung isi " +
    "ringkasan tanpa kalimat pembuka seperti 'Berikut ringkasan'.";

  const user =
    `Kontak: ${contactName}\n\nTranskrip percakapan (kronologis):\n${transcript}\n\n` +
    `Rangkum menjadi deskripsi task.`;

  // 4) Panggil mesin AI terpusat.
  const { client, model, provider } = await resolveAiClient(ownerUserId);

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    max_tokens: 400,
    temperature: 0.3,
  });

  // 5) Catat usage (best-effort) — settle prepaid + rekam engine.
  await recordAiUsage({
    ownerUserId,
    channelId: chat.channelId,
    provider,
    model,
    usage: completion.usage,
  });

  const text = completion.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    logger.warn({ chatId, ownerUserId }, "summarizeChatForTask: empty AI response");
    throw new NoConversationError();
  }
  return text;
}
