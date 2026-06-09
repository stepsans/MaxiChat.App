import { before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  channelsTable,
  chatsTable,
  opportunitiesTable,
  opportunityFollowUpsTable,
  salesAuditEventsTable,
} from "@workspace/db";

// Route-level integration test for the manual follow-up controls:
//   PATCH /sales/opportunities/:id/follow-ups/:followUpId  (edit / cancel)
//   POST  /sales/opportunities/:id/follow-ups/:followUpId/send (send now)
//
// These run against the shared dev DB with baseline-delta assertions. The send
// path can't actually transmit in the test harness (no Baileys socket), so a
// send of a row that already HAS a drafted message exercises the claim →
// sendFollowUpOnChannel(false) → rollback-to-pending path and asserts the 502 +
// that the row is restored to `pending` (no audit event, no half-applied send).
//
// What it proves:
//   - PATCH cancel flips a pending follow-up to `cancelled`.
//   - PATCH edit updates the drafted message of a pending follow-up.
//   - PATCH on a non-pending follow-up 400s (immutability).
//   - send of a drafted follow-up with no socket 502s and STAYS pending.
//   - cross-tenant access (both PATCH and send) 404s (owner scoping).

const { default: salesRouter } = await import("./sales");

const tag = Date.now().toString().slice(-6);

let ownerUserId: number;
let foreignUserId: number;
let memberUserId: number; // owner's supervisor, but NO channel access
let oppId: number;
let foreignOppId: number;
let pendingFollowUpId: number; // owner, pending, has drafted message
let sentFollowUpId: number; // owner, already sent (immutable)
let foreignFollowUpId: number; // foreign tenant, pending
let server: Server;
let baseUrl: string;
let ran = false;

function makeApp(sessionUserId: number) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { userId: sessionUserId };
    (req as unknown as { log: unknown }).log = {
      error() {},
      warn() {},
      info() {},
      debug() {},
    };
    next();
  });
  app.use("/sales", salesRouter);
  return app;
}

async function seedTenant(emailTag: string): Promise<{
  userId: number;
  oppId: number;
  channelId: number;
}> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `sales-fu-${emailTag}-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
      plan: "enterprise",
    })
    .returning({ id: usersTable.id });

  const [channel] = await db
    .insert(channelsTable)
    .values({ userId: user.id, kind: "whatsapp", label: `WA ${emailTag} ${tag}` })
    .returning({ id: channelsTable.id });

  const phone = `62813${tag}${emailTag === "owner" ? "01" : "02"}`;
  const [chat] = await db
    .insert(chatsTable)
    .values({ channelId: channel.id, phoneNumber: phone, contactName: `Lead ${emailTag}` })
    .returning({ id: chatsTable.id });

  const [opp] = await db
    .insert(opportunitiesTable)
    .values({
      ownerUserId: user.id,
      chatId: chat.id,
      channelId: channel.id,
      contactPhone: phone,
      contactName: `Lead ${emailTag}`,
    })
    .returning({ id: opportunitiesTable.id });

  return { userId: user.id, oppId: opp.id, channelId: channel.id };
}

before(async () => {
  if (!process.env.DATABASE_URL) return;

  const owner = await seedTenant("owner");
  ownerUserId = owner.userId;
  oppId = owner.oppId;

  const foreign = await seedTenant("foreign");
  foreignUserId = foreign.userId;
  foreignOppId = foreign.oppId;

  // An owner-tenant supervisor: passes canAccessOpportunity (owner matches,
  // non-agent) but has NO user_channel_access rows, so getAllowedChannelIds is
  // empty → chatVisibleToUser must reject sends/edits into the owner's channel.
  const [member] = await db
    .insert(usersTable)
    .values({
      email: `sales-fu-member-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "supervisor",
      parentUserId: ownerUserId,
      plan: "enterprise",
    })
    .returning({ id: usersTable.id });
  memberUserId = member.id;

  const now = new Date();
  const [pending] = await db
    .insert(opportunityFollowUpsTable)
    .values({
      opportunityId: oppId,
      ownerUserId,
      sequence: 1,
      scheduledAt: now,
      status: "pending",
      generatedMessage: "Halo, masih berminat dengan penawaran kami?",
    })
    .returning({ id: opportunityFollowUpsTable.id });
  pendingFollowUpId = pending.id;

  const [sent] = await db
    .insert(opportunityFollowUpsTable)
    .values({
      opportunityId: oppId,
      ownerUserId,
      sequence: 2,
      scheduledAt: now,
      status: "sent",
      generatedMessage: "Sudah terkirim.",
      sentAt: now,
    })
    .returning({ id: opportunityFollowUpsTable.id });
  sentFollowUpId = sent.id;

  const [foreignFu] = await db
    .insert(opportunityFollowUpsTable)
    .values({
      opportunityId: foreignOppId,
      ownerUserId: foreignUserId,
      sequence: 1,
      scheduledAt: now,
      status: "pending",
      generatedMessage: "Pesan tenant lain.",
    })
    .returning({ id: opportunityFollowUpsTable.id });
  foreignFollowUpId = foreignFu.id;

  await new Promise<void>((resolve) => {
    server = createServer(makeApp(ownerUserId));
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  ran = true;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  // Delete the member before its owner (parent_user_id self-FK).
  if (memberUserId)
    await db.delete(usersTable).where(eq(usersTable.id, memberUserId));
  if (ownerUserId) await db.delete(usersTable).where(eq(usersTable.id, ownerUserId));
  if (foreignUserId)
    await db.delete(usersTable).where(eq(usersTable.id, foreignUserId));
});

