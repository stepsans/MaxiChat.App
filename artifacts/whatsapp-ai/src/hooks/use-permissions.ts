import { useGetMe } from "@workspace/api-client-react";

export type TeamRole = "super_admin" | "supervisor" | "agent";

// Single source of truth for "what can the current user touch?". The same
// rules are enforced on the backend (artifacts/api-server/src/lib/
// team-permissions.ts); these flags only drive the UI (hide buttons that
// would 403 anyway).
//
// Defaults match the product spec:
//   * Status      — anyone can add; supervisor+ can delete.
//   * Knowledge / Products / Chatbot Flow — supervisor+ can add/edit/delete;
//     agents are view-only.
//   * Team settings (assignment mode) — super_admin only.
export function usePermissions() {
  const { data } = useGetMe({ query: { queryKey: ["/api/auth/me"] } });
  const teamRole = (data?.user?.teamRole ?? "super_admin") as TeamRole;
  const isAgent = teamRole === "agent";
  const isSupervisorOrAbove = teamRole === "super_admin" || teamRole === "supervisor";
  const isSuperAdmin = teamRole === "super_admin";
  return {
    teamRole,
    isAgent,
    isSupervisorOrAbove,
    isSuperAdmin,
    can: {
      addStatus: true,
      deleteStatus: isSupervisorOrAbove,
      mutateKnowledge: isSupervisorOrAbove,
      mutateProducts: isSupervisorOrAbove,
      mutateFlows: isSupervisorOrAbove,
      manageTeamSettings: isSuperAdmin,
    },
  };
}
