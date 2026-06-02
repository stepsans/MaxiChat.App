import { useEffect, useMemo, useState } from "react";
import { Loader2, Save, RotateCcw, Copy } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListTeamMemberPermissions,
  useGetUserPermissions,
  useUpdateUserPermissions,
  getUserPermissions,
  getListTeamMemberPermissionsQueryKey,
  getGetUserPermissionsQueryKey,
  getGetMyPermissionsQueryKey,
  useGetUserChannelAccess,
  useUpdateUserChannelAccess,
  getGetUserChannelAccessQueryKey,
  type PermissionCell,
  type RoleMatrix,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { usePermissions, PERMISSION_MENUS } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

const MENUS: { key: string; label: string }[] = [
  { key: "knowledge", label: "Knowledge Base" },
  { key: "products", label: "Products" },
  { key: "flows", label: "Chatbot Flow" },
  { key: "analytics", label: "Analytics" },
  { key: "credentials", label: "Credential" },
  { key: "channels", label: "Channels" },
  { key: "statuses", label: "Statuses" },
  { key: "settings", label: "Settings" },
  { key: "chats", label: "Chats" },
];

const ACTIONS: { key: keyof PermissionCell; label: string }[] = [
  { key: "canView", label: "View" },
  { key: "canCreate", label: "New" },
  { key: "canEdit", label: "Edit" },
  { key: "canDelete", label: "Delete" },
];

function emptyCell(): PermissionCell {
  return { canView: false, canCreate: false, canEdit: false, canDelete: false };
}

function cellsEqual(a: PermissionCell, b: PermissionCell): boolean {
  return (
    !!a.canView === !!b.canView &&
    !!a.canCreate === !!b.canCreate &&
    !!a.canEdit === !!b.canEdit &&
    !!a.canDelete === !!b.canDelete
  );
}

function cellFromMatrix(m: RoleMatrix | undefined, key: string): PermissionCell {
  const c = m?.[key];
  if (!c) return emptyCell();
  return {
    canView: !!c.canView,
    canCreate: !!c.canCreate,
    canEdit: !!c.canEdit,
    canDelete: !!c.canDelete,
  };
}

// Build a per-menu draft from roleDefault + stored overrides. Overrides
// replace the role default cell wholesale (matches the backend overlay).
function buildDraft(
  roleDefault: RoleMatrix | undefined,
  overrides: Record<string, PermissionCell> | undefined
): Record<string, PermissionCell> {
  const out: Record<string, PermissionCell> = {};
  for (const m of PERMISSION_MENUS) {
    const ov = overrides?.[m];
    out[m] = ov ? cellFromMatrix({ [m]: ov }, m) : cellFromMatrix(roleDefault, m);
  }
  return out;
}

const ROLE_LABEL: Record<string, string> = {
  super_admin: "Super Admin",
  supervisor: "Supervisor",
  agent: "Agent",
};

