import { before, after, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  customerLabelsTable,
  contactLabelsTable,
  usageSnapshotsTable,
  aiUsageEventsTable,
  mediaObjectsTable,
  tenantResetAuditTable,
} from "@workspace/db";

// DB-backed regression test for the tenant "Reset Database" operation.
//
// Seeds TWO tenants (owner + foreign) with a full spread of operational data —
// chats + messages, customer/contact labels, analytics snapshots, AI usage
// logs, and media ledger rows. Then runs resetTenant(owner) and asserts:
//   1. EVERY one of the owner's operational rows is gone.
//   2. NONE of the foreign tenant's rows are touched (no cross-tenant wipe).
//   3. An audit row is written with the correct per-category counts.
//   4. The Object Storage prefix sweep is invoked for the owner.
//
// ObjectStorageService is stubbed so the test never touches GCS; we only assert
// it was asked to sweep the owner's prefix (one sweep removes every tenant blob).

const sweptOwners: number[] = [];

mock.module("./objectStorage", {
  namedExports: {
    ObjectStorageService: class {
      async deleteTenantPrefix(ownerId: number) {
        sweptOwners.push(ownerId);
        return 2;
      }
    },
  },
});

const { resetTenant } = await import("./tenant-reset");

const tag = Date.now().toString().slice(-6);

let ownerUserId: number;
let foreignUserId: number;
let ownerChannelId: number;
let foreignChannelId: number;
let ownerChatId: number;
let foreignChatId: number;
let ownerLabelId: number;
let foreignLabelId: number;

before(async () => {
  const [owner] = await db
    .insert(usersTable)
    .values({
      email: `reset-owner-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
    })
    .returning({ id: usersTable.id });
  ownerUserId = owner.id;

  const [foreign] = await db
    .insert(usersTable)
    .values({
      email: `reset-foreign-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
    })
    .returning({ id: usersTable.id });
  foreignUserId = foreign.id;

  const [ch] = await db
    .insert(channelsTable)
    .values({ userId: ownerUserId, kind: "whatsapp", label: `WA ${tag}` })
    .returning({ id: channelsTable.id });
  ownerChannelId = ch.id;

  const [fch] = await db
    .insert(channelsTable)
    .values({ userId: foreignUserId, kind: "whatsapp", label: `WAF ${tag}` })
    .returning({ id: channelsTable.id });
  foreignChannelId = fch.id;

  // --- chats + messages -----------------------------------------------------
  const [oc] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannelId,
      phoneNumber: `62811${tag}`,
      contactName: "Owner Contact",
    })
    .returning({ id: chatsTable.id });
  ownerChatId = oc.id;

  const [fc] = await db
    .insert(chatsTable)
    .values({
      channelId: foreignChannelId,
      phoneNumber: `62822${tag}`,
      contactName: "Foreign Contact",
    })
    .returning({ id: chatsTable.id });
  foreignChatId = fc.id;

  await db.insert(chatMessagesTable).values([
    { chatId: ownerChatId, direction: "inbound", content: "halo" },
    { chatId: ownerChatId, direction: "outbound", content: "hai" },
    { chatId: foreignChatId, direction: "inbound", content: "asing" },
  ]);

  // --- labels (customer label def + contact assignment) ---------------------
  const [ol] = await db
    .insert(customerLabelsTable)
    .values({ ownerUserId, name: `High Risk ${tag}` })
    .returning({ id: customerLabelsTable.id });
  ownerLabelId = ol.id;

  const [fl] = await db
    .insert(customerLabelsTable)
    .values({ ownerUserId: foreignUserId, name: `VIP ${tag}` })
    .returning({ id: customerLabelsTable.id });
  foreignLabelId = fl.id;

  await db.insert(contactLabelsTable).values([
    { ownerUserId, phoneNumber: `62811${tag}`, labelId: ownerLabelId },
    {
      ownerUserId: foreignUserId,
      phoneNumber: `62822${tag}`,
      labelId: foreignLabelId,
    },
  ]);

  // --- analytics snapshots --------------------------------------------------
  await db.insert(usageSnapshotsTable).values([
    { userId: ownerUserId, snapshotDate: "2026-06-01" },
    { userId: foreignUserId, snapshotDate: "2026-06-01" },
  ]);

  // --- AI usage logs --------------------------------------------------------
  await db.insert(aiUsageEventsTable).values([
    { userId: ownerUserId, totalTokens: 100 },
    { userId: ownerUserId, totalTokens: 50 },
    { userId: foreignUserId, totalTokens: 999 },
  ]);

  // --- media ledger rows ----------------------------------------------------
  await db.insert(mediaObjectsTable).values([
    {
      ownerUserId,
      channelId: ownerChannelId,
      objectPath: `/objects/tenants/${ownerUserId}/a-${tag}.jpg`,
      sizeBytes: 1234,
    },
    {
      ownerUserId,
      channelId: ownerChannelId,
      objectPath: `/objects/tenants/${ownerUserId}/b-${tag}.pdf`,
      sizeBytes: 5678,
    },
    {
      ownerUserId: foreignUserId,
      channelId: foreignChannelId,
      objectPath: `/objects/tenants/${foreignUserId}/x-${tag}.jpg`,
      sizeBytes: 4321,
    },
  ]);
});