describe("PATCH /sales/opportunities/:id/follow-ups/:followUpId", () => {
  it("edits the drafted message of a pending follow-up", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${baseUrl}/sales/opportunities/${oppId}/follow-ups/${pendingFollowUpId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generatedMessage: "Pesan yang sudah diedit." }),
      }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { generatedMessage?: string; status?: string };
    assert.equal(body.generatedMessage, "Pesan yang sudah diedit.");
    assert.equal(body.status, "pending");

    const [row] = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.id, pendingFollowUpId))
      .limit(1);
    assert.equal(row.generatedMessage, "Pesan yang sudah diedit.");
  });

  it("400s when editing a non-pending (already sent) follow-up", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${baseUrl}/sales/opportunities/${oppId}/follow-ups/${sentFollowUpId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generatedMessage: "Tidak boleh." }),
      }
    );
    assert.equal(res.status, 400);
    const [row] = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.id, sentFollowUpId))
      .limit(1);
    assert.equal(row.generatedMessage, "Sudah terkirim.");
    assert.equal(row.status, "sent");
  });

  it("404s a cross-tenant edit", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${baseUrl}/sales/opportunities/${foreignOppId}/follow-ups/${foreignFollowUpId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      }
    );
    assert.equal(res.status, 404);
    const [row] = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.id, foreignFollowUpId))
      .limit(1);
    assert.equal(row.status, "pending");
  });

  it("cancels a pending follow-up", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${baseUrl}/sales/opportunities/${oppId}/follow-ups/${pendingFollowUpId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      }
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status?: string };
    assert.equal(body.status, "cancelled");

    const [row] = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.id, pendingFollowUpId))
      .limit(1);
    assert.equal(row.status, "cancelled");
  });
});

describe("POST /sales/opportunities/:id/follow-ups/:followUpId/send", () => {
  let sendFollowUpId: number;

  before(async () => {
    if (!ran) return;
    const [fu] = await db
      .insert(opportunityFollowUpsTable)
      .values({
        opportunityId: oppId,
        ownerUserId,
        sequence: 3,
        scheduledAt: new Date(),
        status: "pending",
        generatedMessage: "Pesan siap kirim.",
      })
      .returning({ id: opportunityFollowUpsTable.id });
    sendFollowUpId = fu.id;
  });

  it("502s and stays pending when there is no socket to transmit on", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${baseUrl}/sales/opportunities/${oppId}/follow-ups/${sendFollowUpId}/send`,
      { method: "POST" }
    );
    assert.equal(res.status, 502);

    // The claim must have been rolled back: still pending, never sent.
    const [row] = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.id, sendFollowUpId))
      .limit(1);
    assert.equal(row.status, "pending");
    assert.equal(row.sentAt, null);

    // No follow_up_sent audit event was written for this deal.
    const events = await db
      .select()
      .from(salesAuditEventsTable)
      .where(
        and(
          eq(salesAuditEventsTable.opportunityId, oppId),
          eq(salesAuditEventsTable.eventType, "follow_up_sent")
        )
      );
    assert.equal(events.length, 0);
  });

  it("404s a cross-tenant send", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${baseUrl}/sales/opportunities/${foreignOppId}/follow-ups/${foreignFollowUpId}/send`,
      { method: "POST" }
    );
    assert.equal(res.status, 404);
  });
});

// A same-tenant member who can access the opportunity (owner matches, non-agent
// supervisor) but has NO access to the deal's channel must still be denied —
// broken-access-control guard: an agent scoped to channel A can never send a
// WhatsApp follow-up into channel B.
describe("per-channel scope on follow-up actions", () => {
  let scopedFollowUpId: number;
  let memberServer: Server;
  let memberBaseUrl: string;

  before(async () => {
    if (!ran) return;
    const [fu] = await db
      .insert(opportunityFollowUpsTable)
      .values({
        opportunityId: oppId,
        ownerUserId,
        sequence: 4,
        scheduledAt: new Date(),
        status: "pending",
        generatedMessage: "Pesan untuk uji scope channel.",
      })
      .returning({ id: opportunityFollowUpsTable.id });
    scopedFollowUpId = fu.id;

    await new Promise<void>((resolve) => {
      memberServer = createServer(makeApp(memberUserId));
      memberServer.listen(0, () => {
        const { port } = memberServer.address() as AddressInfo;
        memberBaseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (memberServer)
      await new Promise<void>((resolve) => memberServer.close(() => resolve()));
  });

  it("404s a send into a channel the member can't access", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${memberBaseUrl}/sales/opportunities/${oppId}/follow-ups/${scopedFollowUpId}/send`,
      { method: "POST" }
    );
    assert.equal(res.status, 404);

    // Untouched: still pending, never sent.
    const [row] = await db
      .select()
      .from(opportunityFollowUpsTable)
      .where(eq(opportunityFollowUpsTable.id, scopedFollowUpId))
      .limit(1);
    assert.equal(row.status, "pending");
    assert.equal(row.sentAt, null);
  });

  it("404s an edit into a channel the member can't access", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${memberBaseUrl}/sales/opportunities/${oppId}/follow-ups/${scopedFollowUpId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      }
    );
    assert.equal(res.status, 404);
  });
});
