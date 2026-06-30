import {
  useGetMyPermissions,
  getGetMyPermissionsQueryKey,
  type RoleMatrix,
  type PermissionCell,
} from "@workspace/api-client-react";

// Menu keys that participate in the permission matrix. Mirrors PERMISSION_MENUS
// in the web app (artifacts/whatsapp-ai/src/hooks/use-permissions.ts) and the
// backend role-permissions. We only consume "workboard" on mobile today, but
// the helper is generic so other gated surfaces can reuse it.
export type PermissionMenu =
  | "knowledge"
  | "products"
  | "flows"
  | "analytics"
  | "credentials"
  | "chats"
  | "statuses"
  | "settings"
  | "channels"
  | "opportunities"
  | "ai_pipeline"
  | "workboard"
  | "acr"
  | "dashboard"
  | "aiStudio"
  | "usage"
  | "aiReview";

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

/**
 * Effective per-menu permissions for the signed-in mobile user. Backend
 * enforces the same matrix (artifacts/api-server/src/lib/role-permissions.ts);
 * these flags only drive the UI (hide controls that would 403 anyway).
 *
 * While the matrix loads we deny everything to avoid a flash of forbidden
 * controls; a super_admin owner gets ALL_TRUE immediately so the owner never
 * sees a disabled UI on first paint.
 */
export function usePermissions() {
  const { data, isLoading } = useGetMyPermissions({
    query: { queryKey: getGetMyPermissionsQueryKey(), staleTime: 30_000 },
  });
  const isSuperAdmin = data?.teamRole === "super_admin";

  const can = (key: PermissionMenu): PermissionCell =>
    isSuperAdmin ? ALL_TRUE : cell(data?.menus, key);

  return { can, isSuperAdmin, isLoading };
}
