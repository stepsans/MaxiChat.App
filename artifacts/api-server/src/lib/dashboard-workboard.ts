import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  workboardBoardsTable,
  workboardColumnsTable,
  workboardTasksTable,
  workboardTaskAssigneesTable,
} from "@workspace/db";

// WorkBoard Tier-2 dashboard metrics (spec A.10). All scoped to the tenant owner
// (boards.owner_user_id) and computed from current board state. Counts ignore
// archived boards. "Open" = not completed; overdue/due-soon only apply to open
// tasks. Aggregation happens in JS — task volume per tenant is modest and this
// keeps the SQL trivial.

const DUE_SOON_MS = 3 * 24 * 60 * 60 * 1000; // next 3 days

export interface WorkboardTier2 {
  kpi: {
    total: number;
    overdue: number;
    due_soon: number;
    selesai: number;
    unassigned: number;
  };
  per_column: { column: string; count: number }[];
  per_assignee: { userId: number; name: string; count: number }[];
  overdue_list: {
    taskId: number;
    title: string;
    board: string;
    dueDate: string | null;
    assignees: string[];
  }[];
  boards: { id: number; name: string }[];
}

export async function workboardTier2(
  ownerUserId: number,
  opts: { boardId?: number; assigneeId?: number } = {}
): Promise<WorkboardTier2> {
  // Owner's active boards (also feeds the board filter dropdown).
  const boards = await db
    .select({ id: workboardBoardsTable.id, name: workboardBoardsTable.name })
    .from(workboardBoardsTable)
    .where(
      and(
        eq(workboardBoardsTable.ownerUserId, ownerUserId),
        eq(workboardBoardsTable.isArchived, false)
      )
    );

  const boardIds = boards
    .map((b) => b.id)
    .filter((id) => (opts.boardId ? id === opts.boardId : true));

  const empty: WorkboardTier2 = {
    kpi: { total: 0, overdue: 0, due_soon: 0, selesai: 0, unassigned: 0 },
    per_column: [],
    per_assignee: [],
    overdue_list: [],
    boards,
  };
  if (boardIds.length === 0) return empty;

  const [tasks, columns, assignees] = await Promise.all([
    db
      .select({
        id: workboardTasksTable.id,
        title: workboardTasksTable.title,
        boardId: workboardTasksTable.boardId,
        columnId: workboardTasksTable.columnId,
        dueDate: workboardTasksTable.dueDate,
        isCompleted: workboardTasksTable.isCompleted,
      })
      .from(workboardTasksTable)
      .where(inArray(workboardTasksTable.boardId, boardIds)),
    db
      .select({ id: workboardColumnsTable.id, name: workboardColumnsTable.name })
      .from(workboardColumnsTable)
      .where(inArray(workboardColumnsTable.boardId, boardIds)),
    db
      .select({
        taskId: workboardTaskAssigneesTable.taskId,
        userId: workboardTaskAssigneesTable.userId,
        name: usersTable.name,
        email: usersTable.email,
      })
      .from(workboardTaskAssigneesTable)
      .innerJoin(workboardTasksTable, eq(workboardTaskAssigneesTable.taskId, workboardTasksTable.id))
      .innerJoin(usersTable, eq(workboardTaskAssigneesTable.userId, usersTable.id))
      .where(inArray(workboardTasksTable.boardId, boardIds)),
  ]);

  const boardName = new Map(boards.map((b) => [b.id, b.name]));
  const columnName = new Map(columns.map((c) => [c.id, c.name]));

  // taskId → assignee display names + the set of assignee user ids.
  const taskAssignees = new Map<number, { names: string[]; userIds: Set<number> }>();
  for (const a of assignees) {
    const entry = taskAssignees.get(a.taskId) ?? { names: [], userIds: new Set<number>() };
    entry.names.push(a.name || a.email || `User ${a.userId}`);
    entry.userIds.add(a.userId);
    taskAssignees.set(a.taskId, entry);
  }

  // Apply the optional assignee filter to the working task set.
  const scoped = opts.assigneeId
    ? tasks.filter((t) => taskAssignees.get(t.id)?.userIds.has(opts.assigneeId!))
    : tasks;

  const now = Date.now();
  const isOverdue = (t: (typeof scoped)[number]) =>
    !t.isCompleted && t.dueDate != null && t.dueDate.getTime() < now;
  const isDueSoon = (t: (typeof scoped)[number]) =>
    !t.isCompleted &&
    t.dueDate != null &&
    t.dueDate.getTime() >= now &&
    t.dueDate.getTime() < now + DUE_SOON_MS;

  const kpi = {
    total: scoped.length,
    overdue: scoped.filter(isOverdue).length,
    due_soon: scoped.filter(isDueSoon).length,
    selesai: scoped.filter((t) => t.isCompleted).length,
    unassigned: scoped.filter((t) => !t.isCompleted && !taskAssignees.has(t.id)).length,
  };

  // Tasks per column (open tasks only — the board view people act on).
  const perColumnMap = new Map<string, number>();
  for (const t of scoped) {
    if (t.isCompleted) continue;
    const name = t.columnId != null ? columnName.get(t.columnId) ?? "Tanpa kolom" : "Tanpa kolom";
    perColumnMap.set(name, (perColumnMap.get(name) ?? 0) + 1);
  }
  const per_column = [...perColumnMap.entries()]
    .map(([column, count]) => ({ column, count }))
    .sort((a, b) => b.count - a.count);

  // Load per assignee (open tasks).
  const perAssignee = new Map<number, { name: string; count: number }>();
  for (const t of scoped) {
    if (t.isCompleted) continue;
    const a = taskAssignees.get(t.id);
    if (!a) continue;
    for (const uid of a.userIds) {
      const name = assignees.find((x) => x.userId === uid);
      const display = name ? name.name || name.email || `User ${uid}` : `User ${uid}`;
      const cur = perAssignee.get(uid) ?? { name: display, count: 0 };
      cur.count += 1;
      perAssignee.set(uid, cur);
    }
  }
  const per_assignee = [...perAssignee.entries()]
    .map(([userId, v]) => ({ userId, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const overdue_list = scoped
    .filter(isOverdue)
    .sort((a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0))
    .slice(0, 50)
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      board: boardName.get(t.boardId) ?? "—",
      dueDate: t.dueDate?.toISOString() ?? null,
      assignees: taskAssignees.get(t.id)?.names ?? [],
    }));

  return { kpi, per_column, per_assignee, overdue_list, boards };
}
