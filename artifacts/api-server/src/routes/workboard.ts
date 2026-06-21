import { Router } from "express";
import type { Request, Response } from "express";
import { and, asc, desc, eq, inArray, not, sql } from "drizzle-orm";
import {
  db,
  workboardBoardsTable,
  workboardBoardMembersTable,
  workboardColumnsTable,
  workboardTasksTable,
  workboardTaskAssigneesTable,
  workboardTaskCommentsTable,
  workboardCommentMentionsTable,
  workboardNotificationsTable,
  usersTable,
  type WorkboardBoardMemberRow,
} from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requirePermission } from "../lib/role-permissions";
import { parseMentionIds } from "../lib/workboard-mentions";
import { notifyWorkboardMentions } from "../lib/workboard-notify";

const router = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

async function getOwnerUserId(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

async function getBoardMember(
  boardId: number,
  userId: number
): Promise<WorkboardBoardMemberRow | null> {
  const [member] = await db
    .select()
    .from(workboardBoardMembersTable)
    .where(
      and(
        eq(workboardBoardMembersTable.boardId, boardId),
        eq(workboardBoardMembersTable.userId, userId)
      )
    )
    .limit(1);
  return member ?? null;
}

async function requireBoardAccess(
  boardId: number,
  userId: number,
  minRole: "viewer" | "editor" | "owner",
  res: Response
): Promise<WorkboardBoardMemberRow | null> {
  const member = await getBoardMember(boardId, userId);
  if (!member || (ROLE_RANK[member.role] ?? -1) < (ROLE_RANK[minRole] ?? 0)) {
    res.status(403).json({ error: "Tidak memiliki akses ke board ini." });
    return null;
  }
  return member;
}

async function getTaskAssignees(taskIds: number[]) {
  if (taskIds.length === 0) return [];
  return db
    .select({
      taskId: workboardTaskAssigneesTable.taskId,
      userId: workboardTaskAssigneesTable.userId,
      name: usersTable.name,
      email: usersTable.email,
    })
    .from(workboardTaskAssigneesTable)
    .leftJoin(usersTable, eq(workboardTaskAssigneesTable.userId, usersTable.id))
    .where(inArray(workboardTaskAssigneesTable.taskId, taskIds));
}

// ─── BOARDS ──────────────────────────────────────────────────────────────────

router.get(
  "/boards",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const archived = req.query.archived === "true";

    // User sees boards where they are a member AND board belongs to their tenant
    const memberRows = await db
      .select({ boardId: workboardBoardMembersTable.boardId })
      .from(workboardBoardMembersTable)
      .where(eq(workboardBoardMembersTable.userId, uid));

    const boardIds = memberRows.map((r) => r.boardId);
    if (boardIds.length === 0) {
      res.json({ boards: [] });
      return;
    }

    const boards = await db
      .select()
      .from(workboardBoardsTable)
      .where(
        and(
          eq(workboardBoardsTable.ownerUserId, ownerUserId),
          inArray(workboardBoardsTable.id, boardIds),
          eq(workboardBoardsTable.isArchived, archived)
        )
      )
      .orderBy(asc(workboardBoardsTable.updatedAt));

    // Member counts & task counts per board
    const [memberCounts, taskCounts] = await Promise.all([
      db
        .select({
          boardId: workboardBoardMembersTable.boardId,
          count: sql<number>`count(*)::int`,
        })
        .from(workboardBoardMembersTable)
        .where(inArray(workboardBoardMembersTable.boardId, boardIds))
        .groupBy(workboardBoardMembersTable.boardId),
      db
        .select({
          boardId: workboardTasksTable.boardId,
          count: sql<number>`count(*)::int`,
        })
        .from(workboardTasksTable)
        .where(inArray(workboardTasksTable.boardId, boardIds))
        .groupBy(workboardTasksTable.boardId),
    ]);

    const memberCountMap = Object.fromEntries(memberCounts.map((r) => [r.boardId, r.count]));
    const taskCountMap = Object.fromEntries(taskCounts.map((r) => [r.boardId, r.count]));

    res.json({
      boards: boards.map((b) => ({
        ...b,
        memberCount: memberCountMap[b.id] ?? 0,
        taskCount: taskCountMap[b.id] ?? 0,
      })),
    });
  }
);

