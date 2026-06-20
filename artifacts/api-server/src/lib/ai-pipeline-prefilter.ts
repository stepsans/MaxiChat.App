// Pure (db-free) pre-filter for the AI Pipeline. Detects "reverse role"
// conversations — where the CONTACT is the seller/supplier and the tenant is
// the buyer — BEFORE spending any AI tokens. Unit-testable in isolation.
//
// Example reverse-role chats: a hotel confirming the tenant's own booking, a
// supplier quoting the tenant, a travel agent the tenant is purchasing from.
// These should never enter the sales pipeline as "leads".

export type ConversationRole =
  | "tenant_is_seller"
  | "tenant_is_buyer"
  | "unclear";

// Phrases an INBOUND message (from the contact) uses when THEY are the seller
// offering to the tenant.
const INBOUND_OFFER_SIGNALS = [
  "kami menawarkan", "kami memiliki", "produk kami", "layanan kami",
  "harga kami", "penawaran kami", "promo kami", "katalog kami",
  "kami siap melayani", "reservasi anda", "kedatangan anda",
  "pesanan anda", "tamu kami", "kamar anda", "paket kami",
  "we offer", "our product", "our service", "our price",
  "selamat datang di", "terima kasih telah memesan",
];

// Phrases an OUTBOUND message (from the tenant/agent) uses when THEY are the
// buyer purchasing from the contact.
const OUTBOUND_BUYER_SIGNALS = [
  "saya mau pesan", "saya mau beli", "berapa harga",
  "ada kamar", "ada stok", "saya tertarik", "minta info",
  "tolong kirim", "minta penawaran", "bisa quotation",
  "berapa biaya", "saya butuh", "saya ingin memesan",
];

export interface PrefilterMessage {
  direction: string; // 'inbound' | 'outbound'
  content: string | null | undefined;
}

// Detect a clearly reversed role without calling the model. Returns
// 'tenant_is_buyer' only when there is positive evidence on BOTH sides
// (contact offers + tenant buys); otherwise 'unclear' (let the AI decide).
export function detectConversationRoleDbFree(
  messages: PrefilterMessage[]
): ConversationRole {
  let inboundOfferCount = 0;
  let outboundBuyerCount = 0;

  for (const m of messages) {
    const text = (m.content ?? "").toLowerCase();
    if (!text) continue;
    if (m.direction === "inbound") {
      if (INBOUND_OFFER_SIGNALS.some((s) => text.includes(s))) {
        inboundOfferCount++;
      }
    } else if (m.direction === "outbound") {
      if (OUTBOUND_BUYER_SIGNALS.some((s) => text.includes(s))) {
        outboundBuyerCount++;
      }
    }
  }

  if (inboundOfferCount >= 1 && outboundBuyerCount >= 1) {
    return "tenant_is_buyer";
  }
  return "unclear";
}
