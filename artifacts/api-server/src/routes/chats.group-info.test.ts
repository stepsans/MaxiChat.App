import { test, mock, before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  usersTable,
  channelsTable,
  chatsTable,
  chatMessagesTable,
} from "@workspace/db";

// Route-level integration test for GET /:id/group-info.
//
// The pure name-resolution pipeline is already covered by group-info.test.ts.
// What this test exercises is the HTTP layer that pipeline talks to: the
// auth/ownership guard (404 for a foreign chat), the "not a group chat"
// rejection (400), the "WhatsApp not connected" path (409 when the socket is
// missing), and the assembly of subject/description/invite-link/participants
// from a *fake* Baileys socket. The real `getSockForChannel` reads an
// in-memory ctx that only a live pairing populates, so we mock the whatsapp
// module to inject a controllable socket — everything else (DB scoping,
// resolveGroupParticipants) runs for real against a seeded chat.

// Mutable socket the mocked getSockForChannel returns; toggled per test.
let fakeSock: unknown = null;
// Records every channelId getSockForChannel was called with, so we can assert
// the handler resolves the socket for the chat's OWN channel (not the primary).
const sockChannelArgs: number[] = [];

// Fully stub the whatsapp module: importing the real one pulls in Baileys and
// a CommonJS `require` call that throws under tsx's ESM loader. The group-info
// handler only calls getSockForChannel, so the remaining exports are inert
// stubs that just need to exist for chats.ts's import binding. Must be set up
// before ./chats is imported below.
const notUsed = () => {
  throw new Error("whatsapp export not expected in group-info route test");
};
mock.module("./whatsapp", {
  namedExports: {
    MEDIA_DIR: "/tmp/maxichat-test-media",
    getSockForChannel: (channelId: number) => {
      sockChannelArgs.push(channelId);
      return fakeSock;
    },
    sendMediaToJid: notUsed,
    sendContactToJid: notUsed,
    getActiveSocket: notUsed,
    getOrCreateChat: notUsed,
    refreshChatProfilePic: notUsed,
    isProfilePicRefreshDue: () => false,
    loadImageBuffer: notUsed,
  },
});

const { default: chatsRouter } = await import("./chats");

const tag = Date.now().toString().slice(-6);
const PHONE_A = `62822${tag}01`; // history name seeded → resolves to "Alpha"
const PHONE_B = `62822${tag}02`; // no history/contact → name null

let ownerUserId: number;
let foreignUserId: number;
let ownerChannelId: number;
let groupChatId: number;
let dmChatId: number;
let foreignGroupChatId: number;
let server: Server;
let baseUrl: string;
let ran = false;

function makeApp(sessionUserId: number) {
  const app = express();
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
  app.use("/chats", chatsRouter);
  return app;
}

before(async () => {
  if (!process.env.DATABASE_URL) return;

  const [owner] = await db
    .insert(usersTable)
    .values({
      email: `gi-route-owner-${tag}@example.test`,
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
      email: `gi-route-foreign-${tag}@example.test`,
      passwordHash: "x",
      role: "user",
      status: "active",
      teamRole: "super_admin",
    })
    .returning({ id: usersTable.id });
  foreignUserId = foreign.id;

  const [channel] = await db
    .insert(channelsTable)
    .values({ userId: ownerUserId, kind: "whatsapp", label: `WA ${tag}` })
    .returning({ id: channelsTable.id });
  ownerChannelId = channel.id;

  const [foreignChannel] = await db
    .insert(channelsTable)
    .values({ userId: foreignUserId, kind: "whatsapp", label: `WAF ${tag}` })
    .returning({ id: channelsTable.id });

  const [groupChat] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannelId,
      phoneNumber: `1203630${tag}@g.us`,
      contactName: "Fallback Subject",
    })
    .returning({ id: chatsTable.id });
  groupChatId = groupChat.id;

  const [dmChat] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannelId,
      phoneNumber: `62822${tag}99`,
      contactName: "A Person",
    })
    .returning({ id: chatsTable.id });
  dmChatId = dmChat.id;

  const [foreignGroup] = await db
    .insert(chatsTable)
    .values({
      channelId: foreignChannel.id,
      phoneNumber: `1203631${tag}@g.us`,
      contactName: "Foreign Group",
    })
    .returning({ id: chatsTable.id });
  foreignGroupChatId = foreignGroup.id;

  // Seed a pushName for PHONE_A under the group chat so the happy-path body
  // proves the handler passed the correct chat id into resolveGroupParticipants
  // (a wrong id would yield a null name).
  await db.insert(chatMessagesTable).values({
    chatId: groupChatId,
    direction: "inbound",
    content: "hi",
    senderPhoneDigits: PHONE_A,
    senderName: "Alpha",
  });

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
  if (ownerUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, ownerUserId));
  }
  if (foreignUserId) {
    await db.delete(usersTable).where(eq(usersTable.id, foreignUserId));
  }
});