router.post(
  "/boards",
  requirePermission("workboard", "create"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const { name, description, defaultView, color, emoji } = req.body as {
      name?: string;
      description?: string;
      defaultView?: string;
      color?: string;
      emoji?: string;
    };

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Nama board wajib diisi." });
      return;
    }
    if (name.trim().length > 100) {
      res.status(400).json({ error: "Nama board maksimal 100 karakter." });
      return;
    }
    const validViews = ["kanban", "table", "todo"];
    if (defaultView && !validViews.includes(defaultView)) {
      res.status(400).json({ error: "defaultView harus salah satu dari: kanban, table, todo." });
      return;
    }

    const now = new Date();
    const [board] = await db
      .insert(workboardBoardsTable)
      .values({
        ownerUserId,
        createdByUserId: uid,
        name: name.trim(),
        description: description?.trim() ?? null,
        defaultView: defaultView ?? "kanban",
        color: color ?? "#6366f1",
        emoji: emoji ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Default columns
    const defaultCols = [
      { name: "To Do", color: "#94a3b8", position: 0 },
      { name: "In Progress", color: "#3b82f6", position: 1 },
      { name: "Done", color: "#22c55e", position: 2 },
    ];
    const columns = await db
      .insert(workboardColumnsTable)
      .values(defaultCols.map((c) => ({ boardId: board.id, ...c, createdAt: now, updatedAt: now })))
      .returning();

    // Creator as owner member
    const [member] = await db
      .insert(workboardBoardMembersTable)
      .values({
        boardId: board.id,
        userId: uid,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    res.status(201).json({ board, columns, members: [member] });
  }
);

router.get(
  "/boards/:boardId",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const [board, columns, members, tasks] = await Promise.all([
      db.query.workboardBoardsTable.findFirst({ where: eq(workboardBoardsTable.id, boardId) }),
      db
        .select()
        .from(workboardColumnsTable)
        .where(eq(workboardColumnsTable.boardId, boardId))
        .orderBy(asc(workboardColumnsTable.position)),
      db
        .select({
          id: workboardBoardMembersTable.id,
          boardId: workboardBoardMembersTable.boardId,
          userId: workboardBoardMembersTable.userId,
          role: workboardBoardMembersTable.role,
          invitedByUserId: workboardBoardMembersTable.invitedByUserId,
          createdAt: workboardBoardMembersTable.createdAt,
          updatedAt: workboardBoardMembersTable.updatedAt,
          name: usersTable.name,
          email: usersTable.email,
        })
        .from(workboardBoardMembersTable)
        .leftJoin(usersTable, eq(workboardBoardMembersTable.userId, usersTable.id))
        .where(eq(workboardBoardMembersTable.boardId, boardId)),
      db
        .select()
        .from(workboardTasksTable)
        .where(eq(workboardTasksTable.boardId, boardId))
        .orderBy(asc(workboardTasksTable.columnId), asc(workboardTasksTable.position)),
    ]);

    if (!board) {
      res.status(404).json({ error: "Board tidak ditemukan." });
      return;
    }

    const taskIds = tasks.map((t) => t.id);
    const assignees = await getTaskAssignees(taskIds);
    const assigneeMap: Record<number, Array<{ userId: number; name: string | null; email: string | null }>> = {};
    for (const a of assignees) {
      if (!assigneeMap[a.taskId]) assigneeMap[a.taskId] = [];
      assigneeMap[a.taskId].push({ userId: a.userId, name: a.name, email: a.email });
    }

    const tasksWithAssignees = tasks.map((t) => ({ ...t, assignees: assigneeMap[t.id] ?? [] }));

    res.json({ board, columns, members, tasks: tasksWithAssignees, myRole: member.role });
  }
);

router.put(
  "/boards/:boardId",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "owner", res);
    if (!member) return;

    const { name, description, defaultView, color, emoji, isArchived } = req.body as {
      name?: string;
      description?: string;
      defaultView?: string;
      color?: string;
      emoji?: string;
      isArchived?: boolean;
    };

    if (name !== undefined) {
      if (typeof name !== "string" || name.trim().length === 0) {
        res.status(400).json({ error: "Nama board wajib diisi." });
        return;
      }
      if (name.trim().length > 100) {
        res.status(400).json({ error: "Nama board maksimal 100 karakter." });
        return;
      }
    }
    const validViews = ["kanban", "table", "todo"];
    if (defaultView && !validViews.includes(defaultView)) {
      res.status(400).json({ error: "defaultView harus salah satu dari: kanban, table, todo." });
      return;
    }

    const [existing] = await db
      .select()
      .from(workboardBoardsTable)
      .where(eq(workboardBoardsTable.id, boardId))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Board tidak ditemukan." });
      return;
    }

    const [updated] = await db
      .update(workboardBoardsTable)
      .set({
        name: name !== undefined ? name.trim() : existing.name,
        description: description !== undefined ? description?.trim() ?? null : existing.description,
        defaultView: defaultView ?? existing.defaultView,
        color: color ?? existing.color,
        emoji: emoji !== undefined ? emoji ?? null : existing.emoji,
        isArchived: isArchived !== undefined ? isArchived : existing.isArchived,
        updatedAt: new Date(),
      })
      .where(eq(workboardBoardsTable.id, boardId))
      .returning();

    res.json({ board: updated });
  }
);

router.delete(
  "/boards/:boardId",
  requirePermission("workboard", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "owner", res);
    if (!member) return;

    await db.delete(workboardBoardsTable).where(eq(workboardBoardsTable.id, boardId));
    res.json({ ok: true });
  }
);

