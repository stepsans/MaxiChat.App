import { useEffect, useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import {
  useGetPermissionMatrix,
  useUpdatePermissionMatrix,
  getGetPermissionMatrixQueryKey,
  getGetMyPermissionsQueryKey,
  type PermissionMatrix,
  type PermissionCell,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  usePermissions,
  isMenuAction,
  type PermissionMenu,
} from "@/hooks/use-permissions";

// Display order + Indonesian labels. Keys MUST match PERMISSION_MENUS in
// the backend (lib/role-permissions.ts) and the frontend hook.
const MENUS: { key: PermissionMenu; label: string }[] = [
  { key: "knowledge", label: "Knowledge Base" },
  { key: "products", label: "Products" },
  { key: "flows", label: "Chatbot Flow" },
  { key: "analytics", label: "Analytics" },
  { key: "credentials", label: "Credential" },
  { key: "channels", label: "Channels" },
  { key: "statuses", label: "Statuses" },
  { key: "settings", label: "Settings" },
  { key: "chats", label: "Chats" },
  { key: "dashboard", label: "Dashboard" },
  { key: "aiStudio", label: "AI Studio" },
  { key: "usage", label: "Pemakaian Token" },
  { key: "aiReview", label: "AI Capture" },
  { key: "acr", label: "AI Chat Report" },
];

const ACTIONS: { key: keyof PermissionCell; label: string }[] = [
  { key: "canView", label: "View" },
  { key: "canCreate", label: "New" },
  { key: "canEdit", label: "Edit" },
  { key: "canDelete", label: "Delete" },
];

const ROLES = [
  { key: "supervisor" as const, label: "Supervisor" },
  { key: "agent" as const, label: "Agent" },
];

function emptyCell(): PermissionCell {
  return { canView: false, canCreate: false, canEdit: false, canDelete: false };
}

export function PermissionMatrixEditor() {
  const { isSuperAdmin } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useGetPermissionMatrix({
    query: { queryKey: getGetPermissionMatrixQueryKey() },
  });

  // Local draft state — initialised from server payload, mutated by clicks,
  // shipped wholesale on Save. We rebuild whenever a fresh payload lands so
  // unsaved drafts don't survive a refetch (intentional — read-only viewers
  // shouldn't be able to "stage" changes silently).
  const [draft, setDraft] = useState<PermissionMatrix | null>(null);
  useEffect(() => {
    if (!data) return;
    setDraft({
      supervisor: { ...data.supervisor },
      agent: { ...data.agent },
    });
  }, [data]);

  const updateMut = useUpdatePermissionMatrix({
    mutation: {
      onSuccess: async () => {
        toast({ title: "Permission tersimpan" });
        await qc.invalidateQueries({ queryKey: getGetPermissionMatrixQueryKey() });
        // Also invalidate /permissions/me so the sidebar + per-page gates
        // for every signed-in tab reflect the new matrix immediately.
        await qc.invalidateQueries({ queryKey: getGetMyPermissionsQueryKey() });
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal menyimpan",
          description: err instanceof Error ? err.message : "Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  const toggle = (
    role: "supervisor" | "agent",
    menu: string,
    action: keyof PermissionCell,
    next: boolean
  ) => {
    if (!isSuperAdmin) return;
    setDraft((d) => {
      if (!d) return d;
      const role_ = d[role] ?? {};
      const cell = (role_[menu] as PermissionCell | undefined) ?? emptyCell();
      // Turning OFF view also turns off everything else — there's no
      // backend gate that lets you e.g. delete without view, so allowing
      // the cell-state would be misleading.
      const nextCell: PermissionCell = { ...cell, [action]: next };
      if (action === "canView" && !next) {
        nextCell.canCreate = false;
        nextCell.canEdit = false;
        nextCell.canDelete = false;
      }
      // Turning ON any write action requires view.
      if (action !== "canView" && next) {
        nextCell.canView = true;
      }
      return {
        ...d,
        [role]: { ...role_, [menu]: nextCell },
      };
    });
  };

  const handleSave = () => {
    if (!draft || !isSuperAdmin) return;
    updateMut.mutate({ data: draft });
  };

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return JSON.stringify(data) !== JSON.stringify(draft);
  }, [data, draft]);

  if (isLoading || !draft) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold">Permission per Role</h2>
            <p className="text-xs text-muted-foreground mt-1 max-w-xl">
              Atur akses <span className="font-medium">dasar (default)</span> tiap
              menu untuk semua Supervisor dan Agent. Super Admin selalu memiliki
              akses penuh dan tidak dapat diubah. Untuk memberi pengecualian ke
              satu orang tertentu, gunakan tab{" "}
              <span className="font-medium">“Permission per User”</span> —
              pengaturan per user akan menimpa default role di sini.
              {!isSuperAdmin && " Hanya Super Admin yang dapat mengubah."}
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isSuperAdmin || !dirty || updateMut.isPending}
            data-testid="button-save-permissions"
          >
            {updateMut.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5 mr-1.5" />
            )}
            Simpan
          </Button>
        </div>
      </div>

      {ROLES.map((role) => (
        <div key={role.key} className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/40">
            <h3 className="text-sm font-semibold">{role.label}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/20 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Menu</th>
                  {ACTIONS.map((a) => (
                    <th
                      key={a.key}
                      className="text-center px-4 py-2 font-medium w-20"
                    >
                      {a.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {MENUS.map((m) => {
                  const cell =
                    (draft[role.key][m.key] as PermissionCell | undefined) ??
                    emptyCell();
                  return (
                    <tr key={m.key} className="border-t">
                      <td className="px-4 py-2.5">{m.label}</td>
                      {ACTIONS.map((a) => (
                        <td key={a.key} className="text-center px-4 py-2.5">
                          {isMenuAction(m.key, a.key) ? (
                            <Checkbox
                              checked={cell[a.key]}
                              disabled={!isSuperAdmin}
                              onCheckedChange={(v) =>
                                toggle(role.key, m.key, a.key, v === true)
                              }
                              data-testid={`perm-${role.key}-${m.key}-${a.key}`}
                            />
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