describe("GET /:id/group-info (route)", () => {
  it("404s for a chat the caller does not own", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = { groupMetadata: async () => ({}) };
    const res = await fetch(`${baseUrl}/chats/${foreignGroupChatId}/group-info`);
    assert.equal(res.status, 404);
  });

  it("400s for a non-group chat", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    // Socket present, but the @g.us check must reject before it is consulted.
    fakeSock = { groupMetadata: async () => ({}) };
    const res = await fetch(`${baseUrl}/chats/${dmChatId}/group-info`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Not a group chat");
  });

  it("409s when WhatsApp is not connected", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = null;
    const res = await fetch(`${baseUrl}/chats/${groupChatId}/group-info`);
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "WhatsApp not connected");
  });

  it("returns metadata, invite link and resolved participants on success", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    sockChannelArgs.length = 0;
    fakeSock = {
      groupMetadata: async (jid: string) => {
        assert.equal(jid, `1203630${tag}@g.us`);
        return {
          subject: "Project Chat",
          desc: "Daily standups",
          owner: `${PHONE_A}@s.whatsapp.net`,
          creation: 1_700_000_000,
          size: 2,
          participants: [
            { id: `${PHONE_A}@s.whatsapp.net`, admin: "superadmin" },
            { id: `${PHONE_B}@s.whatsapp.net` },
          ],
        };
      },
      groupInviteCode: async () => "INVITE123",
    };

    const res = await fetch(`${baseUrl}/chats/${groupChatId}/group-info`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      subject: string;
      description: string | null;
      ownerJid: string | null;
      creationAt: string | null;
      size: number;
      inviteLink: string | null;
      participants: {
        phone: string | null;
        name: string | null;
        isAdmin: boolean;
        isSuperAdmin: boolean;
      }[];
    };

    assert.equal(body.subject, "Project Chat");
    assert.equal(body.description, "Daily standups");
    assert.equal(body.inviteLink, "https://chat.whatsapp.com/INVITE123");
    assert.equal(body.size, 2);
    assert.equal(body.creationAt, new Date(1_700_000_000 * 1000).toISOString());

    // Socket was resolved for the chat's own channel, not the primary helper.
    assert.ok(sockChannelArgs.includes(ownerChannelId));

    assert.equal(body.participants.length, 2);
    const [a, b] = body.participants;
    assert.equal(a.phone, PHONE_A);
    assert.equal(a.name, "Alpha"); // resolved from seeded history under groupChatId
    assert.equal(a.isAdmin, true);
    assert.equal(a.isSuperAdmin, true);
    assert.equal(b.phone, PHONE_B);
    assert.equal(b.name, null);
    assert.equal(b.isAdmin, false);
  });

  it("returns a null invite link when the code lookup fails", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = {
      groupMetadata: async () => ({
        subject: "No Invite",
        participants: [],
      }),
      groupInviteCode: async () => {
        throw new Error("not an admin");
      },
    };
    const res = await fetch(`${baseUrl}/chats/${groupChatId}/group-info`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { inviteLink: string | null };
    assert.equal(body.inviteLink, null);
  });
});
