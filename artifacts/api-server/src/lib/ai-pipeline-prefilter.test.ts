import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectConversationRoleDbFree,
  detectIrrelevantDbFree,
  shouldSkipAsLearnedReverseRole,
} from "./ai-pipeline-prefilter";

describe("detectConversationRoleDbFree", () => {
  it("flags reverse role when contact offers AND tenant buys", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "Selamat datang di Hotel Senja, reservasi Anda kami terima" },
      { direction: "outbound", content: "Oke saya mau pesan kamar untuk tanggal 5" },
    ]);
    assert.equal(role, "tenant_is_buyer");
  });

  it("stays unclear for a normal selling conversation", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "Halo, mesin UV DTF nya berapa ya?" },
      { direction: "outbound", content: "Halo kak, yang itu Rp150.000" },
    ]);
    assert.equal(role, "unclear");
  });

  it("needs evidence on BOTH sides (offer only is not enough)", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "produk kami banyak kak" },
      { direction: "outbound", content: "wah menarik" },
    ]);
    assert.equal(role, "unclear");
  });

  it("flags reverse role for an informal warung/F&B order (tenant buying martabak)", () => {
    const role = detectConversationRoleDbFree([
      { direction: "outbound", content: "bisa pesan?" },
      { direction: "inbound", content: "Malam kak mau pesen apa?" },
      { direction: "outbound", content: "1 terang bulan coklat keju setengah setengah" },
      { direction: "inbound", content: "Totalnya 60" },
      { direction: "inbound", content: "Pembayaran hanya bisa tunai dan transfer ya kak" },
      { direction: "outbound", content: "ok transfer" },
      { direction: "inbound", content: "Pesenan sudah bisa diambil" },
    ]);
    assert.equal(role, "tenant_is_buyer");
  });

  it("stays unclear when a seller (tenant) states the total to a customer", () => {
    // Seller phrasing on the OUTBOUND side must NOT count as a contact-offer.
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "mau pesan terang bulan coklat keju" },
      { direction: "outbound", content: "Totalnya 60 ya kak, pembayaran bisa transfer" },
    ]);
    assert.equal(role, "unclear");
  });

  it("flags reverse role for an online-shop purchase (tenant buying supplies)", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "Halo kak, ada yang bisa dibantu?" },
      { direction: "outbound", content: "saya mau order kemasan 100 pcs" },
      { direction: "inbound", content: "Total belanja 250rb, silakan transfer ke rekening kami" },
      { direction: "outbound", content: "ok transfer, ke rekening mana?" },
      { direction: "inbound", content: "barang sudah dikirim ya kak" },
    ]);
    assert.equal(role, "tenant_is_buyer");
  });

  it("stays unclear when a customer asks for resi/COD (precision guard)", () => {
    // A normal-mode customer (inbound) asking these must NOT count as a seller
    // offer; the tenant (outbound) is the seller answering.
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "nomor resinya berapa kak? bisa cod?" },
      { direction: "outbound", content: "Bisa kak, ongkirnya 20rb" },
    ]);
    assert.equal(role, "unclear");
  });

  it("stays unclear when a seller invites the customer to order (precision guard)", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: "kak masih buka? boleh pesan sekarang?" },
      { direction: "outbound", content: "boleh kak, masih buka, silakan pesan" },
    ]);
    assert.equal(role, "unclear");
  });

  it("does NOT pre-filter vertical solicitation — MLM/insurance left to the AI", () => {
    // Solicitation in a specific vertical is no longer hardcoded as reverse-role;
    // the AI + custom prompt decide (it may be the tenant's actual lead).
    assert.equal(
      detectConversationRoleDbFree([
        { direction: "inbound", content: "Yuk gabung jadi mitra, ada bonus downline & komisi referral" },
        { direction: "outbound", content: "oh ya?" },
      ]),
      "unclear"
    );
    assert.equal(
      detectConversationRoleDbFree([
        { direction: "inbound", content: "Mau tanya premi asuransi dan polis asuransi nya" },
        { direction: "outbound", content: "boleh, ada paket apa saja?" },
      ]),
      "unclear"
    );
  });

  it("ignores empty/null content safely", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: null },
      { direction: "outbound", content: "" },
    ]);
    assert.equal(role, "unclear");
  });
});

describe("detectIrrelevantDbFree", () => {
  it("flags a job-seeker conversation", () => {
    assert.equal(
      detectIrrelevantDbFree([
        { direction: "inbound", content: "Selamat pagi, saya mau melamar pekerjaan, ini kirim CV saya" },
      ]),
      true
    );
  });

  it("flags a spam broadcast", () => {
    assert.equal(
      detectIrrelevantDbFree([
        { direction: "inbound", content: "Tolong forward pesan ini ke 10 grup ya" },
      ]),
      true
    );
  });

  it("flags an academic research request", () => {
    assert.equal(
      detectIrrelevantDbFree([
        { direction: "inbound", content: "Permisi, untuk skripsi saya, boleh izin wawancara?" },
      ]),
      true
    );
  });

  it("does not flag a normal sales conversation", () => {
    assert.equal(
      detectIrrelevantDbFree([
        { direction: "inbound", content: "Halo, mesin UV DTF nya berapa ya?" },
        { direction: "outbound", content: "Rp150.000 kak" },
      ]),
      false
    );
  });

  it("only inspects inbound messages", () => {
    // The tenant (outbound) talking about a job opening must not trip it.
    assert.equal(
      detectIrrelevantDbFree([
        { direction: "outbound", content: "kami buka lowongan kerja juga lho" },
        { direction: "inbound", content: "oh oke, btw harga produknya berapa?" },
      ]),
      false
    );
  });
});

describe("shouldSkipAsLearnedReverseRole", () => {
  it("skips when a prior run learned the contact is a vendor", () => {
    assert.equal(shouldSkipAsLearnedReverseRole("tenant_is_buyer", null), true);
  });

  it("does not skip a contact previously seen as a normal lead", () => {
    assert.equal(shouldSkipAsLearnedReverseRole("tenant_is_seller", null), false);
    assert.equal(shouldSkipAsLearnedReverseRole("unclear", null), false);
  });

  it("does not skip a brand-new contact (no prior analysis)", () => {
    assert.equal(shouldSkipAsLearnedReverseRole(null, null), false);
    assert.equal(shouldSkipAsLearnedReverseRole(undefined, null), false);
  });

  it("a manual 'lead' override forces re-analysis despite learned reverse role", () => {
    assert.equal(
      shouldSkipAsLearnedReverseRole("tenant_is_buyer", {
        leadStatus: "lead",
        leadClassifiedBy: "manual",
      }),
      false
    );
  });

  it("an AI 'lead' status does NOT override the learned reverse role", () => {
    assert.equal(
      shouldSkipAsLearnedReverseRole("tenant_is_buyer", {
        leadStatus: "lead",
        leadClassifiedBy: "ai",
      }),
      true
    );
  });
});
