import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFillerMessage,
  lastMeaningfulInteractionAt,
} from "./last-meaningful-interaction";

test("isFillerMessage: empty / whitespace / emoji-only is filler", () => {
  assert.equal(isFillerMessage(""), true);
  assert.equal(isFillerMessage("   "), true);
  assert.equal(isFillerMessage("👍"), true);
  assert.equal(isFillerMessage("🙏🙏"), true);
  assert.equal(isFillerMessage("..."), true);
  assert.equal(isFillerMessage("!"), true);
});

test("isFillerMessage: acknowledgements (ID + EN) are filler, case/punct-insensitive", () => {
  assert.equal(isFillerMessage("ok"), true);
  assert.equal(isFillerMessage("Oke"), true);
  assert.equal(isFillerMessage("OKE!"), true);
  assert.equal(isFillerMessage("sip 👍"), true);
  assert.equal(isFillerMessage("Makasih"), true);
  assert.equal(isFillerMessage("terima kasih"), true);
  assert.equal(isFillerMessage("thanks"), true);
  assert.equal(isFillerMessage("iya"), true);
});

test("isFillerMessage: substantive messages are NOT filler", () => {
  assert.equal(isFillerMessage("berapa harga produk ini?"), false);
  assert.equal(isFillerMessage("saya mau pesan 2 unit"), false);
  assert.equal(isFillerMessage("oke saya transfer sekarang ya"), false); // longer intent
  assert.equal(isFillerMessage("ready stok?"), false);
});

test("lastMeaningfulInteractionAt: null for empty / all-filler transcripts", () => {
  assert.equal(lastMeaningfulInteractionAt([]), null);
  assert.equal(
    lastMeaningfulInteractionAt([
      { at: new Date("2026-01-01T00:00:00Z"), content: "ok" },
      { at: new Date("2026-01-02T00:00:00Z"), content: "👍" },
    ]),
    null
  );
});

test("lastMeaningfulInteractionAt: picks latest non-filler regardless of order", () => {
  const result = lastMeaningfulInteractionAt([
    { at: new Date("2026-01-03T00:00:00Z"), content: "ok" }, // filler, latest
    { at: new Date("2026-01-02T10:00:00Z"), content: "mau tanya stok dong" }, // meaningful
    { at: new Date("2026-01-01T00:00:00Z"), content: "halo, ada barang X?" },
  ]);
  assert.deepEqual(result, new Date("2026-01-02T10:00:00Z"));
});

test("lastMeaningfulInteractionAt: a filler reply after a real one does not advance the anchor", () => {
  const meaningful = new Date("2026-02-01T09:00:00Z");
  const result = lastMeaningfulInteractionAt([
    { at: meaningful, content: "tolong kirim penawaran lengkapnya" },
    { at: new Date("2026-02-01T09:05:00Z"), content: "sip" },
  ]);
  assert.deepEqual(result, meaningful);
});
