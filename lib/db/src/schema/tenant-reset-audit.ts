import {
  pgTable,
  serial,
  integer,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// What a single "Reset Tenant Database" run deleted, keyed by data class.
// Stored as a jsonb snapshot on the audit row so the UI can show a per-run
// breakdown without joining anything.
export interface TenantResetSummary {
  chats: number;
  messages: number;
  contactLabels: number;
  labels: number;
  analytics: number;
  logs: number;
  media: number;
  files: number;
  // AI Sales Assistant OPERATIONAL data wiped alongside the rest (stages
  // re-seed on next access). The per-owner `sales_assistant_settings` row is
  // CONFIGURATION (like plan/quota/channels) and deliberately survives a reset.
  pipelineStages: number;
  opportunities: number;
  salesAuditEvents: number;
  salesInsights: number;
}

// Append-only audit trail of tenant-wide data resets. One row per successful
// reset. `ownerUserId` is the tenant whose data was wiped; `performedByUserId`
// is the (super-admin) account that triggered it — they may differ when a
// team member with super_admin rights runs the reset. Both FK-cascade so a
// deleted account doesn't leave dangling audit rows.
export const tenantResetAuditTable = pgTable(
  "tenant_reset_audit",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    performedByUserId: integer("performed_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    summary: jsonb("summary").$type<TenantResetSummary>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tenant_reset_audit_owner_idx").on(t.ownerUserId, t.createdAt),
  ]
);

export type TenantResetAuditRow = typeof tenantResetAuditTable.$inferSelect;
