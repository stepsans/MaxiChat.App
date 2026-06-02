import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  jidDigits,
  participantLidDigits,
  participantRealDigits,
  resolveGroupParticipant,
  type BaileysParticipant,
} from "./group-participants";

describe("jidDigits", () => {
  it("extracts the numeric local-part of a phone jid", () => {
    assert.equal(jidDigits("62812345678@s.whatsapp.net"), "62812345678");
  });

  it("drops the device suffix", () => {
    assert.equal(jidDigits("62812345678:12@s.whatsapp.net"), "62812345678");
  });

  it("returns the long number for a LID jid", () => {
    assert.equal(jidDigits("123456789012345@lid"), "123456789012345");
  });

  it("returns null for null / empty / non-numeric local parts", () => {
    assert.equal(jidDigits(null), null);
    assert.equal(jidDigits(undefined), null);
    assert.equal(jidDigits(""), null);
    assert.equal(jidDigits("status@broadcast"), null);
  });
});

describe("participant digit helpers", () => {
  it("prefers the explicit phoneNumber for real digits", () => {
    const pp: BaileysParticipant = {
      id: "123456789012345@lid",
      phoneNumber: "62812345678@s.whatsapp.net",
    };
    assert.equal(participantRealDigits(pp), "62812345678");
    assert.equal(participantLidDigits(pp), "123456789012345");
  });

  it("uses a PN id as the real digits when there is no phoneNumber", () => {
    const pp: BaileysParticipant = { id: "62812345678@s.whatsapp.net" };
    assert.equal(participantRealDigits(pp), "62812345678");
  });

  it("has no real digits for a LID-only participant", () => {
    const pp: BaileysParticipant = { id: "123456789012345@lid" };
    assert.equal(participantRealDigits(pp), null);
    assert.equal(participantLidDigits(pp), "123456789012345");
  });
});

describe("resolveGroupParticipant name precedence", () => {
  // A participant with a real phone, a LID, history names against BOTH the real
  // phone and the LID, and a saved Google Contacts name on the real phone.
  const fullParticipant: BaileysParticipant = {
    id: "123456789012345@lid",
    phoneNumber: "62812345678@s.whatsapp.net",
    admin: null,
  };
  const history = new Map<string, string>([
    ["62812345678", "History RealName"],
    ["123456789012345", "History LidName"],
  ]);
  const contacts = new Map<string, string>([
    ["62812345678", "Google ContactName"],
  ]);

  it("prefers the Baileys contact name above everything else", () => {
    const out = resolveGroupParticipant(
      { ...fullParticipant, name: "Contact Name", notify: "Push Name" },
      history,
      contacts
    );
    assert.equal(out.name, "Contact Name");
    // Real phone shown when known, never the synthetic LID.
    assert.equal(out.phone, "62812345678");
  });

  it("falls back to the push name when no contact name", () => {
    const out = resolveGroupParticipant(
      { ...fullParticipant, notify: "Push Name" },
      history,
      contacts
    );
    assert.equal(out.name, "Push Name");
  });

  it("uses the real-phone history name above Google Contacts and LID history", () => {
    const out = resolveGroupParticipant(fullParticipant, history, contacts);
    assert.equal(out.name, "History RealName");
  });

  it("uses the saved Google Contacts name when there is no real-phone history", () => {
    const historyLidOnly = new Map<string, string>([
      ["123456789012345", "History LidName"],
    ]);
    const out = resolveGroupParticipant(
      fullParticipant,
      historyLidOnly,
      contacts
    );
    // Google Contacts on the real phone beats the weak LID-derived history.
    assert.equal(out.name, "Google ContactName");
  });

  it("uses the LID-derived history only as a last resort", () => {
    const out = resolveGroupParticipant(
      fullParticipant,
      new Map([["123456789012345", "History LidName"]]),
      new Map() // no Google contact
    );
    assert.equal(out.name, "History LidName");
  });

  it("returns no name (not a raw number) when nothing resolves", () => {
    const out = resolveGroupParticipant(
      fullParticipant,
      new Map(),
      new Map()
    );
    assert.equal(out.name, null);
    // Phone still falls back to a stable value for the row.
    assert.equal(out.phone, "62812345678");
  });

  it("does NOT guess a name for an ambiguous suffix collision (LID-only member)", () => {
    // A LID-only participant: no real phone, so the ambiguous Google Contacts
    // lookup (resolved upstream) yields no entry and must not leak a guess.
    const lidOnly: BaileysParticipant = { id: "123456789012345@lid" };
    const out = resolveGroupParticipant(
      lidOnly,
      new Map(), // no history name for the LID
      new Map() // ambiguous suffix → resolveContactNames returned nothing
    );
    assert.equal(out.name, null);
    // Falls back to the LID digits so the row still renders something stable.
    assert.equal(out.phone, "123456789012345");
  });

  it("maps admin and superadmin flags", () => {
    const member = resolveGroupParticipant(
      { id: "1@s.whatsapp.net", admin: null },
      new Map(),
      new Map()
    );
    assert.equal(member.isAdmin, false);
    assert.equal(member.isSuperAdmin, false);

    const admin = resolveGroupParticipant(
      { id: "2@s.whatsapp.net", admin: "admin" },
      new Map(),
      new Map()
    );
    assert.equal(admin.isAdmin, true);
    assert.equal(admin.isSuperAdmin, false);

    const superAdmin = resolveGroupParticipant(
      { id: "3@s.whatsapp.net", admin: "superadmin" },
      new Map(),
      new Map()
    );
    assert.equal(superAdmin.isAdmin, true);
    assert.equal(superAdmin.isSuperAdmin, true);
  });
});