// ─── BOARD MEMBERS ────────────────────────────────────────────────────────────

router.get(
  "/boards/:boardId/members",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const members = await db
      .select({
        id: workboardBoardMembersTable.id,
        boardId: workboardBoardMembersTable.boardId,
        userId: workboardBoardMembersTable.userId,
        role: workboardBoardMembersTable.role,
        invitedByUserId: workboardBoardMembersTable.invitedByUserId,
        createdAt: workboardBoardMembersTable.createdAt,
        updatedAt: workboardBoardMembersTable.updatedAt,
        name: usersTable.name,
        email: usersTable.email,
      })
      .from(workboardBoardMembersTable)
      .leftJoin(usersTable, eq(workboardBoardMembersTable.userId, usersTable.id))
      .where(eq(workboardBoardMembersTable.boardId, boardId));

    res.json({ members });
  }
);

router.get(
  "/boards/:boardId/invitable-users",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "owner", res);
    if (!member) return;

    // All members already in the board
    const existingMembers = await db
      .select({ userId: workboardBoardMembersTable.userId })
      .from(workboardBoardMembersTable)
      .where(eq(workboardBoardMembersTable.boardId, boardId));

    const existingIds = existingMembers.map((m) => m.userId);

    // All users in tenant (owner + sub-users)
    const tenantUsers = await db
      .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.parentUserId, ownerUserId),
          existingIds.length > 0 ? not(inArray(usersTable.id, existingIds)) : sql`true`
        )
      );

    // Include owner if not already a member
    const ownerAlreadyMember = existingIds.includes(ownerUserId);
    const result = [...tenantUsers];
    if (!ownerAlreadyMember) {
      const [ownerUser] = await db
        .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
        .from(usersTable)
        .where(eq(usersTable.id, ownerUserId))
        .limit(1);
      if (ownerUser) result.unshift(ownerUser);
    }

    res.json({ users: result });
  }
);

router.post(
  "/boards/:boardId/members",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "owner", res);
    if (!member) return;

    const { userId, role } = req.body as { userId?: number; role?: string };
    if (!userId || !Number.isInteger(userId)) {
      res.status(400).json({ error: "userId wajib diisi." });
      return;
    }
    if (!role || !["editor", "viewer"].includes(role)) {
      res.status(400).json({ error: "role harus 'editor' atau 'viewer'." });
      return;
    }

    // Validate user is in the same tenant
    const [targetUser] = await db
      .select({ id: usersTable.id, parentUserId: usersTable.parentUserId })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    const validTenant =
      targetUser &&
      (targetUser.id === ownerUserId ||
        targetUser.parentUserId === ownerUserId);

    if (!validTenant) {
      res.status(400).json({ error: "User tidak ditemukan dalam tenant yang sama." });
      return;
    }

    // Check duplicate
    const existing = await getBoardMember(boardId, userId);
    if (existing) {
      res.status(409).json({ error: "User sudah menjadi member board ini." });
      return;
    }

    const now = new Date();
    const [newMember] = await db
      .insert(workboardBoardMembersTable)
      .values({ boardId, userId, role, invitedByUserId: uid, createdAt: now, updatedAt: now })
      .returning();

    res.status(201).json({ member: newMember });
  }
);

