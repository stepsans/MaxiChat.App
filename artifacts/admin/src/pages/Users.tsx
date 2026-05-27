import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminListUsers,
  useAdminUpdateUser,
  useAdminDeleteUser,
  getAdminListUsersQueryKey,
} from "@workspace/api-client-react";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Trash2,
  ShieldCheck,
  User as UserIcon,
  Clock,
  RefreshCw,
  Search,
} from "lucide-react";

type AdminUserRow = {
  id: number;
  email: string;
  role: "user" | "admin";
  status: "pending" | "active" | "disabled";
  createdAt: string;
  approvedAt: string | null;
  ownerPhone: string | null;
};

function StatusBadge({ status }: { status: AdminUserRow["status"] }) {
  const map = {
    pending: {
      label: "Menunggu",
      cls: "bg-amber-500/15 text-amber-400 border-amber-500/30",
      Icon: Clock,
    },
    active: {
      label: "Aktif",
      cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
      Icon: CheckCircle2,
    },
    disabled: {
      label: "Nonaktif",
      cls: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
      Icon: XCircle,
    },
  }[status];
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border ${map.cls}`}
    >
      <map.Icon className="w-3 h-3" />
      {map.label}
    </span>
  );
}

function RoleBadge({ role }: { role: AdminUserRow["role"] }) {
  if (role === "admin") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-primary/15 text-primary border-primary/30">
        <ShieldCheck className="w-3 h-3" /> Admin
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-muted text-muted-foreground border-border">
      <UserIcon className="w-3 h-3" /> User
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Users(props: { currentUserId: number }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "active" | "disabled">(
    "all"
  );
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isFetching, refetch } = useAdminListUsers({
    query: { queryKey: getAdminListUsersQueryKey(), refetchInterval: 30_000 },
  });

  const update = useAdminUpdateUser({
    mutation: {
      onSettled: () => {
        setBusyId(null);
        qc.invalidateQueries({ queryKey: getAdminListUsersQueryKey() });
      },
      onError: (err: any) => {
        setActionError(err?.data?.error ?? "Gagal memperbarui user");
      },
    },
  });
  const del = useAdminDeleteUser({
    mutation: {
      onSettled: () => {
        setBusyId(null);
        qc.invalidateQueries({ queryKey: getAdminListUsersQueryKey() });
      },
      onError: (err: any) => {
        setActionError(err?.data?.error ?? "Gagal menghapus user");
      },
    },
  });

  const rows = (data as AdminUserRow[] | undefined) ?? [];
  const counts = useMemo(() => {
    return {
      total: rows.length,
      pending: rows.filter((r) => r.status === "pending").length,
      active: rows.filter((r) => r.status === "active").length,
      disabled: rows.filter((r) => r.status === "disabled").length,
    };
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (q && !r.email.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, filter, search]);

  function doUpdate(
    id: number,
    body: { status?: AdminUserRow["status"]; role?: AdminUserRow["role"] }
  ) {
    setActionError(null);
    setBusyId(id);
    update.mutate({ id, data: body });
  }

  function doDelete(id: number, email: string) {
    if (
      !window.confirm(
        `Hapus user "${email}" secara permanen?\n\nSemua data WhatsApp & sesi mereka akan ikut terhapus.`
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyId(id);
    del.mutate({ id });
  }

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Manajemen User</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Setujui pendaftar baru, ubah role, atau nonaktifkan akun.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Muat ulang
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(
          [
            { k: "all", label: "Total", value: counts.total },
            { k: "pending", label: "Menunggu", value: counts.pending },
            { k: "active", label: "Aktif", value: counts.active },
            { k: "disabled", label: "Nonaktif", value: counts.disabled },
          ] as const
        ).map((s) => (
          <button
            key={s.k}
            onClick={() => setFilter(s.k as typeof filter)}
            data-testid={`filter-${s.k}`}
            className={`text-left p-3 rounded-md border bg-card hover-elevate ${
              filter === s.k
                ? "border-primary/60 ring-1 ring-primary/30"
                : "border-border"
            }`}
          >
            <div className="text-[11px] text-muted-foreground uppercase tracking-wide">
              {s.label}
            </div>
            <div className="text-lg font-semibold mt-0.5">{s.value}</div>
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari email..."
            data-testid="search"
            className="w-full h-8 pl-8 pr-3 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      {actionError && (
        <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {actionError}
        </div>
      )}

      <div className="border border-border rounded-md overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">ID</th>
                <th className="text-left px-3 py-2 font-medium">Email</th>
                <th className="text-left px-3 py-2 font-medium">Role</th>
                <th className="text-left px-3 py-2 font-medium">Status</th>
                <th className="text-left px-3 py-2 font-medium">WhatsApp</th>
                <th className="text-left px-3 py-2 font-medium">Daftar</th>
                <th className="text-left px-3 py-2 font-medium">Disetujui</th>
                <th className="text-right px-3 py-2 font-medium">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
                    Memuat...
                  </td>
                </tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground text-xs">
                    Tidak ada user yang cocok dengan filter.
                  </td>
                </tr>
              )}
              {filtered.map((u) => {
                const isSelf = u.id === props.currentUserId;
                const busy = busyId === u.id;
                return (
                  <tr
                    key={u.id}
                    data-testid={`row-${u.id}`}
                    className="border-t border-border hover:bg-muted/30"
                  >
                    <td className="px-3 py-2 text-muted-foreground tabular-nums">
                      {u.id}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {u.email}
                      {isSelf && (
                        <span className="ml-1.5 text-[10px] text-muted-foreground">
                          (Anda)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={u.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {u.ownerPhone ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {fmtDate(u.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {fmtDate(u.approvedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        {busy && (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                        )}
                        {u.status === "pending" && (
                          <button
                            disabled={busy}
                            onClick={() => doUpdate(u.id, { status: "active" })}
                            data-testid={`approve-${u.id}`}
                            className="h-7 px-2 rounded text-[11px] font-medium bg-primary text-primary-foreground hover-elevate disabled:opacity-50"
                          >
                            Setujui
                          </button>
                        )}
                        {u.status === "active" && !isSelf && (
                          <button
                            disabled={busy}
                            onClick={() => doUpdate(u.id, { status: "disabled" })}
                            data-testid={`disable-${u.id}`}
                            className="h-7 px-2 rounded text-[11px] font-medium bg-muted text-foreground hover-elevate disabled:opacity-50"
                          >
                            Nonaktifkan
                          </button>
                        )}
                        {u.status === "disabled" && (
                          <button
                            disabled={busy}
                            onClick={() => doUpdate(u.id, { status: "active" })}
                            data-testid={`enable-${u.id}`}
                            className="h-7 px-2 rounded text-[11px] font-medium bg-emerald-600/80 text-white hover-elevate disabled:opacity-50"
                          >
                            Aktifkan
                          </button>
                        )}
                        {!isSelf && u.status === "active" && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              doUpdate(u.id, {
                                role: u.role === "admin" ? "user" : "admin",
                              })
                            }
                            data-testid={`role-${u.id}`}
                            className="h-7 px-2 rounded text-[11px] font-medium bg-muted text-foreground hover-elevate disabled:opacity-50"
                            title={
                              u.role === "admin"
                                ? "Turunkan ke user biasa"
                                : "Jadikan admin"
                            }
                          >
                            {u.role === "admin" ? "→ User" : "→ Admin"}
                          </button>
                        )}
                        {!isSelf && (
                          <button
                            disabled={busy}
                            onClick={() => doDelete(u.id, u.email)}
                            data-testid={`delete-${u.id}`}
                            className="h-7 w-7 rounded inline-flex items-center justify-center text-destructive hover:bg-destructive/15 disabled:opacity-50"
                            title="Hapus permanen"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Tip: User baru yang mendaftar lewat halaman login MaxiChat akan muncul di
        sini dengan status <strong>Menunggu</strong>. Klik <em>Setujui</em>{" "}
        untuk mengizinkan mereka login.
      </p>
    </div>
  );
}
