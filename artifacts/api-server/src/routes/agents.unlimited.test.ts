import { before, after, describe, it } from "node:test";
import { mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

// Route-level integration test for GET /agents' `unlimited` field — the guard
// against the Owner Infinity account ever rendering as a raw plan ("Paket
// Basic") on the team page. The flag is RBAC-only (users.is_infinity_owner),
// never written to users.plan (which stays at its "basic" default), so the
// only thing the team page can key off is this surfaced `unlimited` boolean.
// A future refactor dropping it would silently regress the original bug, so we
// assert it end-to-end against seeded rows (baseline-delta style: each test
// seeds and tears down its own users).
//
// agents.ts imports MEDIA_DIR from ./whatsapp; stub that module so importing
// the router doesn't pull in Baileys (its CommonJS require throws under tsx's
// ESM loader). Everything else (resolveOwner, planUserLimit, isInfinityOwner)
// runs for real against the seeded rows.
mock.module("./whatsapp", {
  namedExports: {
    MEDIA_DIR: "/tmp/maxichat-test-media",
  },
});

const { default: agentsRouter } = await import("./agents");

const tag = Date.now().toString().slice(-6);

let infinityOwnerId: number;
let normalOwnerId: number;
let server: Server;
let baseUrl: string;
let ran = false;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Session user id is taken from a per-request header so one server can
    // serve requests as either seeded owner.
    const headerId = Number(req.headers["x-test-user-id"]);
    (req as unknown as { session: unknown }).session = { userId: headerId };
    (req as unknown as { log: unknown }).log = {
      error() {},
      warn() {},
      info() {},
      debug() {},
    };
    next();
  });
  app.use("/agents", agentsRouter);
  return app;
}

before(async () => {
  if (!process.env.DATABASE_URL) return;

  const [infinity] = await db
    .insert(usersTable)
    .values({
      email: `agents-infinity-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
      // Plan stays at the "basic" default on purpose — the whole point is that
      // the flag, not the plan column, drives `unlimited`.
      plan: "basic",
      isInfinityOwner: true,
    })
    .returning({ id: usersTable.id });
  infinityOwnerId = infinity.id;

  const [normal] = await db
    .insert(usersTable)
    .values({
      email: `agents-normal-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
      plan: "basic",
      isInfinityOwner: false,
    })
    .returning({ id: usersTable.id });
  normalOwnerId = normal.id;

  await new Promise<void>((resolve) => {
    server = createServer(makeApp());
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
  if (infinityOwnerId) {
    await db.delete(usersTable).where(eq(usersTable.id, infinityOwnerId));
  }
  if (normalOwnerId) {
    await db.delete(usersTable).where(eq(usersTable.id, normalOwnerId));
  }
});

describe("GET /agents — unlimited flag (Owner Infinity guard)", () => {
  it("returns unlimited === true for an infinity owner whose plan column is still 'basic'", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { "x-test-user-id": String(infinityOwnerId) },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string; unlimited: boolean };
    // The raw plan column is unchanged ("basic")…
    assert.equal(body.plan, "basic");
    // …but the flag must surface as unlimited so the team page renders "Owner
    // Infinity" instead of "Paket Basic".
    assert.equal(body.unlimited, true);
  });

  it("returns unlimited === false for a normal-plan owner", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/agents`, {
      headers: { "x-test-user-id": String(normalOwnerId) },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plan: string; unlimited: boolean };
    assert.equal(body.plan, "basic");
    assert.equal(body.unlimited, false);
  });
});