router.put(
  "/boards/:boardId/members/:memberId",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const memberId = Number(req.params.memberId);
    if (!Number.isInteger(boardId) || !Number.isInteger(memberId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const currentMember = await requireBoardAccess(boardId, uid, "owner", res);
    if (!currentMember) return;
    const ownerUserId = await resolveOwnerUserId(uid);

    const { role } = req.body as { role?: string };
    // The board owner is always the tenant owner (super_admin), permanent — the
    // "owner" role can never be granted via update (spec #4/§6.2c).
    if (!role || !["editor", "viewer"].includes(role)) {
      res.status(400).json({ error: "role harus 'editor' atau 'viewer'." });
      return;
    }

    const [target] = await db
      .select()
      .from(workboardBoardMembersTable)
      .where(
        and(
          eq(workboardBoardMembersTable.id, memberId),
          eq(workboardBoardMembersTable.boardId, boardId)
        )
      )
      .limit(1);

    if (!target) {
      res.status(404).json({ error: "Member tidak ditemukan." });
      return;
    }

    // The tenant owner's own board role is permanent (spec §6.2d).
    if (target.userId === ownerUserId) {
      res.status(400).json({ error: "Owner tenant tidak dapat diubah perannya di board." });
      return;
    }

    const [updated] = await db
      .update(workboardBoardMembersTable)
      .set({ role, updatedAt: new Date() })
      .where(eq(workboardBoardMembersTable.id, memberId))
      .returning();

    res.json({ member: updated });
  }
);

router.delete(
  "/boards/:boardId/members/:memberId",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const memberId = Number(req.params.memberId);
    if (!Number.isInteger(boardId) || !Number.isInteger(memberId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const currentMember = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!currentMember) return;
    const ownerUserId = await resolveOwnerUserId(uid);

    const [target] = await db
      .select()
      .from(workboardBoardMembersTable)
      .where(
        and(
          eq(workboardBoardMembersTable.id, memberId),
          eq(workboardBoardMembersTable.boardId, boardId)
        )
      )
      .limit(1);

    if (!target) {
      res.status(404).json({ error: "Member tidak ditemukan." });
      return;
    }

    // Only owner can remove others, any member can remove themselves
    const isSelf = target.userId === uid;
    if (!isSelf && currentMember.role !== "owner") {
      res.status(403).json({ error: "Hanya owner yang bisa menghapus member lain." });
      return;
    }

    // The tenant owner (permanent board owner) can never be removed (spec §6.2d).
    if (target.userId === ownerUserId) {
      res.status(400).json({ error: "Owner tenant tidak dapat dikeluarkan dari board." });
      return;
    }

    // Remove membership AND clean up the user's footprint on this board in one
    // transaction (spec §6.3): drop their task assignments (no ghost assignees)
    // and their mention-join rows (so they stop counting in notifications). The
    // comment BODIES are kept — they're discussion history; the dropped mention
    // just renders as a fallback name on the client.
    await db.transaction(async (tx) => {
      await tx
        .delete(workboardBoardMembersTable)
        .where(eq(workboardBoardMembersTable.id, memberId));

      await tx.delete(workboardTaskAssigneesTable).where(
        and(
          eq(workboardTaskAssigneesTable.userId, target.userId),
          inArray(
            workboardTaskAssigneesTable.taskId,
            tx
              .select({ id: workboardTasksTable.id })
              .from(workboardTasksTable)
              .where(eq(workboardTasksTable.boardId, boardId))
          )
        )
      );

      await tx.delete(workboardCommentMentionsTable).where(
        and(
          eq(workboardCommentMentionsTable.mentionedUserId, target.userId),
          inArray(
            workboardCommentMentionsTable.commentId,
            tx
              .select({ id: workboardTaskCommentsTable.id })
              .from(workboardTaskCommentsTable)
              .where(eq(workboardTaskCommentsTable.boardId, boardId))
          )
        )
      );
    });

    res.json({ ok: true });
  }
);

// ─── COLUMNS ─────────────────────────────────────────────────────────────────

router.get(
  "/boards/:boardId/columns",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const columns = await db
      .select()
      .from(workboardColumnsTable)
      .where(eq(workboardColumnsTable.boardId, boardId))
      .orderBy(asc(workboardColumnsTable.position));

    res.json({ columns });
  }
);

