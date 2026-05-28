import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  uniqueIndex,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Per-team, per-role permission matrix. One row per (super_admin owner,
// team role, menu). Super admin is intentionally NOT stored here — they
// always have full access (enforced in code) so the matrix can never lock
// the owner out of their own product.
//
// `menu` is one of the 8 high-level UI sections (knowledge, products,
// flows, analytics, credentials, chats, statuses, settings); `role` is
// "supervisor" or "agent". Each row carries the 4 CRUD bits.
//
// Rows are created lazily with hard-coded defaults the first time the
// owner's matrix is read (see lib/role-permissions.ts).
export const rolePermissionsTable = pgTable(
  "role_permissions",
  {
    id: serial("id").primaryKey(),
    // The super_admin user.id whose team this matrix belongs to. Invited
    // members are resolved up to this owner before lookup.
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "supervisor" | "agent"
    menu: text("menu").notNull(), // see RolePermissionMenu union
    canView: boolean("can_view").notNull().default(false),
    canCreate: boolean("can_create").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqByOwnerRoleMenu: uniqueIndex("role_permissions_owner_role_menu_key").on(
      t.ownerUserId,
      t.role,
      t.menu
    ),
  })
);

export type RolePermissionRow = typeof rolePermissionsTable.$inferSelect;

// Per-USER permission overrides layered on top of role defaults. One row per
// (user, menu) — its mere presence means the user has an explicit override
// for that menu; absent rows fall through to the role matrix above.
//
// Resolution order in getEffectivePermissions(userId):
//   1. super_admin → always all-true (rows here are ignored for safety).
//   2. role matrix (role_permissions) provides the per-menu baseline.
//   3. any matching row in user_permissions REPLACES that menu's cell
//      wholesale (not field-merged) — this matches the editor UX where
//      the user toggles a whole row at a time.
//
// ON DELETE CASCADE on userId so leaving the team takes the overrides too.
export const userPermissionsTable = pgTable(
  "user_permissions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    menu: text("menu").notNull(), // see PermissionMenu union
    canView: boolean("can_view").notNull().default(false),
    canCreate: boolean("can_create").notNull().default(false),
    canEdit: boolean("can_edit").notNull().default(false),
    canDelete: boolean("can_delete").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniqByUserMenu: uniqueIndex("user_permissions_user_menu_key").on(
      t.userId,
      t.menu
    ),
  })
);

export type UserPermissionRow = typeof userPermissionsTable.$inferSelect;
