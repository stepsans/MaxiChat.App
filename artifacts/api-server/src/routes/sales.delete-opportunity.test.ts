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
  salesAuditEventsTable,
} from "@workspace/db";
import { canAccessOpportunity } from "../lib/sales-assistant";

// Route-level integration test for DELETE /sales/opportunities/:id plus a
// pure-logic matrix for canAccessOpportunity (the authorization predicate the
// delete's opportunityScopeWhere mirrors).
//
// The route test proves: a super_admin can delete an opportunity in their own
// tenant (row removed + an owner-scoped "opportunity_deleted" audit event is
// written), a cross-tenant delete 404s (owner scoping), and a non-integer id
// 400s. The pure matrix proves the role semantics: super_admin / supervisor are
// tenant-wide; an agent is restricted to their own assigned deals; nobody can
// reach another tenant's deal.

const { default: salesRouter } = await import("./sales");

const tag = Date.now().toString().slice(-6);

let ownerUserId: number;
let foreignUserId: number;
let agentUserId: number;
let ownerOppId: number;
let foreignOppId: number;
let agentTargetOppId: number;
let server: Server;
let agentServer: Server;
let baseUrl: string;
let agentBaseUrl: string;
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
}> {
  const [user] = await db
    .insert(usersTable)
    .values({
      email: `sales-del-${emailTag}-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
      // requireSalesAssistant joins users.plan → plans.has_ai_sales_assistant.
      // The enterprise plan carries the entitlement.
      plan: "enterprise",
    })
    .returning({ id: usersTable.id });

  const [channel] = await db
    .insert(channelsTable)
    .values({ userId: user.id, kind: "whatsapp", label: `WA ${emailTag} ${tag}` })
    .returning({ id: channelsTable.id });

  const [chat] = await db
    .insert(chatsTable)
    .values({
      channelId: channel.id,
      phoneNumber: `62812${tag}${emailTag === "owner" ? "01" : "02"}`,
      contactName: `Lead ${emailTag}`,
    })
    .returning({ id: chatsTable.id });

  const [opp] = await db
    .insert(opportunitiesTable)
    .values({
      ownerUserId: user.id,
      chatId: chat.id,
      channelId: channel.id,
      contactPhone: `62812${tag}${emailTag === "owner" ? "01" : "02"}`,
      contactName: `Lead ${emailTag}`,
    })
    .returning({ id: opportunitiesTable.id });

  return { userId: user.id, oppId: opp.id };
}

before(async () => {
  if (!process.env.DATABASE_URL) return;

  const owner = await seedTenant("owner");
  ownerUserId = owner.userId;
  ownerOppId = owner.oppId;

  const foreign = await seedTenant("foreign");
  foreignUserId = foreign.userId;
  foreignOppId = foreign.oppId;

  // An agent inside the owner's tenant. The default RBAC matrix denies agents
  // the opportunities "delete" action, so requirePermission must 403 them.
  const [agent] = await db
    .insert(usersTable)
    .values({
      email: `sales-del-agent-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "agent",
      parentUserId: ownerUserId,
    })
    .returning({ id: usersTable.id });
  agentUserId = agent.id;

  // A second opportunity in the owner's tenant, assigned to the agent, so the
  // 403 is proven to come from the permission gate — not from scoping (the
  // agent owns this deal and would pass opportunityScopeWhere).
  const ownerChannel = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId))
    .limit(1);
  const [agentChat] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannel[0].id,
      phoneNumber: `62812${tag}03`,
      contactName: "Lead agent-target",
    })
    .returning({ id: chatsTable.id });
  const [agentOpp] = await db
    .insert(opportunitiesTable)
    .values({
      ownerUserId,
      assignedUserId: agentUserId,
      chatId: agentChat.id,
      channelId: ownerChannel[0].id,
      contactPhone: `62812${tag}03`,
      contactName: "Lead agent-target",
    })
    .returning({ id: opportunitiesTable.id });
  agentTargetOppId = agentOpp.id;

  await new Promise<void>((resolve) => {
    server = createServer(makeApp(ownerUserId));
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
  await new Promise<void>((resolve) => {
    agentServer = createServer(makeApp(agentUserId));
    agentServer.listen(0, () => {
      const { port } = agentServer.address() as AddressInfo;
      agentBaseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  ran = true;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (agentServer)
    await new Promise<void>((resolve) => agentServer.close(() => resolve()));
  // Delete the agent (child) first, then owners; owners cascade to
  // channels/chats/opportunities/audit events.
  if (agentUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, agentUserId));
  }
  if (ownerUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, ownerUserId));
  }
  if (foreignUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, foreignUserId));
  }
});