router.post(
  "/boards/:boardId/columns",
  // Column creation is in-board WORK, gated by board-role editor — NOT the
  // workboard "create" menu flag (which now gates only board creation, owner
  // only). So editors/owners keep creating columns even without canCreate.
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const { name, color } = req.body as { name?: string; color?: string };
    if (!name || typeof name !== "string" || name.trim().length === 0) {
      res.status(400).json({ error: "Nama kolom wajib diisi." });
      return;
    }

    const [maxPos] = await db
      .select({ maxPos: sql<number>`coalesce(max(position), -1)::int` })
      .from(workboardColumnsTable)
      .where(eq(workboardColumnsTable.boardId, boardId));

    const now = new Date();
    const [column] = await db
      .insert(workboardColumnsTable)
      .values({
        boardId,
        name: name.trim(),
        color: color ?? "#94a3b8",
        position: (maxPos?.maxPos ?? -1) + 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    res.status(201).json({ column });
  }
);

router.put(
  "/boards/:boardId/columns/:columnId",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const columnId = Number(req.params.columnId);
    if (!Number.isInteger(boardId) || !Number.isInteger(columnId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const [existing] = await db
      .select()
      .from(workboardColumnsTable)
      .where(
        and(eq(workboardColumnsTable.id, columnId), eq(workboardColumnsTable.boardId, boardId))
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Kolom tidak ditemukan." });
      return;
    }

    const { name, color, position } = req.body as {
      name?: string;
      color?: string;
      position?: number;
    };

    const [updated] = await db
      .update(workboardColumnsTable)
      .set({
        name: name !== undefined ? name.trim() : existing.name,
        color: color ?? existing.color,
        position: position !== undefined ? position : existing.position,
        updatedAt: new Date(),
      })
      .where(eq(workboardColumnsTable.id, columnId))
      .returning();

    res.json({ column: updated });
  }
);

router.delete(
  "/boards/:boardId/columns/:columnId",
  requirePermission("workboard", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const columnId = Number(req.params.columnId);
    if (!Number.isInteger(boardId) || !Number.isInteger(columnId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    // Check min 1 column
    const [colCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workboardColumnsTable)
      .where(eq(workboardColumnsTable.boardId, boardId));

    if ((colCount?.count ?? 0) <= 1) {
      res.status(400).json({ error: "Board harus memiliki minimal 1 kolom." });
      return;
    }

    // Move tasks to null (uncategorized)
    await db
      .update(workboardTasksTable)
      .set({ columnId: null, updatedAt: new Date() })
      .where(eq(workboardTasksTable.columnId, columnId));

    await db
      .delete(workboardColumnsTable)
      .where(
        and(eq(workboardColumnsTable.id, columnId), eq(workboardColumnsTable.boardId, boardId))
      );

    res.json({ ok: true });
  }
);

// ─── TASKS ────────────────────────────────────────────────────────────────────

router.get(
  "/boards/:boardId/tasks",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const { columnId, priority, assigneeId, search, completed } = req.query as Record<string, string>;

    let tasks = await db
      .select()
      .from(workboardTasksTable)
      .where(eq(workboardTasksTable.boardId, boardId))
      .orderBy(asc(workboardTasksTable.columnId), asc(workboardTasksTable.position));

    // Client-side filters (simple approach for the data volumes expected)
    if (columnId) tasks = tasks.filter((t) => t.columnId === Number(columnId));
    if (priority) tasks = tasks.filter((t) => t.priority === priority);
    if (completed !== undefined) tasks = tasks.filter((t) => t.isCompleted === (completed === "true"));
    if (search) tasks = tasks.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));

    const taskIds = tasks.map((t) => t.id);
    let assignees = await getTaskAssignees(taskIds);

    if (assigneeId) {
      const aId = Number(assigneeId);
      const taskIdsWithAssignee = new Set(
        assignees.filter((a) => a.userId === aId).map((a) => a.taskId)
      );
      tasks = tasks.filter((t) => taskIdsWithAssignee.has(t.id));
    }

    const assigneeMap: Record<number, Array<{ userId: number; name: string | null; email: string | null }>> = {};
    for (const a of assignees) {
      if (!assigneeMap[a.taskId]) assigneeMap[a.taskId] = [];
      assigneeMap[a.taskId].push({ userId: a.userId, name: a.name, email: a.email });
    }

    res.json({
      tasks: tasks.map((t) => ({ ...t, assignees: assigneeMap[t.id] ?? [] })),
    });
  }
);

router.post(
  "/boards/:boardId/tasks",
  // Task creation is in-board WORK (like columns), gated by board-role editor —
  // NOT the workboard "create" menu flag (board creation only, owner only).
  // Without this, agents/editors who lost canCreate could no longer add tasks.
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const { title, description, columnId, priority, dueDate, tags, assigneeIds } =
      req.body as {
        title?: string;
        description?: string;
        columnId?: number;
        priority?: string;
        dueDate?: string;
        tags?: string;
        assigneeIds?: number[];
      };

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      res.status(400).json({ error: "Judul task wajib diisi." });
      return;
    }

    const validPriorities = ["low", "medium", "high"];
    if (priority && !validPriorities.includes(priority)) {
      res.status(400).json({ error: "priority harus low, medium, atau high." });
      return;
    }

    // Validate assignees are board members
    if (assigneeIds && assigneeIds.length > 0) {
      const memberRows = await db
        .select({ userId: workboardBoardMembersTable.userId })
        .from(workboardBoardMembersTable)
        .where(
          and(
            eq(workboardBoardMembersTable.boardId, boardId),
            inArray(workboardBoardMembersTable.userId, assigneeIds)
          )
        );
      if (memberRows.length !== assigneeIds.length) {
        res.status(400).json({ error: "Beberapa assignee bukan member board ini." });
        return;
      }
    }

    const [maxPos] = await db
      .select({ maxPos: sql<number>`coalesce(max(position), -1)::int` })
      .from(workboardTasksTable)
      .where(
        and(
          eq(workboardTasksTable.boardId, boardId),
          columnId ? eq(workboardTasksTable.columnId, columnId) : sql`column_id IS NULL`
        )
      );

    const now = new Date();
    const [task] = await db
      .insert(workboardTasksTable)
      .values({
        boardId,
        columnId: columnId ?? null,
        title: title.trim(),
        description: description?.trim() ?? null,
        priority: priority ?? "medium",
        position: (maxPos?.maxPos ?? -1) + 1,
        dueDate: dueDate ? new Date(dueDate) : null,
        tags: tags ?? null,
        isCompleted: false,
        createdByUserId: uid,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (assigneeIds && assigneeIds.length > 0) {
      await db.insert(workboardTaskAssigneesTable).values(
        assigneeIds.map((userId) => ({ taskId: task.id, userId, createdAt: now }))
      );
    }

    const assignees = await getTaskAssignees([task.id]);
    res.status(201).json({
      task: {
        ...task,
        assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, email: a.email })),
      },
    });
  }
);

router.get(
  "/boards/:boardId/tasks/:taskId",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const [task] = await db
      .select()
      .from(workboardTasksTable)
      .where(
        and(eq(workboardTasksTable.id, taskId), eq(workboardTasksTable.boardId, boardId))
      )
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task tidak ditemukan." });
      return;
    }

    const assignees = await getTaskAssignees([taskId]);
    res.json({
      task: {
        ...task,
        assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, email: a.email })),
      },
    });
  }
);

