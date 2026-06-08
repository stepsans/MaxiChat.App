import {
  useGetMyPermissions,
  getGetMyPermissionsQueryKey,
  type RoleMatrix,
  type PermissionCell,
} from "@workspace/api-client-react";

export type TeamRole = "super_admin" | "supervisor" | "agent";

// The menus that participate in the matrix. Must stay in lock-step with
// PERMISSION_MENUS in artifacts/api-server/src/lib/role-permissions.ts and
// the matrix editor on the Agents page.
export const PERMISSION_MENUS = [
  "knowledge",
  "products",
  "flows",
  "analytics",
  "credentials",
  "chats",
  "statuses",
  "settings",
  "channels",
  // AI Sales Assistant (Enterprise-only). Full CRUD; agents are scoped to
  // their own assigned opportunities by the route layer, not this matrix.
  "opportunities",
  // View-only menus: only canView is meaningful (no create/edit/delete routes).
  "dashboard",
  "aiStudio",
  "usage",
  "aiReview",
] as const;
export type PermissionMenu = (typeof PERMISSION_MENUS)[number];

// Which action columns are meaningful per menu. Menus not granting full CRUD
// expose only the actions their backend actually enforces; the matrix editors
// render "—" for the rest so admins aren't shown checkboxes that do nothing.
// Must stay in lock-step with the backend route guards.
const FULL_CRUD: Array<keyof PermissionCell> = [
  "canView",
  "canCreate",
  "canEdit",
  "canDelete",
];
export const MENU_ACTIONS: Record<PermissionMenu, Array<keyof PermissionCell>> = {
  knowledge: FULL_CRUD,
  products: FULL_CRUD,
  flows: FULL_CRUD,
  credentials: FULL_CRUD,
  channels: FULL_CRUD,
  opportunities: FULL_CRUD,
  statuses: ["canView", "canCreate", "canDelete"],
  analytics: ["canView"],
  settings: ["canView"],
  chats: ["canView"],
  dashboard: ["canView"],
  aiStudio: ["canView"],
  usage: ["canView"],
  aiReview: ["canView"],
};

// Whether `action` is a meaningful column for `menu` (used to gate matrix cells).
export function isMenuAction(
  menu: PermissionMenu,
  action: keyof PermissionCell
): boolean {
  return (MENU_ACTIONS[menu] ?? FULL_CRUD).includes(action);
}

const ALL_TRUE: PermissionCell = {
  canView: true,
  canCreate: true,
  canEdit: true,
  canDelete: true,
};
const ALL_FALSE: PermissionCell = {
  canView: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
};

function cell(menus: RoleMatrix | undefined, key: PermissionMenu): PermissionCell {
  const c = menus?.[key];
  if (!c) return ALL_FALSE;
  return {
    canView: !!c.canView,
    canCreate: !!c.canCreate,
    canEdit: !!c.canEdit,
    canDelete: !!c.canDelete,
  };
}

// Single source of truth for "what can the current user touch?". Backend
// enforces the same rules in artifacts/api-server/src/lib/role-permissions.ts;
// these flags drive the UI (hide buttons that would 403 anyway) and the
// sidebar nav filter (hide menus the user cannot view).
//
// While the matrix is still loading we deny everything to avoid a flash of
// forbidden controls — super_admin gets ALL_TRUE immediately so the owner
// never sees a blank/disabled UI on first paint.
export function usePermissions() {
  const { data, isLoading } = useGetMyPermissions({
    query: { queryKey: getGetMyPermissionsQueryKey(), staleTime: 30_000 },
  });
  const teamRole: TeamRole = (data?.teamRole as TeamRole | undefined) ?? "agent";
  const isSuperAdmin = teamRole === "super_admin";
  const isSupervisorOrAbove =
    teamRole === "super_admin" || teamRole === "supervisor";
  const isAgent = teamRole === "agent";

  // Build a per-menu cell. Super admin gets all-true regardless of payload.
  const get = (key: PermissionMenu): PermissionCell =>
    isSuperAdmin ? ALL_TRUE : cell(data?.menus, key);

  const menus = Object.fromEntries(
    PERMISSION_MENUS.map((m) => [m, get(m)])
  ) as Record<PermissionMenu, PermissionCell>;

  // Back-compat aliases used by existing pages. Reading the same per-menu
  // cells keeps Products/Knowledge/Flows/Status untouched while still
  // honouring the new matrix.
  const can = {
    addStatus: menus.statuses.canCreate,
    deleteStatus: menus.statuses.canDelete,
    mutateKnowledge:
      menus.knowledge.canCreate ||
      menus.knowledge.canEdit ||
      menus.knowledge.canDelete,
    mutateProducts:
      menus.products.canCreate ||
      menus.products.canEdit ||
      menus.products.canDelete,
    mutateFlows:
      menus.flows.canCreate || menus.flows.canEdit || menus.flows.canDelete,
    manageTeamSettings: isSuperAdmin,
  };

  return {
    teamRole,
    isAgent,
    isSupervisorOrAbove,
    isSuperAdmin,
    isLoading,
    menus,
    can,
  };
}
