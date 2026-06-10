import { Router, type Request, type Response } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { chatsTable, db } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  classifyAndTagChat,
  CHAT_PIPELINES,
  getPipelinesForTeamRole,
} from "../lib/chat-classifier";

const router = Router();

function getTeamRole(req: Request): string {
  return req.session?.teamRole ?? "agent";
}

async function getOwner(
  req: Request,
  res: Response,
): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

// ─── GET /api/chat-classifier/pipelines ───────────────────────────────────────
// Returns the pipelines visible to the signed-in user's role.
// The frontend calls this to build the routing sidebar.

router.get("/pipelines", async (req: Request, res: Response) => {
  const uid = getSessionUserId(req);
  if (uid == null) { res.status(401).json({ error: "Not signed in" }); return; }

  const teamRole = getTeamRole(req);
  const pipelines = getPipelinesForTeamRole(teamRole);

  res.json(
    pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      priority: p.priority,
    })),
  );
});

// ─── GET /api/chat-classifier/chats?tag=sales&limit=50&page=1 ─────────────────
// Returns chats routed to a given pipeline, filtered by the caller's role.

router.get("/chats", async (req: Request, res: Response) => {
  const ownerUserId = await getOwner(req, res);
  if (!ownerUserId) return;

  const teamRole = getTeamRole(req);
  const allowed = getPipelinesForTeamRole(teamRole).map((p) => p.id);

  const tag = typeof req.query.tag === "string" ? req.query.tag : null;

  if (tag && !allowed.includes(tag)) {
    res.status(403).json({ error: `Role '${teamRole}' tidak punya akses ke pipeline '${tag}'` });
    return;
  }

  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
  const offset = (page - 1) * limit;

  const tagFilter = tag ? [tag] : allowed;

  const [rows, countResult] = await Promise.all([
    db
      .select({
        id: chatsTable.id,
        channelId: chatsTable.channelId,
        phoneNumber: chatsTable.phoneNumber,
        contactName: chatsTable.contactName,
        tag: chatsTable.tag,
        status: chatsTable.status,
        lastMessage: chatsTable.lastMessage,
        lastMessageAt: chatsTable.lastMessageAt,
        unreadCount: chatsTable.unreadCount,
        assignedUserId: chatsTable.assignedUserId,
        createdAt: chatsTable.createdAt,
      })
      .from(chatsTable)
      .where(
        and(
          inArray(chatsTable.tag, tagFilter),
          // Scope to channels that belong to this owner. We join via channel_id
          // using a subquery so we don't need to import channelsTable here.
          sql`${chatsTable.channelId} IN (
            SELECT id FROM channels WHERE user_id = ${ownerUserId}
          )`,
        ),
      )
      .orderBy(desc(chatsTable.lastMessageAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatsTable)
      .where(
        and(
          inArray(chatsTable.tag, tagFilter),
          sql`${chatsTable.channelId} IN (
            SELECT id FROM channels WHERE user_id = ${ownerUserId}
          )`,
        ),
      ),
  ]);

  res.json({
    data: rows.map((r) => ({
      ...r,
      lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total: countResult[0]?.count ?? 0,
    page,
    limit,
  });
});

// ─── GET /api/chat-classifier/summary ─────────────────────────────────────────
// Returns count per pipeline tag, useful for the sidebar badge counters.

router.get("/summary", async (req: Request, res: Response) => {
  const ownerUserId = await getOwner(req, res);
  if (!ownerUserId) return;

  const teamRole = getTeamRole(req);
  const allowed = getPipelinesForTeamRole(teamRole).map((p) => p.id);

  const rows = await db
    .select({
      tag: chatsTable.tag,
      count: sql<number>`count(*)::int`,
    })
    .from(chatsTable)
    .where(
      and(
        inArray(chatsTable.tag, allowed),
        sql`${chatsTable.channelId} IN (
          SELECT id FROM channels WHERE user_id = ${ownerUserId}
        )`,
      ),
    )
    .groupBy(chatsTable.tag);

  // Build a complete map (0 for pipelines with no chats yet).
  const countMap = Object.fromEntries(rows.map((r) => [r.tag, r.count]));
  const summary = allowed.map((id) => ({
    pipelineId: id,
    name: CHAT_PIPELINES.find((p) => p.id === id)?.name ?? id,
    color: CHAT_PIPELINES.find((p) => p.id === id)?.color ?? "#888",
    count: countMap[id] ?? 0,
  }));

  res.json(summary);
});

// ─── POST /api/chat-classifier/chats/:id/classify ─────────────────────────────
// Manually (re-)classify a single chat. Returns the new pipeline tag.

router.post("/chats/:id/classify", async (req: Request, res: Response) => {
  const ownerUserId = await getOwner(req, res);
  if (!ownerUserId) return;

  const chatId = parseInt(String(req.params.id), 10);
  if (isNaN(chatId)) { res.status(400).json({ error: "Invalid chat id" }); return; }

  // Verify this chat belongs to the owner.
  const [chat] = await db
    .select({ id: chatsTable.id, lastMessage: chatsTable.lastMessage, tag: chatsTable.tag })
    .from(chatsTable)
    .where(
      and(
        eq(chatsTable.id, chatId),
        sql`${chatsTable.channelId} IN (
          SELECT id FROM channels WHERE user_id = ${ownerUserId}
        )`,
      ),
    )
    .limit(1);

  if (!chat) { res.status(404).json({ error: "Chat not found" }); return; }

  const newTag = await classifyAndTagChat(
    chatId,
    chat.lastMessage ?? "",
    ownerUserId,
  );

  res.json({ chatId, previousTag: chat.tag, newTag });
});

export default router;
