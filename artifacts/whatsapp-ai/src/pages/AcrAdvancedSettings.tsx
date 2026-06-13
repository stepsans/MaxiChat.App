// AI Chat Report — advanced settings (Bagian IV): per-agent KPI targets (9.1)
// and team/shift groups for benchmarking (9.3). Rendered inside the ACR
// settings page (super admin only).
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAcrTeamMembers,
  useListAcrTargets,
  getListAcrTargetsQueryKey,
  useSetAcrTarget,
  useDeleteAcrTarget,
  useListAcrTeamGroups,
  getListAcrTeamGroupsQueryKey,
  useCreateAcrTeamGroup,
  useDeleteAcrTeamGroup,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function AcrAdvancedSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: members } = useListAcrTeamMembers();
  const { data: targets } = useListAcrTargets();
  const { data: groups } = useListAcrTeamGroups();

  const setTarget = useSetAcrTarget();
  const deleteTarget = useDeleteAcrTarget();
  const createGroup = useCreateAcrTeamGroup();
  const deleteGroup = useDeleteAcrTeamGroup();

  const targetByAgent = useMemo(
    () => new Map((targets ?? []).map((t) => [t.agentUserId, t.targetScore])),
    [targets]
  );
  const [draft, setDraft] = useState<Record<number, string>>({});

  const invalidateTargets = () =>
    qc.invalidateQueries({ queryKey: getListAcrTargetsQueryKey() });
  const invalidateGroups = () =>
    qc.invalidateQueries({ queryKey: getListAcrTeamGroupsQueryKey() });

  // Team group form.
  const [groupName, setGroupName] = useState("");
  const [groupLabel, setGroupLabel] = useState("");
  const [groupMembers, setGroupMembers] = useState<number[]>([]);

  const toggleGroupMember = (id: number) =>
    setGroupMembers((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submitGroup = () => {
    if (!groupName.trim()) {
      toast({ title: "Nama tim wajib diisi.", variant: "destructive" });
      return;
    }
    createGroup.mutate(
      {
        data: {
          name: groupName.trim(),
          scheduleLabel: groupLabel.trim() || null,
          agentUserIds: groupMembers,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Tim dibuat." });
          setGroupName("");
          setGroupLabel("");
          setGroupMembers([]);
          invalidateGroups();
        },
      }
    );
  };

  return (
    <>
      {/* 9.1 Target KPI per agent */}
      <Card>
        <CardHeader>
          <CardTitle>Target KPI Per Agent</CardTitle>
          <CardDescription>
            Skor target individu (0–100). Sistem akan memunculkan alert bila skor di bawah target.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {(members ?? []).map((m) => {
            const existing = targetByAgent.get(m.id);
            const value = draft[m.id] ?? (existing != null ? String(existing) : "");
            return (
              <div key={m.id} className="flex items-center gap-3">
                <span className="flex-1 truncate text-sm">
                  {m.name ?? m.email}{" "}
                  <span className="text-xs text-muted-foreground">({m.teamRole})</span>
                </span>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  className="w-24"
                  placeholder="80"
                  value={value}
                  onChange={(e) => setDraft((d) => ({ ...d, [m.id]: e.target.value }))}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const score = Number(value);
                    if (!Number.isFinite(score) || score < 0 || score > 100) {
                      toast({ title: "Target harus 0–100.", variant: "destructive" });
                      return;
                    }
                    setTarget.mutate(
                      { agentId: m.id, data: { targetScore: score } },
                      {
                        onSuccess: () => {
                          toast({ title: "Target disimpan." });
                          invalidateTargets();
                        },
                      }
                    );
                  }}
                >
                  Simpan
                </Button>
                {existing != null && (
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() =>
                      deleteTarget.mutate(
                        { agentId: m.id },
                        {
                          onSuccess: () => {
                            setDraft((d) => {
                              const next = { ...d };
                              delete next[m.id];
                              return next;
                            });
                            invalidateTargets();
                          },
                        }
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            );
          })}
          {(members ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">Belum ada anggota tim.</p>
          )}
        </CardContent>
      </Card>

      {/* 9.3 Team / shift groups */}
      <Card>
        <CardHeader>
          <CardTitle>Tim / Shift (Benchmark)</CardTitle>
          <CardDescription>
            Kelompokkan agent ke dalam tim/shift untuk perbandingan performa di dashboard.
            Butuh minimal 2 tim.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(groups ?? []).map((g) => (
            <div key={g.id} className="flex items-center justify-between rounded-md border p-3">
              <div>
                <p className="text-sm font-medium">{g.name}</p>
                <p className="text-xs text-muted-foreground">
                  {g.scheduleLabel ? `${g.scheduleLabel} · ` : ""}
                  {g.agentUserIds.length} agent
                </p>
              </div>
              <Button
                size="icon"
                variant="ghost"
                onClick={() =>
                  deleteGroup.mutate(
                    { id: g.id },
                    {
                      onSuccess: () => {
                        toast({ title: "Tim dihapus." });
                        invalidateGroups();
                      },
                    }
                  )
                }
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <div className="space-y-3 rounded-md border border-dashed p-3">
            <p className="text-sm font-medium">Tambah Tim</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label className="text-xs">Nama Tim</Label>
                <Input
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Tim Pagi"
                />
              </div>
              <div>
                <Label className="text-xs">Label Jadwal (opsional)</Label>
                <Input
                  value={groupLabel}
                  onChange={(e) => setGroupLabel(e.target.value)}
                  placeholder="Shift 07.00–15.00"
                />
              </div>
            </div>
            <div>
              <Label className="text-xs">Anggota</Label>
              <div className="mt-1 grid max-h-40 grid-cols-2 gap-1 overflow-y-auto">
                {(members ?? []).map((m) => (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={groupMembers.includes(m.id)}
                      onCheckedChange={() => toggleGroupMember(m.id)}
                    />
                    <span className="truncate">{m.name ?? m.email}</span>
                  </label>
                ))}
              </div>
            </div>
            <Button size="sm" onClick={submitGroup} disabled={createGroup.isPending}>
              <Plus className="mr-1 h-4 w-4" /> Tambah Tim
            </Button>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
