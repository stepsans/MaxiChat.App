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
// offering to the tenant. PRECISION-FIRST: every entry must be mono-role — a
// normal-mode customer (who is also inbound) must almost never say it. So we
// keep fulfillment/settlement language that only the order-FULFILLING party
// produces, and drop cross-role tells a buyer would also ask
// ("nomor resi?", "bisa cod?", "minimal order berapa?").
const INBOUND_OFFER_SIGNALS = [
  // Formal "our/we" offer language (any industry):
  "kami menawarkan", "kami memiliki", "produk kami", "layanan kami",
  "harga kami", "penawaran kami", "promo kami", "katalog kami",
  "kami siap melayani", "we offer", "our product", "our service", "our price",
  // Hotel / booking / reservation (contact confirms the tenant's booking):
  "reservasi anda", "kedatangan anda", "tamu kami", "kamar anda", "paket kami",
  "booking atas nama", "reservasi atas nama", "slot tersedia", "jadwal tersedia",
  // Order-taker opener (F&B / warung / toko):
  "selamat datang di", "ada yang bisa dibantu", "ada yang bisa kami bantu",
  "mau pesen apa", "mau pesan apa", "mau order apa", "mau dipesan apa",
  "dine in atau", "makan di tempat atau", "diantar atau diambil",
  "ada tambahan lagi", "ada yang lain kak", "mau tambah yang lain",
  // Billing & payment terms stated by the seller:
  "totalnya", "total harga", "total pesanan", "total belanja", "subtotal",
  "pembayaran hanya bisa", "pembayaran bisa", "pembayaran via",
  "silakan transfer", "transfer ke rekening", "bisa transfer ke",
  "rekening kami", "no rekening kami", "melayani cod", "minimal pembelian",
  "kami kirimkan invoice", "invoice sudah kami", "kami buatkan invoice",
  // (Financial / MLM / insurance / crypto solicitation is intentionally NOT
  // pre-filtered here — the AI + the pipeline's custom prompt decide, since for
  // an MLM/insurance/crypto tenant those ARE the leads.)
  // Fulfillment — order taken / ready / shipped (only the fulfilling party):
  "pesanan atas nama", "pesenan atas nama", "atas nama siapa", "pesanan anda",
  "pesanan akan kami", "pesanan akan kita", "pesenan akan kita",
  "terima kasih telah memesan", "terima kasih sudah order",
  "terima kasih sudah berbelanja", "selamat berbelanja",
  "sudah bisa diambil", "bisa diambil", "siap diambil",
  "pesanannya sudah siap", "orderan sudah siap", "pesanan sudah jadi",
  "nomor antrian", "nomor pesanan",
  "sudah kami kirim", "paket sudah dikirim", "barang sudah dikirim",
  // Stock stated (not asked) by the seller:
  "stok ready", "stok tersedia", "barang ready", "ready stok",
  "ready kak", "ready ya kak",
];

// Phrases an OUTBOUND message (from the tenant/agent) uses when THEY are the
// buyer purchasing from the contact. PRECISION-FIRST: a normal-mode seller
// (who is also outbound) must almost never say it. So we drop invitations a
// seller would also send ("boleh pesan kak", "masih buka kok") and keep
// first-person purchase/payment actions + the buyer asking where to pay.
const OUTBOUND_BUYER_SIGNALS = [
  // Explicit purchase intent / RFQ:
  "saya mau pesan", "saya mau beli", "saya mau order", "saya ingin memesan",
  "saya tertarik", "saya butuh", "minta info", "minta penawaran",
  "bisa quotation", "berapa harga", "berapa biaya",
  "ada kamar", "ada stok", "tolong kirim",
  // Placing the order (informal, first person):
  "bisa pesan", "bisa pesen", "mau pesen", "mau order",
  "saya pesan", "saya order", "saya ambil",
  "saya jadi pesan", "jadi pesan ya", "saya mau yang", "saya pesan yang",
  // Paying as the buyer:
  "ok transfer", "oke transfer", "sudah transfer", "udah transfer",
  "saya transfer", "saya sudah transfer",
  "transfer kemana", "transfer ke mana", "ke rekening mana",
  "minta nomor rekening", "rekeningnya berapa",
  // Buyer asking about fulfillment of their own order:
  "kapan bisa diambil", "kapan jadi", "kapan sampai", "kapan dikirim",
  "kirim ke alamat", "minta diantar",
];

// Topics with no business relevance at all — job seekers, spam broadcasts, and
// academic research. The CONTACT (inbound) brings these; a real lead never does.
const INBOUND_IRRELEVANT_SIGNALS = [
  // Job seekers:
  "saya melamar", "melamar pekerjaan", "lamaran kerja", "kirim cv", "kirim lamaran",
  "fresh graduate", "saya lulusan", "lowongan kerja",
  // Spam / chain broadcasts:
  "forward pesan ini", "sebarkan ke", "broadcast ke", "teruskan pesan ini",
  // Academic research:
  "skripsi saya", "penelitian saya", "izin wawancara",
  "kuesioner penelitian", "responden penelitian", "tugas kuliah",
];

export interface PrefilterMessage {
  direction: string; // 'inbound' | 'outbound'
  content: string | null | undefined;
}

// Detect a clearly reversed role without calling the model. Returns
// 'tenant_is_buyer' only when there is positive evidence on BOTH sides
// (contact offers + tenant buys); otherwise 'unclear' (let the AI decide).
// Scope is deliberately narrow — generic order-taking/vendor language only.
// Vertical-specific solicitation (MLM/insurance/crypto/…) is left to the AI +
// the pipeline's custom prompt, which can tell when those ARE the tenant's leads.
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

// Detect a business-irrelevant conversation (job seeker / spam / research) from
// the contact's inbound messages. Pure + precision-first: a single inbound hit
// on a hard-irrelevant phrase is enough. Kept separate from role detection so
// the ConversationRole union stays clean (irrelevant is a TOPIC, not a role).
export function detectIrrelevantDbFree(messages: PrefilterMessage[]): boolean {
  for (const m of messages) {
    if (m.direction !== "inbound") continue;
    const text = (m.content ?? "").toLowerCase();
    if (!text) continue;
    if (INBOUND_IRRELEVANT_SIGNALS.some((s) => text.includes(s))) return true;
  }
  return false;
}

// Sticky reverse-role memory ("tambah lama tambah pintar"): once any prior
// analysis concluded the contact is the seller and the tenant the buyer, treat
// it as LEARNED and skip re-analysis on future runs — zero AI tokens, and no
// risk of the model flip-flopping on the same vendor. Pure so it is
// unit-testable; the DB lookup of the prior role happens at the call site.
//
// Override: a human reclassifying the contact as a 'lead' (manual) always wins
// and forces a fresh analysis, so a wrong/changed verdict can be corrected.
export function shouldSkipAsLearnedReverseRole(
  priorConversationRole: string | null | undefined,
  manual: { leadStatus: string; leadClassifiedBy: string } | null | undefined
): boolean {
  const manualLeadOverride =
    manual?.leadStatus === "lead" && manual.leadClassifiedBy === "manual";
  if (manualLeadOverride) return false;
  return priorConversationRole === "tenant_is_buyer";
}
