import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const agentInvitationsTable = pgTable("agent_invitations", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedByUserId: integer("invited_by_user_id").notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  agentUserId: integer("agent_user_id").notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("agent_inv_email_idx").on(t.email),
  index("agent_inv_agent_idx").on(t.agentUserId),
]);

export type AgentInvitationRow = typeof agentInvitationsTable.$inferSelect;