router.put(
  "/boards/:boardId/tasks/:taskId",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const [existing] = await db
      .select()
      .from(workboardTasksTable)
      .where(
        and(eq(workboardTasksTable.id, taskId), eq(workboardTasksTable.boardId, boardId))
      )
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Task tidak ditemukan." });
      return;
    }

    const { title, description, columnId, priority, dueDate, tags, isCompleted, assigneeIds } =
      req.body as {
        title?: string;
        description?: string;
        columnId?: number | null;
        priority?: string;
        dueDate?: string | null;
        tags?: string | null;
        isCompleted?: boolean;
        assigneeIds?: number[];
      };

    if (title !== undefined) {
      if (typeof title !== "string" || title.trim().length === 0) {
        res.status(400).json({ error: "Judul task tidak boleh kosong." });
        return;
      }
    }

    if (priority && !["low", "medium", "high"].includes(priority)) {
      res.status(400).json({ error: "priority harus low, medium, atau high." });
      return;
    }

    // Validate assignees
    if (assigneeIds !== undefined && assigneeIds.length > 0) {
      const memberRows = await db
        .select({ userId: workboardBoardMembersTable.userId })
        .from(workboardBoardMembersTable)
        .where(
          and(
            eq(workboardBoardMembersTable.boardId, boardId),
            inArray(workboardBoardMembersTable.userId, assigneeIds)
          )
        );
      if (memberRows.length !== assigneeIds.length) {
        res.status(400).json({ error: "Beberapa assignee bukan member board ini." });
        return;
      }
    }

    const [updated] = await db
      .update(workboardTasksTable)
      .set({
        title: title !== undefined ? title.trim() : existing.title,
        description: description !== undefined ? description?.trim() ?? null : existing.description,
        columnId: columnId !== undefined ? columnId : existing.columnId,
        priority: priority ?? existing.priority,
        dueDate: dueDate !== undefined ? (dueDate ? new Date(dueDate) : null) : existing.dueDate,
        tags: tags !== undefined ? tags : existing.tags,
        isCompleted: isCompleted !== undefined ? isCompleted : existing.isCompleted,
        updatedAt: new Date(),
      })
      .where(eq(workboardTasksTable.id, taskId))
      .returning();

    if (assigneeIds !== undefined) {
      await db
        .delete(workboardTaskAssigneesTable)
        .where(eq(workboardTaskAssigneesTable.taskId, taskId));
      if (assigneeIds.length > 0) {
        await db.insert(workboardTaskAssigneesTable).values(
          assigneeIds.map((userId) => ({ taskId, userId, createdAt: new Date() }))
        );
      }
    }

    const assignees = await getTaskAssignees([taskId]);
    res.json({
      task: {
        ...updated,
        assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, email: a.email })),
      },
    });
  }
);

router.patch(
  "/boards/:boardId/tasks/:taskId/move",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const { columnId, position } = req.body as { columnId?: number | null; position?: number };

    const [task] = await db
      .select()
      .from(workboardTasksTable)
      .where(
        and(eq(workboardTasksTable.id, taskId), eq(workboardTasksTable.boardId, boardId))
      )
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task tidak ditemukan." });
      return;
    }

    const targetColumn = columnId !== undefined ? columnId : task.columnId;
    const targetPosition = position !== undefined ? position : task.position;

    const [updated] = await db
      .update(workboardTasksTable)
      .set({ columnId: targetColumn, position: targetPosition, updatedAt: new Date() })
      .where(eq(workboardTasksTable.id, taskId))
      .returning();

    res.json({ task: updated });
  }
);

router.patch(
  "/boards/:boardId/tasks/:taskId/complete",
  requirePermission("workboard", "edit"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const { isCompleted } = req.body as { isCompleted?: boolean };
    if (typeof isCompleted !== "boolean") {
      res.status(400).json({ error: "isCompleted harus boolean." });
      return;
    }

    const [task] = await db
      .select()
      .from(workboardTasksTable)
      .where(
        and(eq(workboardTasksTable.id, taskId), eq(workboardTasksTable.boardId, boardId))
      )
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task tidak ditemukan." });
      return;
    }

    const [updated] = await db
      .update(workboardTasksTable)
      .set({ isCompleted, updatedAt: new Date() })
      .where(eq(workboardTasksTable.id, taskId))
      .returning();

    res.json({ task: updated });
  }
);

router.delete(
  "/boards/:boardId/tasks/:taskId",
  requirePermission("workboard", "delete"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    const member = await requireBoardAccess(boardId, uid, "editor", res);
    if (!member) return;

    const [task] = await db
      .select()
      .from(workboardTasksTable)
      .where(
        and(eq(workboardTasksTable.id, taskId), eq(workboardTasksTable.boardId, boardId))
      )
      .limit(1);

    if (!task) {
      res.status(404).json({ error: "Task tidak ditemukan." });
      return;
    }

    await db.delete(workboardTasksTable).where(eq(workboardTasksTable.id, taskId));
    res.json({ ok: true });
  }
);

