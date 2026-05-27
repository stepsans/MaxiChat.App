import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAgents,
  useCreateAgent,
  useUpdateAgent,
  useDeleteAgent,
  useUpdateTeamSettings,
  getListAgentsQueryKey,
  type TeamAgent,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2, Pencil, ShieldCheck, Eye } from "lucide-react";
import { format } from "date-fns";
import { id as idLocale } from "date-fns/locale";

type FormState = {
  email: string;
  name: string;
  password: string;
  teamRole: "supervisor" | "agent";
};

const emptyForm: FormState = {
  email: "",
  name: "",
  password: "",
  teamRole: "agent",
};

const PLAN_LABEL: Record<string, string> = {
  basic: "Basic",
  pro: "Pro",
  business: "Business",
};

export default function Agents() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListAgents({
    query: { queryKey: getListAgentsQueryKey() },
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<FormState>(emptyForm);
  const [editTarget, setEditTarget] = useState<TeamAgent | null>(null);
  const [editForm, setEditForm] = useState<FormState>(emptyForm);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListAgentsQueryKey() });

  const createMut = useCreateAgent({
    mutation: {
      onSuccess: () => {
        invalidate();
        setCreateOpen(false);
        setCreateForm(emptyForm);
        toast({ title: "Agen ditambahkan" });
      },
      onError: (err: any) => {
        toast({
          title: "Gagal menambah agen",
          description: err?.data?.error ?? err?.message ?? "Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  const updateMut = useUpdateAgent({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditTarget(null);
        toast({ title: "Agen diperbarui" });
      },
      onError: (err: any) => {
        toast({
          title: "Gagal memperbarui",
          description: err?.data?.error ?? err?.message ?? "Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  const deleteMut = useDeleteAgent({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Agen dihapus" });
      },
      onError: (err: any) => {
        toast({
          title: "Gagal menghapus",
          description: err?.data?.error ?? err?.message ?? "Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  const isSuperAdmin = data?.teamRole === "super_admin";
  const isAtLimit = data ? data.usedAgents >= data.maxAgents : false;

  const settingsMut = useUpdateTeamSettings({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Mode penugasan diperbarui" });
      },
      onError: (err: any) => {
        toast({
          title: "Gagal menyimpan mode",
          description: err?.data?.error ?? err?.message ?? "Coba lagi.",
          variant: "destructive",
        });
      },
    },
  });

  function openEdit(agent: TeamAgent) {
    setEditTarget(agent);
    setEditForm({
      email: agent.email,
      name: agent.name ?? "",
      password: "",
      teamRole: agent.teamRole,
    });
  }

  function submitCreate() {
    if (!createForm.email.trim() || !createForm.name.trim() || createForm.password.length < 8) {
      toast({
        title: "Lengkapi data",
        description: "Email, nama, dan password (min 8 karakter) wajib diisi.",
        variant: "destructive",
      });
      return;
    }
    createMut.mutate({ data: createForm });
  }

  function submitEdit() {
    if (!editTarget) return;
    const patch: any = {
      name: editForm.name.trim() || undefined,
      teamRole: editForm.teamRole,
    };
    if (editForm.password.length >= 8) patch.password = editForm.password;
    updateMut.mutate({ id: editTarget.id, data: patch });
  }

  function toggleStatus(agent: TeamAgent) {
    updateMut.mutate({
      id: agent.id,
      data: { status: agent.status === "active" ? "disabled" : "active" },
    });
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Manajemen Agen</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Undang Supervisor dan Agen CS untuk membantu menangani chat WhatsApp.
            </p>
          </div>
          {isSuperAdmin && (
            <Button
              data-testid="button-add-agent"
              onClick={() => setCreateOpen(true)}
              disabled={isAtLimit}
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Tambah Agen
            </Button>
          )}
        </div>

        {data && isSuperAdmin && (
          <div className="rounded-lg border bg-card p-4 mb-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Mode Penugasan Chat Baru</h2>
                <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                  Manual: chat baru tidak ditugaskan otomatis, supervisor yang
                  membagikan. Round-robin: chat baru dibagi merata ke agen yang
                  sedang online (aktif dalam 2 menit terakhir).
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                {(["manual", "round_robin"] as const).map((mode) => {
                  const active = data.assignmentMode === mode;
                  return (
                    <Button
                      key={mode}
                      variant={active ? "default" : "outline"}
                      size="sm"
                      disabled={settingsMut.isPending || active}
                      onClick={() =>
                        settingsMut.mutate({ data: { assignmentMode: mode } })
                      }
                      data-testid={`button-mode-${mode}`}
                    >
                      {mode === "manual" ? "Manual" : "Round Robin"}
                    </Button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {data && (
          <div className="rounded-lg border bg-card p-4 mb-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Badge variant="outline" className="font-medium">
                Paket {PLAN_LABEL[data.plan] ?? data.plan}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {data.usedAgents} / {data.maxAgents} anggota tim digunakan
              </span>
            </div>
            {isAtLimit && isSuperAdmin && (
              <span className="text-xs text-yellow-500">
                Kuota penuh — upgrade paket untuk menambah agen.
              </span>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : !data?.agents.length ? (
          <div className="rounded-lg border border-dashed bg-card p-10 text-center">
            <p className="text-sm text-muted-foreground">
              Belum ada anggota tim. {isSuperAdmin && "Klik “Tambah Agen” untuk mengundang."}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2.5 font-medium">Nama</th>
                  <th className="text-left px-4 py-2.5 font-medium">Email</th>
                  <th className="text-left px-4 py-2.5 font-medium">Peran</th>
                  <th className="text-left px-4 py-2.5 font-medium">Status</th>
                  <th className="text-left px-4 py-2.5 font-medium">Ditambahkan</th>
                  {isSuperAdmin && <th className="px-4 py-2.5" />}
                </tr>
              </thead>
              <tbody>
                {data.agents.map((agent) => (
                  <tr
                    key={agent.id}
                    data-testid={`agent-row-${agent.id}`}
                    className="border-t border-border"
                  >
                    <td className="px-4 py-3 font-medium">{agent.name ?? "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{agent.email}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs">
                        {agent.teamRole === "supervisor" ? (
                          <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                        ) : (
                          <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                        )}
                        {agent.teamRole === "supervisor" ? "Supervisor" : "Agen"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant={agent.status === "active" ? "default" : "secondary"}
                        className="text-[10px]"
                      >
                        {agent.status === "active" ? "Aktif" : "Nonaktif"}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {format(new Date(agent.createdAt), "d MMM yyyy", { locale: idLocale })}
                    </td>
                    {isSuperAdmin && (
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => toggleStatus(agent)}
                          data-testid={`button-toggle-${agent.id}`}
                        >
                          {agent.status === "active" ? "Nonaktifkan" : "Aktifkan"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEdit(agent)}
                          data-testid={`button-edit-${agent.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-400 hover:text-red-300"
                          onClick={() => {
                            if (confirm(`Hapus agen ${agent.email}?`)) {
                              deleteMut.mutate({ id: agent.id });
                            }
                          }}
                          data-testid={`button-delete-${agent.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isSuperAdmin && (
          <p className="mt-4 text-xs text-muted-foreground">
            Hanya Super Admin yang dapat menambah, mengubah, atau menghapus anggota tim.
          </p>
        )}
      </div>

      {/* Create agent dialog */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && setCreateOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undang Anggota Tim</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-name">Nama</Label>
              <Input
                id="agent-name"
                data-testid="input-agent-name"
                value={createForm.name}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, name: e.target.value }))
                }
                placeholder="Nama lengkap"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-email">Email</Label>
              <Input
                id="agent-email"
                data-testid="input-agent-email"
                type="email"
                value={createForm.email}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, email: e.target.value }))
                }
                placeholder="agen@perusahaan.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="agent-password">Password Awal</Label>
              <Input
                id="agent-password"
                data-testid="input-agent-password"
                type="password"
                value={createForm.password}
                onChange={(e) =>
                  setCreateForm((f) => ({ ...f, password: e.target.value }))
                }
                placeholder="Min. 8 karakter"
              />
              <p className="text-[11px] text-muted-foreground">
                Bagikan password ini ke anggota tim agar mereka bisa login.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Peran</Label>
              <Select
                value={createForm.teamRole}
                onValueChange={(v) =>
                  setCreateForm((f) => ({ ...f, teamRole: v as any }))
                }
              >
                <SelectTrigger data-testid="select-agent-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supervisor">
                    Supervisor — lihat semua chat, dapat assign ke agen
                  </SelectItem>
                  <SelectItem value="agent">
                    Agen — hanya melihat chat yang ditugaskan
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Batal
            </Button>
            <Button
              data-testid="button-submit-agent"
              disabled={createMut.isPending}
              onClick={submitCreate}
            >
              {createMut.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Tambahkan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit agent dialog */}
      <Dialog open={!!editTarget} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ubah Anggota Tim</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input value={editForm.email} disabled />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Nama</Label>
              <Input
                id="edit-name"
                value={editForm.name}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, name: e.target.value }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>Peran</Label>
              <Select
                value={editForm.teamRole}
                onValueChange={(v) =>
                  setEditForm((f) => ({ ...f, teamRole: v as any }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supervisor">Supervisor</SelectItem>
                  <SelectItem value="agent">Agen</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-password">Reset Password (opsional)</Label>
              <Input
                id="edit-password"
                type="password"
                value={editForm.password}
                onChange={(e) =>
                  setEditForm((f) => ({ ...f, password: e.target.value }))
                }
                placeholder="Kosongkan untuk tidak mengubah"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              Batal
            </Button>
            <Button onClick={submitEdit} disabled={updateMut.isPending}>
              {updateMut.isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
