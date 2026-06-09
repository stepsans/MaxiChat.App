import { desc, eq } from "drizzle-orm";
import {
  db,
  chatMessagesTable,
  productsTable,
  type OpportunityRow,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { getOrCreateTenantSettings } from "./settings-store";
import { buildProductCatalogText } from "./product-catalog";
import { logger } from "./logger";

// ===========================================================================
// AI Sales Assistant — Auto Follow-Up message generator.
//
// Drafts ONE personalized follow-up nudge for an opportunity that has gone
// silent (waiting on the customer). Unlike generateAiReply (which answers a
// customer's last message), this is a PROACTIVE re-engagement touch: warm,
// short, references the deal context (contact name, products of interest, the
// pipeline stage, recent history) and ends with a gentle question to restart
// the conversation. Token usage is attributed to the tenant OWNER, mirroring
// every other AI call site. Best-effort: returns null on any failure so the
// engine simply skips this touch (it will be retried next sweep) rather than
// crashing the whole follow-up batch.
// ===========================================================================

export interface GeneratedFollowUp {
  text: string;
  provider: string;
  model: string;
}

// How many trailing messages to feed the model as conversation context.
const HISTORY_LIMIT = 10;

// Per-touch tone guidance. The further into the sequence, the lighter the
// touch — touch 3 explicitly offers to back off so we never come across as
// pushy (and respects the customer's silence).
function sequenceTone(sequence: number): string {
  if (sequence <= 1) {
    return "Ini follow-up PERTAMA. Singkat, ramah, ingatkan kembali pada minat/produk yang sempat dibahas, lalu tanyakan apakah masih berminat atau ada yang bisa dibantu.";
  }
  if (sequence === 2) {
    return "Ini follow-up KEDUA. Tetap sopan dan ringan, tawarkan bantuan konkret (info harga/stok/pengiriman) tanpa terkesan memaksa.";
  }
  return "Ini follow-up KETIGA dan TERAKHIR. Sangat sopan, beri ruang: sampaikan bahwa kami tetap siap membantu kapan pun, dan persilakan menghubungi kembali bila sewaktu-waktu dibutuhkan.";
}

// Draft a follow-up message for one opportunity. `ownerUserId` is the tenant
// owner (usage attribution + tenant-wide AI settings); `userId` is the channel
// owner used to resolve the BYOK client (resolveAiClient resolves to the same
// owner internally). Returns null when generation fails or yields empty text.
export async function generateFollowUpMessage(opts: {
  opportunity: OpportunityRow;
  sequence: number;
}): Promise<GeneratedFollowUp | null> {
  const { opportunity, sequence } = opts;
  try {
    const ownerUserId = opportunity.ownerUserId;

    // Tenant-wide brand voice / persona, reused so the follow-up sounds like
    // the same business the customer was already talking to.
    const tenant = await getOrCreateTenantSettings(ownerUserId);

    // Live product catalog (owner-scoped, internal tier prices/stock excluded)
    // so any product reference uses current names/prices.
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId))
      .orderBy(productsTable.id);
    const productCatalog = buildProductCatalogText(products);

    // Recent conversation, oldest → newest, so the model can match the thread.
    const recentMessages = (
      await db
        .select()
        .from(chatMessagesTable)
        .where(eq(chatMessagesTable.chatId, opportunity.chatId))
        .orderBy(desc(chatMessagesTable.id))
        .limit(HISTORY_LIMIT)
    ).reverse();

    const history = recentMessages.map((m) => ({
      role:
        m.direction === "outbound" ? ("assistant" as const) : ("user" as const),
      content: m.content,
    }));

    const productInterest =
      opportunity.productInterest.length > 0
        ? opportunity.productInterest.join(", ")
        : "(belum spesifik)";

    const systemPrompt = `${tenant.systemPrompt}

--- TUGAS: FOLLOW-UP PROAKTIF ---
Kamu menulis SATU pesan follow-up WhatsApp untuk customer yang belum membalas. JANGAN menjawab pertanyaan baru — ini inisiatif kita untuk menghidupkan kembali percakapan yang menggantung.
${sequenceTone(sequence)}

ATURAN:
- Bahasa Indonesia, gaya percakapan WhatsApp, hangat dan personal. Sapa dengan nama jika tersedia.
- SANGAT SINGKAT (maksimal 2–3 kalimat). Jangan bertele-tele.
- Hanya rujuk produk/harga dari KATALOG PRODUK di bawah. Jangan mengarang harga, kode, stok, atau janji.
- Akhiri dengan satu pertanyaan/ajakan ringan agar customer mudah membalas.
- Jangan menyertakan tanda kurung instruksi, placeholder, atau tanda tangan. Keluarkan HANYA isi pesan siap kirim.

KONTEKS DEAL:
- Nama customer: ${opportunity.contactName?.trim() || "(tidak diketahui)"}
- Minat produk: ${productInterest}
- Catatan: ${opportunity.aiNotes?.trim() || "(tidak ada)"}

--- KATALOG PRODUK ---
${productCatalog || "Belum ada produk di katalog."}
--- END KATALOG PRODUK ---`;

    const { client, model, provider, ownerUserId: resolvedOwner } =
      await resolveAiClient(ownerUserId);

    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...history,
        {
          role: "user",
          content:
            "Tulis pesan follow-up sekarang sesuai aturan di atas. Keluarkan hanya isi pesannya.",
        },
      ],
      max_tokens: 400,
      temperature: 0.7,
    });

    void recordAiUsage({
      ownerUserId: resolvedOwner,
      channelId: opportunity.channelId,
      provider,
      model,
      usage: response.usage,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return null;
    return { text, provider, model };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, opportunityId: opportunity.id },
      "follow-up message generation failed"
    );
    return null;
  }
}
