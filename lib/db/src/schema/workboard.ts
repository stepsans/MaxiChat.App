import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";

export const workboardBoardsTable = pgTable(
  "workboard_boards",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    defaultView: text("default_view").notNull().default("kanban"),
    color: text("color").notNull().default("#6366f1"),
    emoji: text("emoji"),
    isArchived: boolean("is_archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("workboard_boards_owner_idx").on(t.ownerUserId),
    index("workboard_boards_created_by_idx").on(t.createdByUserId),
  ]
);

export const workboardBoardMembersTable = pgTable(
  "workboard_board_members",
  {
    id: serial("id").primaryKey(),
    boardId: integer("board_id")
      .notNull()
      .references(() => workboardBoardsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("viewer"),
    invitedByUserId: integer("invited_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("workboard_members_board_user_unique").on(t.boardId, t.userId),
    index("workboard_members_board_idx").on(t.boardId),
    index("workboard_members_user_idx").on(t.userId),
  ]
);

export const workboardColumnsTable = pgTable(
  "workboard_columns",
  {
    id: serial("id").primaryKey(),
    boardId: integer("board_id")
      .notNull()
      .references(() => workboardBoardsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("#94a3b8"),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("workboard_columns_board_idx").on(t.boardId)]
);

export const workboardTasksTable = pgTable(
  "workboard_tasks",
  {
    id: serial("id").primaryKey(),
    boardId: integer("board_id")
      .notNull()
      .references(() => workboardBoardsTable.id, { onDelete: "cascade" }),
    columnId: integer("column_id").references(() => workboardColumnsTable.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    description: text("description"),
    priority: text("priority").notNull().default("medium"),
    position: integer("position").notNull().default(0),
    dueDate: timestamp("due_date", { withTimezone: true }),
    tags: text("tags"),
    isCompleted: boolean("is_completed").notNull().default(false),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("workboard_tasks_board_idx").on(t.boardId),
    index("workboard_tasks_column_idx").on(t.columnId),
    index("workboard_tasks_created_by_idx").on(t.createdByUserId),
  ]
);

export const workboardTaskAssigneesTable = pgTable(
  "workboard_task_assignees",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => workboardTasksTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workboard_assignees_task_user_unique").on(t.taskId, t.userId),
    index("workboard_assignees_task_idx").on(t.taskId),
    index("workboard_assignees_user_idx").on(t.userId),
  ]
);

export const workboardTaskCommentsTable = pgTable(
  "workboard_task_comments",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id")
      .notNull()
      .references(() => workboardTasksTable.id, { onDelete: "cascade" }),
    boardId: integer("board_id")
      .notNull()
      .references(() => workboardBoardsTable.id, { onDelete: "cascade" }),
    authorUserId: integer("author_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    mentionedUserIds: integer("mentioned_user_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("workboard_comments_task_idx").on(t.taskId),
    index("workboard_comments_board_idx").on(t.boardId),
    index("workboard_comments_author_idx").on(t.authorUserId),
  ]
);

export const workboardCommentMentionsTable = pgTable(
  "workboard_comment_mentions",
  {
    id: serial("id").primaryKey(),
    commentId: integer("comment_id")
      .notNull()
      .references(() => workboardTaskCommentsTable.id, { onDelete: "cascade" }),
    mentionedUserId: integer("mentioned_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workboard_comment_mentions_unique").on(t.commentId, t.mentionedUserId),
    index("workboard_comment_mentions_user_idx").on(t.mentionedUserId),
  ]
);

// In-app mention notifications (bell). Deep-links to board_id + task_id.
export const workboardNotificationsTable = pgTable(
  "workboard_notifications",
  {
    id: serial("id").primaryKey(),
    recipientUserId: integer("recipient_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    actorUserId: integer("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    boardId: integer("board_id")
      .notNull()
      .references(() => workboardBoardsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id")
      .notNull()
      .references(() => workboardTasksTable.id, { onDelete: "cascade" }),
    commentId: integer("comment_id")
      .notNull()
      .references(() => workboardTaskCommentsTable.id, { onDelete: "cascade" }),
    type: text("type").notNull().default("mention"),
    isRead: boolean("is_read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workboard_notifications_recipient_idx").on(t.recipientUserId, t.isRead),
  ]
);

export type WorkboardBoardRow = typeof workboardBoardsTable.$inferSelect;
export type WorkboardBoardMemberRow = typeof workboardBoardMembersTable.$inferSelect;
export type WorkboardColumnRow = typeof workboardColumnsTable.$inferSelect;
export type WorkboardTaskRow = typeof workboardTasksTable.$inferSelect;
export type WorkboardTaskAssigneeRow = typeof workboardTaskAssigneesTable.$inferSelect;
export type WorkboardTaskCommentRow = typeof workboardTaskCommentsTable.$inferSelect;
export type WorkboardCommentMentionRow = typeof workboardCommentMentionsTable.$inferSelect;
export type WorkboardNotificationRow = typeof workboardNotificationsTable.$inferSelect;
