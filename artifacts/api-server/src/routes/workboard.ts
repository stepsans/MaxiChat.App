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
  workboardTaskEventsTable,
  usersTable,
  chatsTable,
  channelsTable,
  type WorkboardBoardMemberRow,
} from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { startOfWibDay } from "../lib/timezone";
import { requirePermission } from "../lib/role-permissions";
import { parseMentionIds } from "../lib/workboard-mentions";
import { notifyWorkboardMentions } from "../lib/workboard-notify";
import { recordTaskEvent } from "../lib/workboard-events";
import { deriveIsCompleted } from "../lib/workboard-finish";

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
      profilePhotoUrl: usersTable.profilePhotoUrl,
    })
    .from(workboardTaskAssigneesTable)
    .leftJoin(usersTable, eq(workboardTaskAssigneesTable.userId, usersTable.id))
    .where(inArray(workboardTaskAssigneesTable.taskId, taskIds));
}

// ─── MY TASKS (dashboard) ─────────────────────────────────────────────────────
// GET /workboard/my-tasks — tasks assigned to OR @mentioning the current user,
// scoped to their tenant. Feeds the mobile dashboard "Tugas WorkBoard" section
// (and the agent dashboard). Gated workboard.view (agents have it by default).
router.get(
  "/my-tasks",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await getEffectiveOwnerUserId(uid);

    const taskCols = {
      taskId: workboardTasksTable.id,
      boardId: workboardTasksTable.boardId,
      boardName: workboardBoardsTable.name,
      boardEmoji: workboardBoardsTable.emoji,
      boardColor: workboardBoardsTable.color,
      columnId: workboardTasksTable.columnId,
      title: workboardTasksTable.title,
      dueDate: workboardTasksTable.dueDate,
      priority: workboardTasksTable.priority,
      isCompleted: workboardTasksTable.isCompleted,
    };

    // Assigned to me, still open, within my tenant. Soonest due first.
    const assignedRows = await db
      .select(taskCols)
      .from(workboardTaskAssigneesTable)
      .innerJoin(
        workboardTasksTable,
        eq(workboardTasksTable.id, workboardTaskAssigneesTable.taskId)
      )
      .innerJoin(
        workboardBoardsTable,
        eq(workboardBoardsTable.id, workboardTasksTable.boardId)
      )
      .where(
        and(
          eq(workboardTaskAssigneesTable.userId, uid),
          eq(workboardBoardsTable.ownerUserId, ownerUserId),
          eq(workboardTasksTable.isCompleted, false)
        )
      )
      .orderBy(asc(workboardTasksTable.dueDate), asc(workboardTasksTable.id))
      .limit(100);

    // Tasks where a comment @mentions me. May yield several rows per task; keep
    // the most recent mention per task (rows are newest-first).
    const mentionRows = await db
      .select({
        ...taskCols,
        commentId: workboardTaskCommentsTable.id,
        mentionedAt: workboardTaskCommentsTable.createdAt,
        mentionedBy: usersTable.name,
      })
      .from(workboardCommentMentionsTable)
      .innerJoin(
        workboardTaskCommentsTable,
        eq(workboardTaskCommentsTable.id, workboardCommentMentionsTable.commentId)
      )
      .innerJoin(
        workboardTasksTable,
        eq(workboardTasksTable.id, workboardTaskCommentsTable.taskId)
      )
      .innerJoin(
        workboardBoardsTable,
        eq(workboardBoardsTable.id, workboardTasksTable.boardId)
      )
      .leftJoin(usersTable, eq(usersTable.id, workboardTaskCommentsTable.authorUserId))
      .where(
        and(
          eq(workboardCommentMentionsTable.mentionedUserId, uid),
          eq(workboardBoardsTable.ownerUserId, ownerUserId)
        )
      )
      .orderBy(desc(workboardTaskCommentsTable.createdAt))
      .limit(200);

    const toTask = (r: typeof assignedRows[number]) => ({
      taskId: r.taskId,
      boardId: r.boardId,
      boardName: r.boardName,
      boardEmoji: r.boardEmoji,
      boardColor: r.boardColor,
      columnId: r.columnId,
      title: r.title,
      dueDate: r.dueDate ? r.dueDate.toISOString() : null,
      priority: r.priority,
      isCompleted: r.isCompleted,
    });

    const assigned = assignedRows.map(toTask);

    // Dedupe mentions to one (latest) per task.
    const seenMention = new Set<number>();
    const mentioned: Array<ReturnType<typeof toTask> & {
      commentId: number;
      mentionedAt: string;
      mentionedBy: string | null;
    }> = [];
    for (const r of mentionRows) {
      if (seenMention.has(r.taskId)) continue;
      seenMention.add(r.taskId);
      mentioned.push({
        ...toTask(r),
        commentId: r.commentId,
        mentionedAt: r.mentionedAt.toISOString(),
        mentionedBy: r.mentionedBy,
      });
    }

    const todayStart = startOfWibDay().getTime();
    const todayEnd = todayStart + 24 * 60 * 60 * 1000;
    const dueToday = assigned.filter((t) => {
      if (!t.dueDate) return false;
      const d = new Date(t.dueDate).getTime();
      return d >= todayStart && d < todayEnd;
    }).length;

    res.json({
      assigned,
      mentioned,
      counts: {
        active: assigned.length,
        dueToday,
        mentioned: mentioned.length,
      },
    });
  }
);

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
    // Table & Todo views were removed; Kanban is the only persisted view.
    const validViews = ["kanban"];
    if (defaultView && !validViews.includes(defaultView)) {
      res.status(400).json({ error: "defaultView hanya boleh: kanban." });
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
          profilePhotoUrl: usersTable.profilePhotoUrl,
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
    const assigneeMap: Record<number, Array<{ userId: number; name: string | null; email: string | null; profilePhotoUrl: string | null }>> = {};
    for (const a of assignees) {
      if (!assigneeMap[a.taskId]) assigneeMap[a.taskId] = [];
      assigneeMap[a.taskId].push({ userId: a.userId, name: a.name, email: a.email, profilePhotoUrl: a.profilePhotoUrl });
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
    // Table & Todo views were removed; Kanban is the only persisted view.
    const validViews = ["kanban"];
    if (defaultView && !validViews.includes(defaultView)) {
      res.status(400).json({ error: "defaultView hanya boleh: kanban." });
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
        profilePhotoUrl: usersTable.profilePhotoUrl,
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

    const { name, color, position, isFinishStage } = req.body as {
      name?: string;
      color?: string;
      position?: number;
      isFinishStage?: boolean;
    };

    // Finish-stage is board STRUCTURE — only the owner may change which columns
    // count as "done". name/color/position stay editor-level (existing behavior).
    const finishChanged =
      isFinishStage !== undefined && isFinishStage !== existing.isFinishStage;
    if (finishChanged && member.role !== "owner") {
      res.status(403).json({ error: "Hanya owner board yang dapat mengubah stage selesai." });
      return;
    }

    const [updated] = await db
      .update(workboardColumnsTable)
      .set({
        name: name !== undefined ? name.trim() : existing.name,
        color: color ?? existing.color,
        position: position !== undefined ? position : existing.position,
        isFinishStage: isFinishStage !== undefined ? isFinishStage : existing.isFinishStage,
        updatedAt: new Date(),
      })
      .where(eq(workboardColumnsTable.id, columnId))
      .returning();

    // When the finish-stage flag flips, re-derive isCompleted for EVERY task in
    // this column — otherwise tasks already sitting here keep a stale status.
    if (finishChanged) {
      await db
        .update(workboardTasksTable)
        .set({ isCompleted: isFinishStage, updatedAt: new Date() })
        .where(eq(workboardTasksTable.columnId, columnId));
    }

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

    const assigneeMap: Record<number, Array<{ userId: number; name: string | null; email: string | null; profilePhotoUrl: string | null }>> = {};
    for (const a of assignees) {
      if (!assigneeMap[a.taskId]) assigneeMap[a.taskId] = [];
      assigneeMap[a.taskId].push({ userId: a.userId, name: a.name, email: a.email, profilePhotoUrl: a.profilePhotoUrl });
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
    const ownerUserId = await resolveOwnerUserId(uid);

    const {
      title,
      description,
      columnId,
      priority,
      dueDate,
      tags,
      assigneeIds,
      // ── WorkBoard-from-chat (opsional) ──
      sourceType,
      sourceChatId,
    } = req.body as {
      title?: string;
      description?: string;
      columnId?: number;
      priority?: string;
      dueDate?: string;
      tags?: string;
      assigneeIds?: number[];
      sourceType?: string;
      sourceChatId?: number;
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

    // ── Resolusi source chat (WorkBoard-from-chat) ─────────────────────────
    // Hanya proses bila sourceType === 'chat' DAN sourceChatId valid. Snapshot
    // nama kontak + pesan terakhir diambil server-side (jangan percaya body),
    // dan chat WAJIB milik tenant (owner) yang sama dengan user — cegah
    // melampirkan chat lintas-tenant ke task.
    let resolvedSource: {
      sourceType: string;
      sourceChatId: number | null;
      sourceContactName: string | null;
      sourceLastMessage: string | null;
    } = {
      sourceType: "manual",
      sourceChatId: null,
      sourceContactName: null,
      sourceLastMessage: null,
    };

    if (sourceType === "chat" && Number.isInteger(sourceChatId)) {
      const [srcChat] = await db
        .select({
          id: chatsTable.id,
          contactName: chatsTable.contactName,
          nickname: chatsTable.nickname,
          lastMessage: chatsTable.lastMessage,
          channelId: chatsTable.channelId,
        })
        .from(chatsTable)
        .innerJoin(channelsTable, eq(channelsTable.id, chatsTable.channelId))
        .where(
          and(
            eq(chatsTable.id, sourceChatId as number),
            eq(channelsTable.userId, ownerUserId),
          ),
        )
        .limit(1);

      if (srcChat) {
        resolvedSource = {
          sourceType: "chat",
          sourceChatId: srcChat.id,
          sourceContactName: (srcChat.nickname?.trim() || srcChat.contactName) ?? null,
          sourceLastMessage: srcChat.lastMessage ?? null,
        };
      }
      // Bila chat tak ditemukan / bukan milik tenant → diam-diam fallback ke
      // 'manual' (task tetap dibuat, tanpa link). Jangan 400 — UX lebih baik.
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
        // ── source ──
        sourceType: resolvedSource.sourceType,
        sourceChatId: resolvedSource.sourceChatId,
        sourceContactName: resolvedSource.sourceContactName,
        sourceLastMessage: resolvedSource.sourceLastMessage,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (assigneeIds && assigneeIds.length > 0) {
      await db.insert(workboardTaskAssigneesTable).values(
        assigneeIds.map((userId) => ({ taskId: task.id, userId, createdAt: now }))
      );
    }

    await recordTaskEvent({
      boardId,
      taskId: task.id,
      eventType: "task_created",
      actorUserId: uid,
      payload: {
        columnId: task.columnId,
        dueDate: task.dueDate ? task.dueDate.toISOString() : null,
        priority: task.priority,
        assigneeIds: assigneeIds ?? [],
      },
    });

    const assignees = await getTaskAssignees([task.id]);
    res.status(201).json({
      task: {
        ...task,
        assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, email: a.email, profilePhotoUrl: a.profilePhotoUrl })),
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
        assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, email: a.email, profilePhotoUrl: a.profilePhotoUrl })),
      },
    });
  }
);

