import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  googleContactsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { resolveGroupParticipants } from "./group-info";
import type { BaileysParticipant } from "./group-participants";

// Integration-style test: seeds a real chat with message history
// (sender_phone_digits + sender_name) and Google Contacts rows, then drives
// the full resolveGroupParticipants pipeline — the history-name SQL, the
// Google Contacts DB lookup, and the precedence helper wired together. This
// catches wiring regressions the pure-helper unit tests cannot (e.g. the
// history query returning the wrong column, or the contacts lookup keyed on
// the LID instead of the real phone).

// Unique suffix so repeat runs / parallel envs never collide on indexes.
const tag = Date.now().toString().slice(-6);

// Real-phone digits per participant. Distinct last-9 digits so the Google
// Contacts suffix matcher never sees an ambiguous collision.
const PHONE_HISTORY = `62811${tag}01`; // real-phone history name wins
const PHONE_CONTACT = `62811${tag}02`; // no history → Google Contacts name
const PHONE_BOTH = `62811${tag}03`; // history AND contact → history wins
const LID_ONLY = `9988776655${tag}`; // LID-only member, history under LID

let userId: number;
let chatId: number;
let ran = false;

before(async () => {
  // Skip cleanly when there is no database to talk to (keeps the suite from
  // hard-failing in a db-less environment); in this repo DATABASE_URL is
  // always provisioned so the body runs.
  if (!process.env.DATABASE_URL) return;

  const [user] = await db
    .insert(usersTable)
    .values({
      email: `group-info-test-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
    })
    .returning({ id: usersTable.id });
  userId = user.id;

  const [channel] = await db
    .insert(channelsTable)
    .values({ userId, kind: "whatsapp", label: `WA ${tag}` })
    .returning({ id: channelsTable.id });

  const [chat] = await db
    .insert(chatsTable)
    .values({
      channelId: channel.id,
      phoneNumber: `1203630${tag}@g.us`,
      contactName: "Test Group",
    })
    .returning({ id: chatsTable.id });
  chatId = chat.id;

  // Message history. Note PHONE_HISTORY has TWO rows: an older stale name and
  // a newer one — the DISTINCT ON / ORDER BY created_at DESC must pick the
  // newer "Andi History", proving the query orders correctly.
  const now = Date.now();
  await db.insert(chatMessagesTable).values([
    {
      chatId,
      direction: "inbound",
      content: "older",
      senderPhoneDigits: PHONE_HISTORY,
      senderName: "Andi Stale",
      createdAt: new Date(now - 60_000),
    },
    {
      chatId,
      direction: "inbound",
      content: "newer",
      senderPhoneDigits: PHONE_HISTORY,
      senderName: "Andi History",
      createdAt: new Date(now - 1_000),
    },
    // LID-only member: history stored against the synthetic LID digits.
    {
      chatId,
      direction: "inbound",
      content: "lid msg",
      senderPhoneDigits: LID_ONLY,
      senderName: "Budi LID",
      createdAt: new Date(now - 2_000),
    },
    // PHONE_BOTH has a real-phone history name too (should beat its contact).
    {
      chatId,
      direction: "inbound",
      content: "both msg",
      senderPhoneDigits: PHONE_BOTH,
      senderName: "Dewi History",
      createdAt: new Date(now - 3_000),
    },
    // A blank-name row must be ignored by the query's `sender_name <> ''`.
    {
      chatId,
      direction: "inbound",
      content: "blank name",
      senderPhoneDigits: PHONE_CONTACT,
      senderName: "",
      createdAt: new Date(now - 4_000),
    },
  ]);

  // Google Contacts (owner-scoped). Exact full-digit match keys.
  await db.insert(googleContactsTable).values([
    {
      userId,
      name: "Citra Contact",
      phoneDigits: PHONE_CONTACT,
      matchKey: PHONE_CONTACT.slice(-9),
    },
    {
      userId,
      name: "Dewi Contact",
      phoneDigits: PHONE_BOTH,
      matchKey: PHONE_BOTH.slice(-9),
    },
  ]);

  ran = true;
});

after(async () => {
  // Cascades clean up channel/chat/messages/contacts via the FK ON DELETE
  // CASCADE chain rooted at users.
  if (userId) {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  }
});

describe("resolveGroupParticipants (integration)", () => {
  it("resolves names end-to-end across the LID/real-phone split", async (t) => {
    if (!ran) {
      t.skip("no DATABASE_URL — integration test skipped");
      return;
    }

    // A: LID id + explicit real phone, real-phone history present.
    const pA: BaileysParticipant = {
      id: `1111111111111${tag}@lid`,
      phoneNumber: `${PHONE_HISTORY}@s.whatsapp.net`,
      admin: "admin",
    };
    // B: LID-only member, history stored under the LID digits.
    const pB: BaileysParticipant = { id: `${LID_ONLY}@lid` };
    // C: real phone, no history → Google Contacts name.
    const pC: BaileysParticipant = {
      id: `2222222222222${tag}@lid`,
      phoneNumber: `${PHONE_CONTACT}@s.whatsapp.net`,
    };
    // D: real phone with BOTH history and a contact → history must win.
    const pD: BaileysParticipant = {
      id: `${PHONE_BOTH}@s.whatsapp.net`,
      admin: "superadmin",
    };

    const out = await resolveGroupParticipants(chatId, userId, [pA, pB, pC, pD]);
    assert.equal(out.length, 4);
    const [a, b, c, d] = out;

    // A: real-phone history name, real phone shown (not the LID), admin flag.
    assert.equal(a.name, "Andi History");
    assert.equal(a.phone, PHONE_HISTORY);
    assert.equal(a.isAdmin, true);
    assert.equal(a.isSuperAdmin, false);

    // B: LID-derived history is the only signal; phone falls back to LID.
    assert.equal(b.name, "Budi LID");
    assert.equal(b.phone, LID_ONLY);

    // C: Google Contacts name resolved by the real phone (no history).
    assert.equal(c.name, "Citra Contact");
    assert.equal(c.phone, PHONE_CONTACT);

    // D: real-phone history beats the saved contact; superadmin flag set.
    assert.equal(d.name, "Dewi History");
    assert.equal(d.phone, PHONE_BOTH);
    assert.equal(d.isAdmin, true);
    assert.equal(d.isSuperAdmin, true);
  });

  it("returns no name (not a raw number) for an unknown member", async (t) => {
    if (!ran) {
      t.skip("no DATABASE_URL — integration test skipped");
      return;
    }
    const unknown: BaileysParticipant = { id: `5550000${tag}@s.whatsapp.net` };
    const [r] = await resolveGroupParticipants(chatId, userId, [unknown]);
    assert.equal(r.name, null);
    assert.equal(r.phone, `5550000${tag}`);
  });
});