after(async () => {
  // Foreign tenant rows + the audit row aren't removed by reset, so clean up.
  await db.delete(tenantResetAuditTable).where(eq(tenantResetAuditTable.ownerUserId, ownerUserId));
  await db.delete(usersTable).where(inArray(usersTable.id, [ownerUserId, foreignUserId]));
});

describe("resetTenant", () => {
  it("wipes only the owner's data, leaves the foreign tenant intact, and audits", async () => {
    const summary = await resetTenant(ownerUserId, ownerUserId);

    // --- returned summary counts ---------------------------------------------
    assert.equal(summary.chats, 1);
    assert.equal(summary.messages, 2);
    assert.equal(summary.contactLabels, 1);
    assert.equal(summary.labels, 1);
    assert.equal(summary.analytics, 1);
    assert.equal(summary.logs, 2);
    assert.equal(summary.media, 2);
    assert.equal(summary.files, 2);

    // --- owner data is gone ---------------------------------------------------
    const ownerChats = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(eq(chatsTable.channelId, ownerChannelId));
    assert.equal(ownerChats.length, 0);

    const ownerMsgs = await db
      .select({ id: chatMessagesTable.id })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, ownerChatId));
    assert.equal(ownerMsgs.length, 0);

    const ownerContactLabels = await db
      .select({ labelId: contactLabelsTable.labelId })
      .from(contactLabelsTable)
      .where(eq(contactLabelsTable.ownerUserId, ownerUserId));
    assert.equal(ownerContactLabels.length, 0);

    const ownerLabels = await db
      .select({ id: customerLabelsTable.id })
      .from(customerLabelsTable)
      .where(eq(customerLabelsTable.ownerUserId, ownerUserId));
    assert.equal(ownerLabels.length, 0);

    const ownerSnaps = await db
      .select({ id: usageSnapshotsTable.id })
      .from(usageSnapshotsTable)
      .where(eq(usageSnapshotsTable.userId, ownerUserId));
    assert.equal(ownerSnaps.length, 0);

    const ownerAi = await db
      .select({ id: aiUsageEventsTable.id })
      .from(aiUsageEventsTable)
      .where(eq(aiUsageEventsTable.userId, ownerUserId));
    assert.equal(ownerAi.length, 0);

    const ownerMedia = await db
      .select({ id: mediaObjectsTable.id })
      .from(mediaObjectsTable)
      .where(eq(mediaObjectsTable.ownerUserId, ownerUserId));
    assert.equal(ownerMedia.length, 0);

    // --- foreign tenant is untouched -----------------------------------------
    const fChats = await db
      .select({ id: chatsTable.id })
      .from(chatsTable)
      .where(eq(chatsTable.channelId, foreignChannelId));
    assert.equal(fChats.length, 1);

    const fMsgs = await db
      .select({ id: chatMessagesTable.id })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.chatId, foreignChatId));
    assert.equal(fMsgs.length, 1);

    const fLabels = await db
      .select({ id: customerLabelsTable.id })
      .from(customerLabelsTable)
      .where(eq(customerLabelsTable.ownerUserId, foreignUserId));
    assert.equal(fLabels.length, 1);

    const fContactLabels = await db
      .select({ labelId: contactLabelsTable.labelId })
      .from(contactLabelsTable)
      .where(eq(contactLabelsTable.ownerUserId, foreignUserId));
    assert.equal(fContactLabels.length, 1);

    const fSnaps = await db
      .select({ id: usageSnapshotsTable.id })
      .from(usageSnapshotsTable)
      .where(eq(usageSnapshotsTable.userId, foreignUserId));
    assert.equal(fSnaps.length, 1);

    const fAi = await db
      .select({ id: aiUsageEventsTable.id })
      .from(aiUsageEventsTable)
      .where(eq(aiUsageEventsTable.userId, foreignUserId));
    assert.equal(fAi.length, 1);

    const fMedia = await db
      .select({ id: mediaObjectsTable.id })
      .from(mediaObjectsTable)
      .where(eq(mediaObjectsTable.ownerUserId, foreignUserId));
    assert.equal(fMedia.length, 1);

    // --- object storage was swept for the owner only -------------------------
    assert.deepEqual(sweptOwners, [ownerUserId]);

    // --- audit row written ----------------------------------------------------
    const audit = await db
      .select()
      .from(tenantResetAuditTable)
      .where(eq(tenantResetAuditTable.ownerUserId, ownerUserId));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].performedByUserId, ownerUserId);
    assert.equal(audit[0].summary.chats, 1);
    assert.equal(audit[0].summary.messages, 2);
    assert.equal(audit[0].summary.files, 2);
  });
});
