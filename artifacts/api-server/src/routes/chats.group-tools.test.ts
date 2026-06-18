import { before, after, describe, it } from "node:test";
import { mock } from "node:test";
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

// Route-level integration tests for the group "tools" endpoints that live in
// the same handler file as GET /:id/group-info but had no HTTP-layer coverage:
//
//   GET  /:id/attachments     — shared media/docs/links split, 300 cap
//   GET  /:id/starred         — MaxiChat-internal starred messages
//   POST /:id/participants     — add members (phone normalize + channel binding)
//
// Reuses the express-app + fake-socket + DB-seed harness from
// chats.group-info.test.ts: the whatsapp module is fully stubbed so importing
// chats.ts doesn't pull in Baileys (its CommonJS require throws under tsx's ESM
// loader), and getSockForChannel returns a controllable fake socket. Everything
// else (DB scoping via loadOwnedChat, the group/connection guards, phone
// normalization, response assembly) runs for real against seeded rows.

// Mutable socket the mocked getSockForChannel returns; toggled per test.
let fakeSock: unknown = null;
// Records every channelId getSockForChannel was called with, so a test can
// assert the handler resolves the socket for the chat's OWN channel.
const sockChannelArgs: number[] = [];
// Records the args passed to groupParticipantsUpdate by the happy-path add.
let lastUpdateArgs: { jid: string; participants: string[]; action: string } | null =
  null;

const notUsed = () => {
  throw new Error("whatsapp export not expected in group-tools route test");
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
    sendLocationToJid: notUsed,
    getChatPresence: () => null,
    subscribeChatPresence: async () => {},
    getActiveSocket: notUsed,
    getOrCreateChat: notUsed,
    refreshChatProfilePic: notUsed,
    isProfilePicRefreshDue: () => false,
    loadImageBuffer: notUsed,
  },
});

const { default: chatsRouter } = await import("./chats");

const tag = Date.now().toString().slice(-6);

let ownerUserId: number;
let foreignUserId: number;
let ownerChannelId: number;
let groupChatId: number;
let dmChatId: number;
let foreignGroupChatId: number;
let attachChatId: number;
let capChatId: number;
let starredChatId: number;
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
  app.use("/chats", chatsRouter);
  return app;
}

before(async () => {
  if (!process.env.DATABASE_URL) return;

  const [owner] = await db
    .insert(usersTable)
    .values({
      email: `gt-route-owner-${tag}@example.test`,
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
      email: `gt-route-foreign-${tag}@example.test`,
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
      contactName: "Group Subject",
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

  const [attachChat] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannelId,
      phoneNumber: `62822${tag}77`,
      contactName: "Attach Chat",
    })
    .returning({ id: chatsTable.id });
  attachChatId = attachChat.id;

  const [capChat] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannelId,
      phoneNumber: `62822${tag}66`,
      contactName: "Cap Chat",
    })
    .returning({ id: chatsTable.id });
  capChatId = capChat.id;

  const [starredChat] = await db
    .insert(chatsTable)
    .values({
      channelId: ownerChannelId,
      phoneNumber: `62822${tag}55`,
      contactName: "Starred Chat",
    })
    .returning({ id: chatsTable.id });
  starredChatId = starredChat.id;

  // Seed attachments: one image, one video, one document, and one text message
  // with two URLs in its content. Older→newer createdAt so the desc() ordering
  // in the handler is deterministic. The image/video/doc carry empty-ish
  // content so they don't also contribute links.
  const base = Date.UTC(2026, 0, 1, 0, 0, 0);
  await db.insert(chatMessagesTable).values([
    {
      chatId: attachChatId,
      direction: "inbound",
      content: "",
      mediaType: "image",
      mediaUrl: "/media/img.jpg",
      mediaMimeType: "image/jpeg",
      mediaFilename: "img.jpg",
      senderName: "Sender One",
      createdAt: new Date(base + 1000),
    },
    {
      chatId: attachChatId,
      direction: "outbound",
      content: "",
      mediaType: "video",
      mediaUrl: "/media/clip.mp4",
      mediaMimeType: "video/mp4",
      mediaFilename: "clip.mp4",
      senderName: null,
      createdAt: new Date(base + 2000),
    },
    {
      chatId: attachChatId,
      direction: "inbound",
      content: "",
      mediaType: "document",
      mediaUrl: "/media/spec.pdf",
      mediaMimeType: "application/pdf",
      mediaFilename: "spec.pdf",
      senderName: "Sender Two",
      createdAt: new Date(base + 3000),
    },
    {
      chatId: attachChatId,
      direction: "inbound",
      content: "see https://example.com/a and http://foo.test/b please",
      senderName: "Linker",
      createdAt: new Date(base + 4000),
    },
  ]);

  // Cap chat: 301 image messages — the handler caps each bucket at 300.
  const capRows = Array.from({ length: 301 }, (_, i) => ({
    chatId: capChatId,
    direction: "inbound" as const,
    content: "",
    mediaType: "image",
    mediaUrl: `/media/cap-${i}.jpg`,
    createdAt: new Date(base + i * 1000),
  }));
  await db.insert(chatMessagesTable).values(capRows);

  // Starred chat: two starred + one unstarred message.
  await db.insert(chatMessagesTable).values([
    {
      chatId: starredChatId,
      direction: "inbound",
      content: "starred older",
      isStarred: true,
      createdAt: new Date(base + 1000),
    },
    {
      chatId: starredChatId,
      direction: "outbound",
      content: "not starred",
      isStarred: false,
      createdAt: new Date(base + 2000),
    },
    {
      chatId: starredChatId,
      direction: "inbound",
      content: "starred newer",
      isStarred: true,
      createdAt: new Date(base + 3000),
    },
  ]);

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