// Read-only task history timeline (§5). For verification + a future "task
// history" UI. KPI aggregation endpoints are intentionally NOT built here.
router.get(
  "/boards/:boardId/tasks/:taskId/events",
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

    const events = await db
      .select()
      .from(workboardTaskEventsTable)
      .where(
        and(
          eq(workboardTaskEventsTable.taskId, taskId),
          eq(workboardTaskEventsTable.boardId, boardId)
        )
      )
      .orderBy(asc(workboardTaskEventsTable.createdAt));
    res.json({ events });
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

    // isCompleted is DERIVED from the (effective) target column's finish-stage
    // flag — never taken from the request body (Model A). `isCompleted` in the
    // body is ignored intentionally.
    void isCompleted;
    const effectiveColumnId = columnId !== undefined ? columnId : existing.columnId;
    let targetIsFinish: boolean | null = null;
    if (effectiveColumnId !== null && effectiveColumnId !== undefined) {
      const [col] = await db
        .select({ isFinishStage: workboardColumnsTable.isFinishStage })
        .from(workboardColumnsTable)
        .where(eq(workboardColumnsTable.id, effectiveColumnId))
        .limit(1);
      targetIsFinish = col?.isFinishStage ?? null;
    }
    const derivedCompleted = deriveIsCompleted(targetIsFinish);

    const [updated] = await db
      .update(workboardTasksTable)
      .set({
        title: title !== undefined ? title.trim() : existing.title,
        description: description !== undefined ? description?.trim() ?? null : existing.description,
        columnId: columnId !== undefined ? columnId : existing.columnId,
        priority: priority ?? existing.priority,
        dueDate: dueDate !== undefined ? (dueDate ? new Date(dueDate) : null) : existing.dueDate,
        tags: tags !== undefined ? tags : existing.tags,
        isCompleted: derivedCompleted, // ← derived from column, not manual
        updatedAt: new Date(),
      })
      .where(eq(workboardTasksTable.id, taskId))
      .returning();

    // Capture the pre-update assignee set BEFORE the delete-and-reinsert so we
    // can diff it for assignee_added / assignee_removed events.
    let oldAssigneeIds: number[] = [];
    if (assigneeIds !== undefined) {
      const oldRows = await db
        .select({ userId: workboardTaskAssigneesTable.userId })
        .from(workboardTaskAssigneesTable)
        .where(eq(workboardTaskAssigneesTable.taskId, taskId));
      oldAssigneeIds = oldRows.map((r) => r.userId);
      await db
        .delete(workboardTaskAssigneesTable)
        .where(eq(workboardTaskAssigneesTable.taskId, taskId));
      if (assigneeIds.length > 0) {
        await db.insert(workboardTaskAssigneesTable).values(
          assigneeIds.map((userId) => ({ taskId, userId, createdAt: new Date() }))
        );
      }
    }

    // ── Best-effort history (§3.3). All after the main DB writes succeed. ──
    const oldDue = existing.dueDate ? existing.dueDate.toISOString() : null;
    const newDue = updated.dueDate ? updated.dueDate.toISOString() : null;
    if (dueDate !== undefined && oldDue !== newDue) {
      await recordTaskEvent({
        boardId,
        taskId,
        eventType: "due_date_changed",
        actorUserId: uid,
        payload: { from: oldDue, to: newDue },
      });
    }

    if (columnId !== undefined && columnId !== existing.columnId) {
      let fromIsFinish: boolean | null = null;
      if (existing.columnId !== null) {
        const [oldCol] = await db
          .select({ isFinishStage: workboardColumnsTable.isFinishStage })
          .from(workboardColumnsTable)
          .where(eq(workboardColumnsTable.id, existing.columnId))
          .limit(1);
        fromIsFinish = oldCol?.isFinishStage ?? null;
      }
      await recordTaskEvent({
        boardId,
        taskId,
        eventType: "task_moved",
        actorUserId: uid,
        payload: {
          fromColumnId: existing.columnId,
          toColumnId: updated.columnId,
          fromIsFinish: fromIsFinish === true,
          toIsFinish: targetIsFinish === true,
        },
      });
    }

    // Completion is derived: an edit that lands the task in/out of a finish
    // stage flips isCompleted, which we record as completed/reopened.
    if (updated.isCompleted !== existing.isCompleted) {
      if (updated.isCompleted) {
        await recordTaskEvent({
          boardId,
          taskId,
          eventType: "task_completed",
          actorUserId: uid,
          payload: { columnId: updated.columnId, dueDate: newDue },
        });
      } else {
        await recordTaskEvent({
          boardId,
          taskId,
          eventType: "task_reopened",
          actorUserId: uid,
          payload: { columnId: updated.columnId },
        });
      }
    }

    if (assigneeIds !== undefined) {
      const oldSet = new Set(oldAssigneeIds);
      const newSet = new Set(assigneeIds);
      for (const userId of assigneeIds) {
        if (!oldSet.has(userId)) {
          await recordTaskEvent({
            boardId,
            taskId,
            eventType: "assignee_added",
            actorUserId: uid,
            payload: { userId },
          });
        }
      }
      for (const userId of oldAssigneeIds) {
        if (!newSet.has(userId)) {
          await recordTaskEvent({
            boardId,
            taskId,
            eventType: "assignee_removed",
            actorUserId: uid,
            payload: { userId },
          });
        }
      }
    }

    const assignees = await getTaskAssignees([taskId]);
    res.json({
      task: {
        ...updated,
        assignees: assignees.map((a) => ({ userId: a.userId, name: a.name, email: a.email, profilePhotoUrl: a.profilePhotoUrl })),
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

    // Derive isCompleted from the destination column's finish-stage flag.
    let targetIsFinish: boolean | null = null;
    if (targetColumn !== null) {
      const [col] = await db
        .select({ isFinishStage: workboardColumnsTable.isFinishStage })
        .from(workboardColumnsTable)
        .where(eq(workboardColumnsTable.id, targetColumn))
        .limit(1);
      targetIsFinish = col?.isFinishStage ?? null;
    }
    const derivedCompleted = deriveIsCompleted(targetIsFinish);

    const [updated] = await db
      .update(workboardTasksTable)
      .set({
        columnId: targetColumn,
        position: targetPosition,
        isCompleted: derivedCompleted, // ← derived, not manual
        updatedAt: new Date(),
      })
      .where(eq(workboardTasksTable.id, taskId))
      .returning();

    // Stage change is the primary KPI signal. Position-only reorders within the
    // same column are not history-worthy, so only log when the column changed.
    if (targetColumn !== task.columnId) {
      let fromIsFinish: boolean | null = null;
      if (task.columnId !== null) {
        const [oldCol] = await db
          .select({ isFinishStage: workboardColumnsTable.isFinishStage })
          .from(workboardColumnsTable)
          .where(eq(workboardColumnsTable.id, task.columnId))
          .limit(1);
        fromIsFinish = oldCol?.isFinishStage ?? null;
      }
      await recordTaskEvent({
        boardId,
        taskId,
        eventType: "task_moved",
        actorUserId: uid,
        payload: {
          fromColumnId: task.columnId,
          toColumnId: targetColumn,
          fromIsFinish: fromIsFinish === true,
          toIsFinish: targetIsFinish === true,
        },
      });

      // Crossing into / out of a finish stage flips completion.
      if (updated.isCompleted && !task.isCompleted) {
        await recordTaskEvent({
          boardId,
          taskId,
          eventType: "task_completed",
          actorUserId: uid,
          payload: {
            columnId: targetColumn,
            dueDate: updated.dueDate ? updated.dueDate.toISOString() : null,
          },
        });
      } else if (!updated.isCompleted && task.isCompleted) {
        await recordTaskEvent({
          boardId,
          taskId,
          eventType: "task_reopened",
          actorUserId: uid,
          payload: { columnId: targetColumn },
        });
      }
    }

    res.json({ task: updated });
  }
);

// NOTE: the old PATCH .../complete route was removed in WorkBoard Tahap 2.
// Completion is now derived from a task's column (Model A): a task is done iff
// it sits in a finish-stage column. It is set on the move & PUT routes above —
// there is no manual completion toggle.

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

    // No task_deleted event: workboard_task_events.task_id is ON DELETE CASCADE,
    // so any event written here would be removed with the task in the same
    // breath (cascade decision, spec §3.4). If history must survive deletion,
    // switch the FK to ON DELETE SET NULL + snapshot the title first.
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

// ─── WORKBOARD-FROM-CHAT: riwayat task dari sebuah chat ──────────────────────
// GET /workboard/chats/:chatId/tasks — task yang source_chat_id = :chatId,
// dibatasi ke board yang user-nya member + milik tenant. Terbaru dulu. Dipanggil
// dari sidebar Info Chat.
router.get(
  "/chats/:chatId/tasks",
  requirePermission("workboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const chatId = Number(req.params.chatId);
    if (!Number.isInteger(chatId)) {
      res.status(400).json({ error: "Parameter tidak valid." });
      return;
    }

    // Board yang user ini member-nya (batasi visibilitas riwayat ke board yang
    // memang boleh dilihat user).
    const memberRows = await db
      .select({ boardId: workboardBoardMembersTable.boardId })
      .from(workboardBoardMembersTable)
      .where(eq(workboardBoardMembersTable.userId, uid));
    const boardIds = memberRows.map((r) => r.boardId);
    if (boardIds.length === 0) {
      res.json({ tasks: [] });
      return;
    }

    // Task dari chat ini, di board yang boleh dilihat user + milik tenant.
    const tasks = await db
      .select({
        id: workboardTasksTable.id,
        boardId: workboardTasksTable.boardId,
        title: workboardTasksTable.title,
        priority: workboardTasksTable.priority,
        isCompleted: workboardTasksTable.isCompleted,
        createdAt: workboardTasksTable.createdAt,
        boardName: workboardBoardsTable.name,
        boardColor: workboardBoardsTable.color,
        boardEmoji: workboardBoardsTable.emoji,
      })
      .from(workboardTasksTable)
      .innerJoin(
        workboardBoardsTable,
        eq(workboardBoardsTable.id, workboardTasksTable.boardId),
      )
      .where(
        and(
          eq(workboardTasksTable.sourceChatId, chatId),
          eq(workboardBoardsTable.ownerUserId, ownerUserId),
          inArray(workboardTasksTable.boardId, boardIds),
        ),
      )
      .orderBy(desc(workboardTasksTable.createdAt));

    res.json({ tasks });
  },
);

export default router;
