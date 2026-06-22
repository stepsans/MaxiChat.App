import { db, workboardTaskEventsTable } from "@workspace/db";
import { logger } from "./logger";

// Single chokepoint for writing WorkBoard task history. Append-only: rows are
// never updated, only inserted (cascade-deleted with their task/board). This is
// raw data for FUTURE KPI (on-time rate, cycle time, throughput) — no
// aggregation happens here.
//
// Completion model: this codebase has NO finish-stage column; completion is the
// workboard_tasks.is_completed boolean. So task_completed / task_reopened key
// off is_completed transitions, and task_moved carries plain from/to column ids
// (no finish-stage flags).

// Allowed event types. Kept as a const union for type-safety in callers; the DB
// column is plain text (new types need no migration).
export type WorkboardTaskEventType =
  | "task_created" // task baru dibuat. payload: { columnId, dueDate, priority, assigneeIds }
  | "task_moved" // pindah kolom (stage). payload: { fromColumnId, toColumnId }
  | "task_completed" // is_completed → true. payload: { columnId, dueDate }
  | "task_reopened" // is_completed → false. payload: { columnId }
  | "assignee_added" // payload: { userId }
  | "assignee_removed" // payload: { userId }
  | "due_date_changed" // payload: { from: string|null, to: string|null }
  | "task_deleted"; // task dihapus. payload: { lastColumnId, wasCompleted }

export interface RecordTaskEventInput {
  boardId: number;
  taskId: number;
  eventType: WorkboardTaskEventType;
  actorUserId: number | null;
  actor?: "user" | "system";
  payload?: Record<string, unknown>;
}

// Best-effort: never throw into the caller's main flow. Logs on failure so a
// transient insert error can't fail the underlying task action.
export async function recordTaskEvent(input: RecordTaskEventInput): Promise<void> {
  try {
    await db.insert(workboardTaskEventsTable).values({
      boardId: input.boardId,
      taskId: input.taskId,
      eventType: input.eventType,
      actor: input.actor ?? "user",
      actorUserId: input.actorUserId,
      payload: input.payload ?? {},
      createdAt: new Date(),
    });
  } catch (err) {
    logger.warn({ err, input }, "recordTaskEvent failed");
    // swallow — event logging must not break task actions
  }
}