export function UserPermissionEditor() {
  const { isSuperAdmin } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: membersData, isLoading: membersLoading } =
    useListTeamMemberPermissions({
      query: {
        queryKey: getListTeamMemberPermissionsQueryKey(),
        enabled: isSuperAdmin,
      },
    });

  const members = membersData?.members ?? [];
  // Only supervisors/agents are editable. Super admin always has full
  // access; showing them in the picker would be confusing.
  const editableMembers = useMemo(
    () => members.filter((m) => m.teamRole !== "super_admin"),
    [members]
  );

  const [selectedId, setSelectedId] = useState<number | null>(null);
  useEffect(() => {
    if (selectedId == null && editableMembers.length > 0) {
      setSelectedId(editableMembers[0].id);
    }
  }, [editableMembers, selectedId]);

  const { data: detail, isLoading: detailLoading } = useGetUserPermissions(
    selectedId ?? 0,
    {
      query: {
        queryKey: selectedId
          ? getGetUserPermissionsQueryKey(selectedId)
          : ["user-permissions-disabled"],
        enabled: isSuperAdmin && selectedId != null,
      },
    }
  );

  const [draft, setDraft] = useState<Record<string, PermissionCell> | null>(
    null
  );
  useEffect(() => {
    if (!detail) {
      setDraft(null);
      return;
    }
    setDraft(buildDraft(detail.roleDefault, detail.overrides));
  }, [detail]);

  const updateMut = useUpdateUserPermissions({
    mutation: {
      onSuccess: async (_data, vars) => {
        toast({ title: "Permission user tersimpan" });
        await Promise.all([
          qc.invalidateQueries({
            queryKey: getGetUserPermissionsQueryKey(vars.userId),
          }),
          qc.invalidateQueries({
            queryKey: getListTeamMemberPermissionsQueryKey(),
          }),
          // Also refresh /permissions/me so the affected user's own tabs
          // (if any are open) reflect the change on next refetch.
          qc.invalidateQueries({ queryKey: getGetMyPermissionsQueryKey() }),
        ]);
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
    menu: string,
    action: keyof PermissionCell,
    next: boolean
  ) => {
    setDraft((d) => {
      if (!d) return d;
      const cur = d[menu] ?? emptyCell();
      const nextCell: PermissionCell = { ...cur, [action]: next };
      // Same chain-rules as the role matrix editor — backend has no path
      // that allows create/edit/delete without view, so don't pretend the
      // UI does.
      if (action === "canView" && !next) {
        nextCell.canCreate = false;
        nextCell.canEdit = false;
        nextCell.canDelete = false;
      }
      if (action !== "canView" && next) {
        nextCell.canView = true;
      }
      return { ...d, [menu]: nextCell };
    });
  };

  // Diff draft vs role default → the wire payload. Cells that match the
  // role default get omitted so we don't store redundant rows.
  const overridesForSave = useMemo(():
    | Record<string, PermissionCell>
    | null => {
    if (!draft || !detail) return null;
    const out: Record<string, PermissionCell> = {};
    for (const m of PERMISSION_MENUS) {
      const base = cellFromMatrix(detail.roleDefault, m);
      const cur = draft[m] ?? emptyCell();
      if (!cellsEqual(base, cur)) out[m] = cur;
    }
    return out;
  }, [draft, detail]);

  const dirty = useMemo(() => {
    if (!detail || !overridesForSave) return false;
    const storedKeys = Object.keys(detail.overrides ?? {}).sort();
    const draftKeys = Object.keys(overridesForSave).sort();
    if (storedKeys.join(",") !== draftKeys.join(",")) return true;
    for (const k of draftKeys) {
      const a = cellFromMatrix({ [k]: detail.overrides[k] }, k);
      const b = overridesForSave[k];
      if (!cellsEqual(a, b)) return true;
    }
    return false;
  }, [detail, overridesForSave]);

  const handleSave = () => {
    if (selectedId == null || !overridesForSave) return;
    updateMut.mutate({
      userId: selectedId,
      data: { overrides: overridesForSave },
    });
  };

  const handleReset = () => {
    if (selectedId == null) return;
    updateMut.mutate({ userId: selectedId, data: { overrides: null } });
  };

  // "Copy from user X" — pulls the effective cells from another team
  // member and stages them as a draft, without saving. The user can still
  // tweak before pressing Simpan. We pull the full detail (effective) so
  // we capture both the source's role default + their overrides.
  const [copySourceId, setCopySourceId] = useState<string>("");
  const [copying, setCopying] = useState(false);
  const handleCopy = async () => {
    if (!copySourceId) return;
    const srcId = Number(copySourceId);
    if (!Number.isInteger(srcId) || srcId === selectedId) return;
    setCopying(true);
    try {
      const src = await qc.fetchQuery({
        queryKey: getGetUserPermissionsQueryKey(srcId),
        queryFn: () => getUserPermissions(srcId),
      });
      const next: Record<string, PermissionCell> = {};
      for (const m of PERMISSION_MENUS) {
        next[m] = cellFromMatrix(src.effective, m);
      }
      setDraft(next);
      toast({
        title: "Tersalin ke draft",
        description: "Tekan Simpan untuk menerapkan, atau ubah sesuai kebutuhan.",
      });
    } catch (err) {
      toast({
        title: "Gagal menyalin",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    } finally {
      setCopying(false);
    }
  };

  if (!isSuperAdmin) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        Hanya Super Admin yang dapat mengubah permission per user.
      </div>
    );
  }

  if (membersLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (editableMembers.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        Belum ada Supervisor atau Agent di tim Anda.
      </div>
    );
  }

  const selectedMember = editableMembers.find((m) => m.id === selectedId);
  const copyOptions = editableMembers.filter((m) => m.id !== selectedId);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold">Permission per User</h2>
          <p className="text-xs text-muted-foreground mt-1 max-w-xl">
            Atur pengecualian akses untuk satu user. Urutan prioritas:{" "}
            <span className="font-medium">Super Admin</span> (akses penuh) ›{" "}
            <span className="font-medium">Override per user</span> (di sini) ›{" "}
            <span className="font-medium">Default role</span> (tab “Permission per
            Role”). Baris bertanda <span className="font-medium">Override</span>{" "}
            memakai izin khusus user ini; baris{" "}
            <span className="font-medium">Ikut role</span> otomatis mengikuti
            default role-nya. Cell yang sama dengan default role tidak disimpan.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[260px]">
            <Select
              value={selectedId != null ? String(selectedId) : ""}
              onValueChange={(v) => setSelectedId(Number(v))}
            >
              <SelectTrigger data-testid="select-user-permission-target">
                <SelectValue placeholder="Pilih user" />
              </SelectTrigger>
              <SelectContent>
                {editableMembers.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    <div className="flex items-center gap-2">
                      <span>{m.name || m.email}</span>
                      <Badge variant="outline" className="text-[10px]">
                        {ROLE_LABEL[m.teamRole] ?? m.teamRole}
                      </Badge>
                      {m.hasOverrides && (
                        <Badge variant="secondary" className="text-[10px]">
                          Custom
                        </Badge>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedMember && (
            <span className="text-xs text-muted-foreground">
              {selectedMember.email}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1 border-t">
          <span className="text-xs text-muted-foreground">Salin dari:</span>
          <div className="min-w-[220px]">
            <Select
              value={copySourceId}
              onValueChange={setCopySourceId}
              disabled={copyOptions.length === 0}
            >
              <SelectTrigger data-testid="select-copy-source">
                <SelectValue placeholder="Pilih user sumber" />
              </SelectTrigger>
              <SelectContent>
                {copyOptions.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name || m.email}{" "}
                    <span className="text-muted-foreground">
                      ({ROLE_LABEL[m.teamRole] ?? m.teamRole})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleCopy}
            disabled={!copySourceId || copying || detailLoading}
            data-testid="button-copy-from-user"
          >
            {copying ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Copy className="w-3.5 h-3.5 mr-1.5" />
            )}
            Tempel sebagai draft
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={handleReset}
              disabled={
                updateMut.isPending ||
                detailLoading ||
                Object.keys(detail?.overrides ?? {}).length === 0
              }
              data-testid="button-reset-user-permissions"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Reset ke default
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || updateMut.isPending || detailLoading}
              data-testid="button-save-user-permissions"
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
      </div>

      {detailLoading || !draft || !detail ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b bg-muted/40 flex items-center gap-2">
            <h3 className="text-sm font-semibold">
              {selectedMember?.name || selectedMember?.email}
            </h3>
            <Badge variant="outline" className="text-[10px]">
              {ROLE_LABEL[detail.user.teamRole] ?? detail.user.teamRole}
            </Badge>
            <span className="text-xs text-muted-foreground ml-2">
              Cell yang dicetak tebal berbeda dari default role.
            </span>
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
                  const cur = draft[m.key] ?? emptyCell();
                  const base = cellFromMatrix(detail.roleDefault, m.key);
                  const rowDiffers = !cellsEqual(cur, base);
                  return (
                    <tr
                      key={m.key}
                      className={cn(
                        "border-t",
                        rowDiffers && "bg-amber-50/40 dark:bg-amber-950/10"
                      )}
                    >
                      <td
                        className={cn(
                          "px-4 py-2.5",
                          rowDiffers && "font-semibold"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span>{m.label}</span>
                          {rowDiffers ? (
                            <Badge
                              variant="secondary"
                              className="text-[10px] bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300"
                            >
                              Override
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="text-[10px] text-muted-foreground font-normal"
                            >
                              Ikut role
                            </Badge>
                          )}
                        </div>
                      </td>
                      {ACTIONS.map((a) => {
                        const cellDiffers = cur[a.key] !== base[a.key];
                        return (
                          <td
                            key={a.key}
                            className={cn(
                              "text-center px-4 py-2.5",
                              cellDiffers &&
                                "font-bold text-amber-700 dark:text-amber-400"
                            )}
                          >
                            <Checkbox
                              checked={cur[a.key]}
                              onCheckedChange={(v) =>
                                toggle(m.key, a.key, v === true)
                              }
                              data-testid={`user-perm-${m.key}-${a.key}`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedId != null && <ChannelAccessCard userId={selectedId} />}
    </div>
  );
}

// Per-user channel access — gates which channels appear in this user's
// channel switcher. Supervisor/agent see ONLY the channels checked here
// (deny by default); super_admin always sees every channel in the tenant.
// Restricting the switcher also restricts every per-channel surface
// (chats/flows/statuses/analytics) since they follow the active channel.
function ChannelAccessCard({ userId }: { userId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useGetUserChannelAccess(userId, {
    query: {
      queryKey: getGetUserChannelAccessQueryKey(userId),
      enabled: userId > 0,
    },
  });

  const [selected, setSelected] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (data) setSelected(new Set(data.allowedChannelIds));
  }, [data]);

  const updateMut = useUpdateUserChannelAccess({
    mutation: {
      onSuccess: async () => {
        toast({ title: "Akses channel tersimpan" });
        await qc.invalidateQueries({
          queryKey: getGetUserChannelAccessQueryKey(userId),
        });
      },
      onError: (err: unknown) => {
        toast({
          title: "Gagal menyimpan akses channel",
          description: err instanceof Error ? err.message : "Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  const dirty = useMemo(() => {
    if (!data || !selected) return false;
    const a = new Set(data.allowedChannelIds);
    if (a.size !== selected.size) return true;
    for (const id of selected) if (!a.has(id)) return true;
    return false;
  }, [data, selected]);

  const toggle = (id: number, on: boolean) => {
    setSelected((s) => {
      const next = new Set(s ?? []);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handleSelectAll = (on: boolean) => {
    if (!data) return;
    setSelected(on ? new Set(data.channels.map((c) => c.id)) : new Set());
  };

  const handleSave = () => {
    if (!selected) return;
    updateMut.mutate({
      userId,
      data: { channelIds: Array.from(selected).sort((a, b) => a - b) },
    });
  };

  if (isLoading || !data || !selected) {
    return (
      <div className="rounded-lg border bg-card p-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Memuat akses channel…
      </div>
    );
  }

  const allOn = selected.size === data.channels.length && data.channels.length > 0;
  const noneOn = selected.size === 0;

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/40 flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <h3 className="text-sm font-semibold">Akses Channel</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Hanya channel yang dicentang yang akan tampil di channel switcher
            user ini (dan otomatis membatasi chat / flow / status / analytics
            untuk channel tersebut). Super Admin selalu melihat semua channel.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => handleSelectAll(!allOn)}
          disabled={data.channels.length === 0}
          data-testid="button-toggle-all-channels"
        >
          {allOn ? "Hapus semua" : "Pilih semua"}
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!dirty || updateMut.isPending}
          data-testid="button-save-channel-access"
        >
          {updateMut.isPending ? (
            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5 mr-1.5" />
          )}
          Simpan
        </Button>
      </div>

      {data.channels.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground text-center">
          Belum ada channel di tim ini.
        </div>
      ) : (
        <div className="divide-y">
          {data.channels.map((c) => {
            const on = selected.has(c.id);
            return (
              <label
                key={c.id}
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/30"
              >
                <Checkbox
                  checked={on}
                  onCheckedChange={(v) => toggle(c.id, v === true)}
                  data-testid={`channel-access-${c.id}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{c.label}</div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
                    {c.kind} · {c.status}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}

      {noneOn && (
        <div className="px-4 py-2 border-t bg-amber-50/50 dark:bg-amber-950/20 text-xs text-amber-800 dark:text-amber-300">
          User ini tidak akan melihat chat apa pun sampai minimal satu channel
          dipilih.
        </div>
      )}
    </div>
  );
}
