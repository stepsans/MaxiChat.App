import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";

// Application users. Self-signup is allowed but new accounts land in
// `status = "pending"` and cannot sign in until a super admin approves them.
// The fixed seed users (Stephen + the two test accounts) are inserted at
// boot in `status = "active"`. Stephen is the sole `role = "admin"` and is
// the only account that can call the /admin/* endpoints.
//
// status values: "pending" (awaiting admin approval), "active" (can log in),
// "disabled" (sign-in blocked, data preserved).
// role values:   "user" (default), "admin" (super admin).
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("pending"),
  // Display name shown in the UI (nullable for backward-compat with pre-name accounts).
  name: text("name"),
  // Mobile phone (E.164 or local format). Required for new invites; nullable
  // on seed/pre-feature rows for backward-compat.
  mobilePhone: text("mobile_phone"),
  // URL (under /api/media/…) for the user's avatar. Null = no photo set.
  profilePhotoUrl: text("profile_photo_url"),
  // Team hierarchy: when an "owner" user invites CS staff, the invitee's
  // parentUserId points at the owner. NULL = top-level account (super_admin).
  parentUserId: integer("parent_user_id"),
  // Role inside the WhatsApp team. "super_admin" is the owner (parent_user_id
  // NULL). Invited members are "supervisor" (sees all chats, can assign) or
  // "agent" (sees only chats assigned to them).
  teamRole: text("team_role").notNull().default("super_admin"),
  // SaaS plan that caps how many invited team members the super_admin can
  // create. Hard-coded limits: basic=2, pro=5, business=15. Inherited from
  // parent for invited members but only the parent's value is used.
  plan: text("plan").notNull().default("basic"),
  // Updated by a frontend heartbeat (every ~30s while the tab is active).
  // Used as the "online" signal for round-robin chat assignment: an agent
  // counts as online if lastSeenAt > now - 2 minutes.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // How incoming chats are routed to agents. Only the super_admin row's
  // value is used (per-tenant setting); invited rows mirror the default.
  //   "manual"      → new chats land unassigned; supervisor must assign.
  //   "round_robin" → new chats are auto-assigned to the next online agent.
  assignmentMode: text("assignment_mode").notNull().default("manual"),
  // Cursor for round-robin: the users.id of the most recently auto-assigned
  // agent. The next pick is the smallest id > cursor (wrapping). Only the
  // super_admin row uses it.
  roundRobinCursor: integer("round_robin_cursor").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
});

// Per-user binding to a WhatsApp account. The connected WhatsApp number is
// the `ownerPhone` we already use everywhere as the data-isolation key; this
// mapping pins each app user to exactly one WhatsApp account so different
// users never see each other's chats.
export const userWhatsappTable = pgTable("user_whatsapp", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  ownerPhone: text("owner_phone").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserRow = typeof usersTable.$inferSelect;
export type UserWhatsappRow = typeof userWhatsappTable.$inferSelect;