describe("DELETE /sales/opportunities/:id (route)", () => {
  it("404s when deleting an opportunity owned by another tenant", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/sales/opportunities/${foreignOppId}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 404);
    // Foreign row must still exist.
    const [still] = await db
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, foreignOppId))
      .limit(1);
    assert.ok(still, "foreign opportunity should not be deleted");
  });

  it("400s for a non-integer id", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/sales/opportunities/abc`, {
      method: "DELETE",
    });
    assert.equal(res.status, 400);
  });

  it("403s an agent who lacks the delete permission (own assigned deal)", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(
      `${agentBaseUrl}/sales/opportunities/${agentTargetOppId}`,
      { method: "DELETE" }
    );
    assert.equal(res.status, 403);
    // The deal must survive — the permission gate blocked before any delete.
    const [still] = await db
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, agentTargetOppId))
      .limit(1);
    assert.ok(still, "agent's deal should not be deleted");
  });

  it("super_admin deletes an own-tenant opportunity and records an audit event", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/sales/opportunities/${ownerOppId}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { success?: boolean };
    assert.equal(body.success, true);

    // Row is gone.
    const [gone] = await db
      .select({ id: opportunitiesTable.id })
      .from(opportunitiesTable)
      .where(eq(opportunitiesTable.id, ownerOppId))
      .limit(1);
    assert.equal(gone, undefined);

    // An owner-scoped deletion audit event was written (opportunityId NULL so
    // it survives the cascade; detail carries the deleted id).
    const events = await db
      .select()
      .from(salesAuditEventsTable)
      .where(
        and(
          eq(salesAuditEventsTable.ownerUserId, ownerUserId),
          eq(salesAuditEventsTable.eventType, "opportunity_deleted")
        )
      );
    assert.equal(events.length, 1);
    assert.equal(events[0].opportunityId, null);
    assert.equal(
      (events[0].detail as { opportunityId?: number }).opportunityId,
      ownerOppId
    );
  });
});

describe("canAccessOpportunity (delete/edit authorization matrix)", () => {
  const OWNER = 1;
  const OTHER_OWNER = 2;
  const AGENT = 10;
  const OTHER_AGENT = 11;

  it("super_admin and supervisor are tenant-wide", () => {
    for (const role of ["super_admin", "supervisor"] as const) {
      // assigned to someone else — still allowed for tenant-wide roles.
      assert.equal(
        canAccessOpportunity(
          { ownerUserId: OWNER, assignedUserId: OTHER_AGENT },
          OWNER,
          role,
          AGENT
        ),
        true
      );
      // unassigned — allowed.
      assert.equal(
        canAccessOpportunity(
          { ownerUserId: OWNER, assignedUserId: null },
          OWNER,
          role,
          AGENT
        ),
        true
      );
      // different tenant — denied.
      assert.equal(
        canAccessOpportunity(
          { ownerUserId: OTHER_OWNER, assignedUserId: AGENT },
          OWNER,
          role,
          AGENT
        ),
        false
      );
    }
  });

  it("agent is restricted to their own assigned deals", () => {
    // own assignment — allowed.
    assert.equal(
      canAccessOpportunity(
        { ownerUserId: OWNER, assignedUserId: AGENT },
        OWNER,
        "agent",
        AGENT
      ),
      true
    );
    // another agent's deal — denied.
    assert.equal(
      canAccessOpportunity(
        { ownerUserId: OWNER, assignedUserId: OTHER_AGENT },
        OWNER,
        "agent",
        AGENT
      ),
      false
    );
    // unassigned — denied.
    assert.equal(
      canAccessOpportunity(
        { ownerUserId: OWNER, assignedUserId: null },
        OWNER,
        "agent",
        AGENT
      ),
      false
    );
    // own assignment but different tenant — denied.
    assert.equal(
      canAccessOpportunity(
        { ownerUserId: OTHER_OWNER, assignedUserId: AGENT },
        OWNER,
        "agent",
        AGENT
      ),
      false
    );
  });
});