describe("GET /:id/attachments (route)", () => {
  it("404s for a chat the caller does not own", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/chats/${foreignGroupChatId}/attachments`);
    assert.equal(res.status, 404);
  });

  it("splits media, documents and links and shapes each item", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/chats/${attachChatId}/attachments`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      media: {
        id: number;
        mediaType: string | null;
        mediaUrl: string | null;
        mediaMimeType: string | null;
        mediaFilename: string | null;
        content: string;
        direction: string;
        createdAt: string;
        senderName: string | null;
      }[];
      docs: { mediaType: string | null; mediaFilename: string | null }[];
      links: {
        messageId: number;
        url: string;
        createdAt: string;
        senderName: string | null;
      }[];
    };

    // media = image + video; ordered newest-first (video then image).
    assert.equal(body.media.length, 2);
    assert.deepEqual(
      body.media.map((m) => m.mediaType),
      ["video", "image"]
    );
    const image = body.media.find((m) => m.mediaType === "image")!;
    assert.equal(image.mediaUrl, "/media/img.jpg");
    assert.equal(image.mediaMimeType, "image/jpeg");
    assert.equal(image.mediaFilename, "img.jpg");
    assert.equal(image.direction, "inbound");
    assert.equal(image.senderName, "Sender One");
    assert.equal(typeof image.id, "number");
    assert.equal(typeof image.createdAt, "string");

    // docs = the single document.
    assert.equal(body.docs.length, 1);
    assert.equal(body.docs[0].mediaType, "document");
    assert.equal(body.docs[0].mediaFilename, "spec.pdf");

    // links = both URLs extracted from the text message's content.
    assert.equal(body.links.length, 2);
    const urls = body.links.map((l) => l.url).sort();
    assert.deepEqual(urls, ["http://foo.test/b", "https://example.com/a"]);
    assert.equal(body.links[0].senderName, "Linker");
    assert.equal(typeof body.links[0].messageId, "number");
  });

  it("caps each bucket at 300 items", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/chats/${capChatId}/attachments`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { media: unknown[] };
    assert.equal(body.media.length, 300);
  });
});

describe("GET /:id/starred (route)", () => {
  it("404s for a chat the caller does not own", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/chats/${foreignGroupChatId}/starred`);
    assert.equal(res.status, 404);
  });

  it("returns only starred messages, newest-first", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/chats/${starredChatId}/starred`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      messages: { content: string; isStarred: boolean }[];
    };
    assert.equal(body.messages.length, 2);
    assert.ok(body.messages.every((m) => m.isStarred === true));
    assert.deepEqual(
      body.messages.map((m) => m.content),
      ["starred newer", "starred older"]
    );
  });
});

describe("POST /:id/participants (route)", () => {
  it("404s for a group the caller does not own", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = { groupParticipantsUpdate: async () => [] };
    const res = await fetch(
      `${baseUrl}/chats/${foreignGroupChatId}/participants`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phones: ["6281234567890"] }),
      }
    );
    assert.equal(res.status, 404);
  });

  it("400s on an invalid body (empty phones)", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    const res = await fetch(`${baseUrl}/chats/${groupChatId}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phones: [] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Invalid body");
  });

  it("400s for a non-group chat", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = { groupParticipantsUpdate: async () => [] };
    const res = await fetch(`${baseUrl}/chats/${dmChatId}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phones: ["6281234567890"] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Not a group chat");
  });

  it("409s when WhatsApp is not connected", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = null;
    const res = await fetch(`${baseUrl}/chats/${groupChatId}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phones: ["6281234567890"] }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "WhatsApp not connected");
  });

  it("400s when no phone has any digits after normalization", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    fakeSock = { groupParticipantsUpdate: async () => [] };
    const res = await fetch(`${baseUrl}/chats/${groupChatId}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phones: ["+- ()"] }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "No valid phone numbers");
  });

  it("normalizes phones, binds the chat's channel, and maps statuses", async (t) => {
    if (!ran) return t.skip("no DATABASE_URL");
    sockChannelArgs.length = 0;
    lastUpdateArgs = null;
    const jidAdded = `6281234567890@s.whatsapp.net`;
    const jidFailed = `6289998887777@s.whatsapp.net`;
    fakeSock = {
      groupParticipantsUpdate: async (
        jid: string,
        participants: string[],
        action: string
      ) => {
        lastUpdateArgs = { jid, participants, action };
        return [
          { jid: jidAdded, status: "200" },
          { jid: jidFailed, status: "403" },
        ];
      },
    };

    const res = await fetch(`${baseUrl}/chats/${groupChatId}/participants`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phones: ["+62 812-3456-7890", "(628) 999.888.7777"],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      results: { phone: string; jid: string; status: string }[];
    };

    // Socket was resolved for the group chat's own channel.
    assert.ok(sockChannelArgs.includes(ownerChannelId));

    // groupParticipantsUpdate received the group jid, normalized member jids
    // (digits-only @s.whatsapp.net) and the "add" action.
    const updateArgs = lastUpdateArgs as {
      jid: string;
      participants: string[];
      action: string;
    } | null;
    assert.ok(updateArgs);
    assert.equal(updateArgs.jid, `1203630${tag}@g.us`);
    assert.equal(updateArgs.action, "add");
    assert.deepEqual(updateArgs.participants, [jidAdded, jidFailed]);

    // Each requested jid is echoed back with its WhatsApp status code.
    assert.equal(body.results.length, 2);
    const added = body.results.find((r) => r.jid === jidAdded)!;
    assert.equal(added.phone, "6281234567890");
    assert.equal(added.status, "200");
    const failed = body.results.find((r) => r.jid === jidFailed)!;
    assert.equal(failed.status, "403");
  });
});