// ─── COMMENTS + @MENTIONS ────────────────────────────────────────────────────
// Comment access is gated by BOARD MEMBERSHIP (requireBoardAccess "viewer"), NOT
// the menu-CRUD flags. Decision #6: viewers may comment + mention; what they may
// not do is mutate tasks/columns/board. Mention candidates + delivery are
// restricted to board members on the SERVER (frontend is never trusted).

// Ensure a task belongs to a board (blocks cross-board access). Returns the task
// row (id + title) or null after writing the 404.
async function requireTaskInBoard(
  boardId: number,
  taskId: number,
  res: Response
): Promise<{ id: number; title: string } | null> {
  const [task] = await db
    .select({ id: workboardTasksTable.id, title: workboardTasksTable.title })
    .from(workboardTasksTable)
    .where(and(eq(workboardTasksTable.id, taskId), eq(workboardTasksTable.boardId, boardId)))
    .limit(1);
  if (!task) {
    res.status(404).json({ error: "Task tidak ditemukan di board ini." });
    return null;
  }
  return task;
}

router.get(
  "/boards/:boardId/tasks/:taskId/comments",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }
    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;
    if (!(await requireTaskInBoard(boardId, taskId, res))) return;

    const comments = await db
      .select({
        id: workboardTaskCommentsTable.id,
        taskId: workboardTaskCommentsTable.taskId,
        body: workboardTaskCommentsTable.body,
        mentionedUserIds: workboardTaskCommentsTable.mentionedUserIds,
        authorUserId: workboardTaskCommentsTable.authorUserId,
        authorName: usersTable.name,
        authorEmail: usersTable.email,
        createdAt: workboardTaskCommentsTable.createdAt,
      })
      .from(workboardTaskCommentsTable)
      .leftJoin(usersTable, eq(workboardTaskCommentsTable.authorUserId, usersTable.id))
      .where(eq(workboardTaskCommentsTable.taskId, taskId))
      .orderBy(asc(workboardTaskCommentsTable.createdAt));

    res.json({ comments });
  }
);

router.post(
  "/boards/:boardId/tasks/:taskId/comments",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(boardId) || !Number.isInteger(taskId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }
    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const { body } = req.body as { body?: string };
    if (!body || typeof body !== "string" || body.trim().length === 0) {
      res.status(400).json({ error: "Komentar tidak boleh kosong." });
      return;
    }
    if (body.length > 4000) {
      res.status(400).json({ error: "Komentar maksimal 4000 karakter." });
      return;
    }

    const task = await requireTaskInBoard(boardId, taskId, res);
    if (!task) return;

    // Parse mention tokens, then FILTER to board members (server is authority —
    // a hand-typed @[id] for a non-member is dropped silently, enforcing #5).
    const rawIds = parseMentionIds(body);
    let validMentionIds: number[] = [];
    if (rawIds.length > 0) {
      const memberRows = await db
        .select({ userId: workboardBoardMembersTable.userId })
        .from(workboardBoardMembersTable)
        .where(
          and(
            eq(workboardBoardMembersTable.boardId, boardId),
            inArray(workboardBoardMembersTable.userId, rawIds)
          )
        );
      const memberSet = new Set(memberRows.map((r) => r.userId));
      validMentionIds = rawIds.filter((id) => memberSet.has(id));
    }

    const now = new Date();
    const comment = await db.transaction(async (tx) => {
      const [c] = await tx
        .insert(workboardTaskCommentsTable)
        .values({
          taskId,
          boardId,
          authorUserId: uid,
          body: body.trim(),
          mentionedUserIds: validMentionIds,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (validMentionIds.length > 0) {
        await tx.insert(workboardCommentMentionsTable).values(
          validMentionIds.map((mid) => ({
            commentId: c.id,
            mentionedUserId: mid,
            createdAt: now,
          }))
        );
      }
      return c;
    });

    // Notify mentioned users (exclude self) — best-effort, never blocks response.
    const notifyIds = validMentionIds.filter((id) => id !== uid);
    if (notifyIds.length > 0) {
      try {
        await notifyWorkboardMentions({
          mentionedUserIds: notifyIds,
          boardId,
          taskId,
          taskTitle: task.title,
          commentId: comment.id,
          authorUserId: uid,
        });
      } catch (err) {
        req.log?.error?.({ err }, "workboard mention notify failed");
      }
    }

    const [author] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, uid))
      .limit(1);

    res.status(201).json({
      comment: {
        id: comment.id,
        taskId,
        body: comment.body,
        mentionedUserIds: validMentionIds,
        authorUserId: uid,
        authorName: author?.name ?? null,
        authorEmail: author?.email ?? null,
        createdAt: comment.createdAt,
      },
    });
  }
);

