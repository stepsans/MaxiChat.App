import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toUnixSeconds,
  readClearUpTo,
  ownReadFromReceiptUpdate,
  ownReadFromMessageUpdate,
} from "./chat-read-sync";

test("toUnixSeconds accepts positive numbers", () => {
  assert.equal(toUnixSeconds(1717600000), 1717600000);
});

test("toUnixSeconds accepts numeric strings", () => {
  assert.equal(toUnixSeconds("1717600000"), 1717600000);
});

test("toUnixSeconds accepts Long-like objects via toNumber", () => {
  const longLike = { toNumber: () => 1717600000 };
  assert.equal(toUnixSeconds(longLike), 1717600000);
});

test("toUnixSeconds rejects zero, negatives, and junk", () => {
  assert.equal(toUnixSeconds(0), null);
  assert.equal(toUnixSeconds(-5), null);
  assert.equal(toUnixSeconds("abc"), null);
  assert.equal(toUnixSeconds(null), null);
  assert.equal(toUnixSeconds(undefined), null);
  assert.equal(toUnixSeconds({}), null);
});

test("readClearUpTo returns the read point when read with a timestamp", () => {
  const d = readClearUpTo({ unreadCount: 0, conversationTimestamp: 1717600000 });
  assert.ok(d instanceof Date);
  assert.equal(d?.getTime(), 1717600000 * 1000);
});

test("readClearUpTo handles Long-like conversationTimestamp", () => {
  const d = readClearUpTo({
    unreadCount: 0,
    conversationTimestamp: { toNumber: () => 1717600000 },
  });
  assert.equal(d?.getTime(), 1717600000 * 1000);
});

test("readClearUpTo is null when unreadCount is not zero", () => {
  assert.equal(
    readClearUpTo({ unreadCount: 3, conversationTimestamp: 1717600000 }),
    null,
  );
  assert.equal(
    readClearUpTo({ unreadCount: -1, conversationTimestamp: 1717600000 }),
    null,
  );
});

test("readClearUpTo is null when unreadCount is absent", () => {
  assert.equal(readClearUpTo({ conversationTimestamp: 1717600000 }), null);
});

test("readClearUpTo is null when read but no usable timestamp (avoids racing a newer message)", () => {
  assert.equal(readClearUpTo({ unreadCount: 0 }), null);
  assert.equal(readClearUpTo({ unreadCount: 0, conversationTimestamp: 0 }), null);
  assert.equal(
    readClearUpTo({ unreadCount: 0, conversationTimestamp: null }),
    null,
  );
});

// ---- ownReadFromReceiptUpdate (message-receipt.update) ----

test("ownReadFromReceiptUpdate reads an inbound receipt with readTimestamp", () => {
  const sig = ownReadFromReceiptUpdate({
    key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "ABC" },
    receipt: { readTimestamp: 1717600000 },
  });
  assert.ok(sig);
  assert.equal(sig?.remoteJid, "628111@s.whatsapp.net");
  assert.equal(sig?.messageId, "ABC");
  assert.equal(sig?.readUpTo?.getTime(), 1717600000 * 1000);
});

test("ownReadFromReceiptUpdate falls back to playedTimestamp for voice notes", () => {
  const sig = ownReadFromReceiptUpdate({
    key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "V1" },
    receipt: { playedTimestamp: 1717600000 },
  });
  assert.equal(sig?.readUpTo?.getTime(), 1717600000 * 1000);
});

test("ownReadFromReceiptUpdate returns null for a timestamp-less receipt (non-read receipt, e.g. delivery — must not clear unread)", () => {
  assert.equal(
    ownReadFromReceiptUpdate({
      key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "M9" },
      receipt: {},
    }),
    null,
  );
  // missing receipt object entirely is also a non-read receipt
  assert.equal(
    ownReadFromReceiptUpdate({
      key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "M9" },
    }),
    null,
  );
});

test("ownReadFromReceiptUpdate skips receipts on OUR outbound messages (blue ticks, out of scope)", () => {
  assert.equal(
    ownReadFromReceiptUpdate({
      key: { fromMe: true, remoteJid: "628111@s.whatsapp.net", id: "OUT" },
      receipt: { readTimestamp: 1717600000 },
    }),
    null,
  );
});

test("ownReadFromReceiptUpdate skips items with no/empty remoteJid", () => {
  assert.equal(
    ownReadFromReceiptUpdate({
      key: { fromMe: false, remoteJid: "", id: "X" },
      receipt: { readTimestamp: 1717600000 },
    }),
    null,
  );
  assert.equal(ownReadFromReceiptUpdate({ receipt: { readTimestamp: 1 } }), null);
});

// ---- ownReadFromMessageUpdate (messages.update) ----

test("ownReadFromMessageUpdate detects inbound READ status (numeric proto value)", () => {
  const sig = ownReadFromMessageUpdate({
    key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "R1" },
    update: { status: 4 },
  });
  assert.ok(sig);
  assert.equal(sig?.remoteJid, "628111@s.whatsapp.net");
  assert.equal(sig?.messageId, "R1");
  assert.equal(sig?.readUpTo, null); // messages.update carries no timestamp
});

test("ownReadFromMessageUpdate accepts PLAYED and string status forms", () => {
  assert.ok(
    ownReadFromMessageUpdate({
      key: { fromMe: false, remoteJid: "g@g.us", id: "P1" },
      update: { status: 5 },
    }),
  );
  assert.ok(
    ownReadFromMessageUpdate({
      key: { fromMe: false, remoteJid: "g@g.us", id: "P2" },
      update: { status: "READ" },
    }),
  );
});

test("ownReadFromMessageUpdate ignores non-read statuses and our outbound updates", () => {
  assert.equal(
    ownReadFromMessageUpdate({
      key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "D1" },
      update: { status: 3 }, // DELIVERY_ACK
    }),
    null,
  );
  assert.equal(
    ownReadFromMessageUpdate({
      key: { fromMe: true, remoteJid: "628111@s.whatsapp.net", id: "OUT" },
      update: { status: 4 }, // customer read OUR message — out of scope
    }),
    null,
  );
  assert.equal(
    ownReadFromMessageUpdate({
      key: { fromMe: false, remoteJid: "628111@s.whatsapp.net", id: "N1" },
      update: {},
    }),
    null,
  );
});
