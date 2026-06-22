import {
  pgTable,
  serial,
  integer,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Pre-computed Dashboard KPI snapshot (spec 2.8 / 3.6). The heavy analytic
// metrics are aggregated 5×/day at the WIB cutoffs (09/12/15/18/21) and stored
// here so the "Hari ini" Tier-1 view loads instantly instead of scanning
// chat_messages/analyses on every open. The live queue ("Belum dibalas", chat
// aktif saya) is still computed live & cheap — never read from here.
//
// One row per owner per cutoff; latest row (ORDER BY snapshot_at DESC LIMIT 1)
// is the current view, older rows give the delta vs previous period.
export interface DashboardSnapshotPayload {
  percakapan: { count: number; previous: number; delta: number };
  ai_handled_percent: number | null;
  lead_panas: number;
  tidak_puas: number;
  won: { count: number; value: number };
  lead_status: { lead: number; not_lead: number; unknown: number };
  // AI Chat Report narrative (spec 4.3), generated once/day. Null until set.
  narrative: Record<string, unknown> | null;
}

export const dashboardSnapshotsTable = pgTable(
  "dashboard_snapshots",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    windowFrom: timestamp("window_from", { withTimezone: true }),
    windowTo: timestamp("window_to", { withTimezone: true }),
    payload: jsonb("payload").notNull().$type<DashboardSnapshotPayload>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dashboard_snapshots_owner_at_idx").on(t.ownerUserId, t.snapshotAt)]
);

export type DashboardSnapshotRow = typeof dashboardSnapshotsTable.$inferSelect;