router.delete(
  "/boards/:boardId/tasks/:taskId/comments/:commentId",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    const taskId = Number(req.params.taskId);
    const commentId = Number(req.params.commentId);
    if (
      !Number.isInteger(boardId) ||
      !Number.isInteger(taskId) ||
      !Number.isInteger(commentId)
    ) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }
    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const [comment] = await db
      .select({
        id: workboardTaskCommentsTable.id,
        authorUserId: workboardTaskCommentsTable.authorUserId,
      })
      .from(workboardTaskCommentsTable)
      .where(
        and(
          eq(workboardTaskCommentsTable.id, commentId),
          eq(workboardTaskCommentsTable.taskId, taskId),
          eq(workboardTaskCommentsTable.boardId, boardId)
        )
      )
      .limit(1);
    if (!comment) {
      res.status(404).json({ error: "Komentar tidak ditemukan." });
      return;
    }

    // Only the comment's author OR the board owner may delete it.
    if (comment.authorUserId !== uid && member.role !== "owner") {
      res.status(403).json({ error: "Tidak boleh menghapus komentar ini." });
      return;
    }

    // ON DELETE CASCADE removes mentions + notifications for this comment.
    await db
      .delete(workboardTaskCommentsTable)
      .where(eq(workboardTaskCommentsTable.id, commentId));
    res.json({ ok: true });
  }
);

router.get(
  "/boards/:boardId/mention-candidates",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const boardId = Number(req.params.boardId);
    if (!Number.isInteger(boardId)) {
      res.status(400).json({ error: "boardId tidak valid." });
      return;
    }
    const member = await requireBoardAccess(boardId, uid, "viewer", res);
    if (!member) return;

    const rows = await db
      .select({
        userId: workboardBoardMembersTable.userId,
        name: usersTable.name,
        email: usersTable.email,
        role: workboardBoardMembersTable.role,
      })
      .from(workboardBoardMembersTable)
      .leftJoin(usersTable, eq(workboardBoardMembersTable.userId, usersTable.id))
      .where(eq(workboardBoardMembersTable.boardId, boardId));

    res.json({ candidates: rows });
  }
);

// ─── NOTIFICATIONS (bell) ────────────────────────────────────────────────────
// Scoped to the signed-in user as RECIPIENT. Menu gating is workboard:view.

router.get(
  "/notifications",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const unreadOnly = req.query.unreadOnly === "true";

    const rows = await db
      .select({
        id: workboardNotificationsTable.id,
        boardId: workboardNotificationsTable.boardId,
        taskId: workboardNotificationsTable.taskId,
        commentId: workboardNotificationsTable.commentId,
        type: workboardNotificationsTable.type,
        isRead: workboardNotificationsTable.isRead,
        createdAt: workboardNotificationsTable.createdAt,
        actorUserId: workboardNotificationsTable.actorUserId,
        actorName: usersTable.name,
        actorEmail: usersTable.email,
        taskTitle: workboardTasksTable.title,
        boardName: workboardBoardsTable.name,
      })
      .from(workboardNotificationsTable)
      .leftJoin(usersTable, eq(workboardNotificationsTable.actorUserId, usersTable.id))
      .leftJoin(workboardTasksTable, eq(workboardNotificationsTable.taskId, workboardTasksTable.id))
      .leftJoin(workboardBoardsTable, eq(workboardNotificationsTable.boardId, workboardBoardsTable.id))
      .where(
        unreadOnly
          ? and(
              eq(workboardNotificationsTable.recipientUserId, uid),
              eq(workboardNotificationsTable.isRead, false)
            )
          : eq(workboardNotificationsTable.recipientUserId, uid)
      )
      .orderBy(desc(workboardNotificationsTable.createdAt))
      .limit(100);

    const [unread] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workboardNotificationsTable)
      .where(
        and(
          eq(workboardNotificationsTable.recipientUserId, uid),
          eq(workboardNotificationsTable.isRead, false)
        )
      );

    res.json({ notifications: rows, unreadCount: unread?.count ?? 0 });
  }
);

router.patch(
  "/notifications/read-all",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    await db
      .update(workboardNotificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(workboardNotificationsTable.recipientUserId, uid),
          eq(workboardNotificationsTable.isRead, false)
        )
      );
    res.json({ ok: true });
  }
);

router.patch(
  "/notifications/:notifId/read",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const notifId = Number(req.params.notifId);
    if (!Number.isInteger(notifId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }
    const [updated] = await db
      .update(workboardNotificationsTable)
      .set({ isRead: true, readAt: new Date() })
      .where(
        and(
          eq(workboardNotificationsTable.id, notifId),
          eq(workboardNotificationsTable.recipientUserId, uid)
        )
      )
      .returning({ id: workboardNotificationsTable.id });
    if (!updated) {
      res.status(404).json({ error: "Notifikasi tidak ditemukan." });
      return;
    }
    res.json({ ok: true });
  }
);

export default router;
