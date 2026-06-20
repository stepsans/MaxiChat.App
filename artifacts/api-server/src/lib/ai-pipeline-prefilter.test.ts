import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectConversationRoleDbFree } from "./ai-pipeline-prefilter";

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

  it("ignores empty/null content safely", () => {
    const role = detectConversationRoleDbFree([
      { direction: "inbound", content: null },
      { direction: "outbound", content: "" },
    ]);
    assert.equal(role, "unclear");
  });
});
