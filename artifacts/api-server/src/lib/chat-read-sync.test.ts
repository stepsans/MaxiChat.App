import { test } from "node:test";
import assert from "node:assert/strict";
import { toUnixSeconds, readClearUpTo } from "./chat-read-sync";

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
