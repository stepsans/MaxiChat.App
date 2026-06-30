import { apiGetJson, apiPatchJson, apiPostJson } from "./api";

// The WorkBoard board/column/task routes live under /api/workboard but are NOT
// part of the OpenAPI spec, so there are no generated hooks/types. These thin
// types mirror the fields the backend returns (artifacts/api-server/src/routes/
// workboard.ts) — only what the mobile "Tambah ke WorkBoard" flow needs.

export type WorkboardBoard = {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  emoji: string | null;
  taskCount: number;
  memberCount: number;
  isArchived: boolean;
};

export type WorkboardColumn = {
  id: number;
  name: string;
  color: string | null;
  position: number;
  isFinishStage?: boolean;
};

export type WorkboardAssignee = {
  userId: number;
  name: string | null;
  email: string | null;
  profilePhotoUrl: string | null;
};

export type WorkboardTask = {
  id: number;
  boardId: number;
  columnId: number | null;
  title: string;
  description: string | null;
  priority: string;
  position: number;
  dueDate: string | null;
  tags: string | null;
  isCompleted: boolean;
  sourceType?: string | null;
  sourceChatId?: number | null;
  sourceContactName?: string | null;
  sourceLastMessage?: string | null;
  assignees: WorkboardAssignee[];
};

export type WorkboardRole = "owner" | "editor" | "viewer";

export type WorkboardMember = {
  id: number;
  userId: number;
  role: WorkboardRole;
  name: string | null;
  email: string | null;
  profilePhotoUrl: string | null;
};

export type WorkboardBoardDetail = {
  board: WorkboardBoard;
  columns: WorkboardColumn[];
  tasks: WorkboardTask[];
  members: WorkboardMember[];
  myRole: WorkboardRole | null;
};

export type WorkboardTaskPriority = "low" | "medium" | "high";

export type CreateWorkboardTaskInput = {
  title: string;
  description?: string;
  columnId?: number | null;
  priority?: WorkboardTaskPriority;
  tags?: string;
  // Staff assigned to the task. The backend validates each id is a board member
  // and silently drops the rest; assignees see the task in their "Harus
  // Dikerjakan" feed.
  assigneeIds?: number[];
  // WorkBoard-from-chat linkage. The backend snapshots the contact name + last
  // message server-side and ignores these when the chat isn't in the tenant.
  sourceType?: "chat";
  sourceChatId?: number;
};

export type CreatedWorkboardTask = {
  id: number;
  boardId: number;
  columnId: number | null;
  title: string;
};

/** Active (non-archived) boards the signed-in user is a member of. */
export async function fetchWorkboardBoards(): Promise<WorkboardBoard[]> {
  const res = await apiGetJson<{ boards: WorkboardBoard[] }>(
    "/api/workboard/boards?archived=false",
  );
  return res?.boards ?? [];
}

/**
 * Full board detail. Returns the board, its columns (sorted by position), every
 * task (with assignees), and the caller's board role. Mirrors the web
 * `GET /boards/:boardId` shape so the mobile Kanban matches the web board.
 */
export async function fetchWorkboardBoard(
  boardId: number,
): Promise<WorkboardBoardDetail> {
  const res = await apiGetJson<{
    board: WorkboardBoard;
    columns: WorkboardColumn[];
    tasks: WorkboardTask[];
    members: WorkboardMember[];
    myRole: WorkboardRole | null;
  }>(`/api/workboard/boards/${boardId}`);
  const columns = [...(res?.columns ?? [])].sort((a, b) => a.position - b.position);
  return {
    board: res.board,
    columns,
    tasks: res?.tasks ?? [],
    members: res?.members ?? [],
    myRole: res?.myRole ?? null,
  };
}

/**
 * Move a task to another column (and/or reorder). The backend derives
 * completion from the destination column's finish-stage flag. Returns the
 * updated task.
 */
export async function moveWorkboardTask(
  boardId: number,
  taskId: number,
  columnId: number | null,
  position: number,
): Promise<void> {
  await apiPatchJson(`/api/workboard/boards/${boardId}/tasks/${taskId}/move`, {
    columnId,
    position,
  });
}

export async function createWorkboardTask(
  boardId: number,
  input: CreateWorkboardTaskInput,
): Promise<CreatedWorkboardTask> {
  const res = await apiPostJson<{ task: CreatedWorkboardTask }>(
    `/api/workboard/boards/${boardId}/tasks`,
    input as unknown as Record<string, unknown>,
  );
  return res.task;
}
