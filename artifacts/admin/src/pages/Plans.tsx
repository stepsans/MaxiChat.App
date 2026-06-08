import { Fragment, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminListPlans,
  useAdminCreatePlan,
  useAdminUpdatePlan,
  useAdminDeletePlan,
  getAdminListPlansQueryKey,
  useAdminListAddons,
  useAdminCreateAddon,
  useAdminUpdateAddon,
  useAdminDeleteAddon,
  getAdminListAddonsQueryKey,
  type Plan,
  type Addon,
  type CreatePlanInput,
  type CreateAddonInput,
} from "@workspace/api-client-react";
import {
  Loader2,
  RefreshCw,
  Package,
  PlusCircle,
  Trash2,
  Save,
  X,
  CheckCircle2,
  XCircle,
  Layers,
  Coins,
  Radio,
  UserPlus,
  HardDrive,
} from "lucide-react";

function fmtRp(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

// Storage is stored in BYTES throughout the contract, but the operator enters
// and reads it in GB (binary GiB). These helpers convert at the UI boundary.
const BYTES_PER_GB = 1024 * 1024 * 1024;

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "0";
  const gb = n / BYTES_PER_GB;
  if (gb >= 1) return `${Number(gb.toFixed(gb >= 10 ? 0 : 2))} GB`;
  const mb = n / (1024 * 1024);
  return `${Number(mb.toFixed(mb >= 10 ? 0 : 1))} MB`;
}

function bytesToGbStr(n: number): string {
  if (!n) return "0";
  return String(Number((n / BYTES_PER_GB).toFixed(4)));
}

function gbStrToBytes(s: string): number {
  const gb = Number(s);
  if (!Number.isFinite(gb)) return NaN;
  return Math.round(gb * BYTES_PER_GB);
}

const ADDON_TYPES = [
  { value: "token", label: "Token AI", Icon: Coins },
  { value: "channel", label: "Channel", Icon: Radio },
  { value: "user_seat", label: "Kursi User", Icon: UserPlus },
  { value: "storage", label: "Penyimpanan", Icon: HardDrive },
] as const;

function addonTypeMeta(type: string) {
  return ADDON_TYPES.find((t) => t.value === type) ?? ADDON_TYPES[0];
}

function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
      <CheckCircle2 className="w-3 h-3" /> Aktif
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-zinc-500/15 text-zinc-400 border-zinc-500/30">
      <XCircle className="w-3 h-3" /> Arsip
    </span>
  );
}

type PlanForm = {
  key: string;
  name: string;
  description: string;
  priceIdr: string;
  durationDays: string;
  quotaUsers: string;
  quotaChannels: string;
  quotaTokens: string;
  // Storage quota entered in GB; converted to bytes on submit.
  quotaStorageGb: string;
  // Max retention period (days) tenants on this plan may select. Empty = unlimited.
  retentionLimitDays: string;
  isActive: boolean;
  sortOrder: string;
  // Enterprise-only AI Sales Assistant entitlement.
  hasAiSalesAssistant: boolean;
};

const EMPTY_PLAN_FORM: PlanForm = {
  key: "",
  name: "",
  description: "",
  priceIdr: "0",
  durationDays: "30",
  quotaUsers: "0",
  quotaChannels: "0",
  quotaTokens: "0",
  quotaStorageGb: "0",
  retentionLimitDays: "",
  isActive: true,
  sortOrder: "0",
  hasAiSalesAssistant: false,
};

function planToForm(p: Plan): PlanForm {
  return {
    key: p.key,
    name: p.name,
    description: p.description ?? "",
    priceIdr: String(p.priceIdr),
    durationDays: String(p.durationDays),
    quotaUsers: String(p.quotaUsers),
    quotaChannels: String(p.quotaChannels),
    quotaTokens: String(p.quotaTokens),
    quotaStorageGb: bytesToGbStr(p.quotaStorageBytes),
    retentionLimitDays:
      p.retentionLimitDays == null ? "" : String(p.retentionLimitDays),
    isActive: p.isActive,
    sortOrder: String(p.sortOrder),
    hasAiSalesAssistant: p.hasAiSalesAssistant ?? false,
  };
}

type AddonForm = {
  type: CreateAddonInput["type"];
  name: string;
  unitAmount: string;
  priceIdr: string;
  isActive: boolean;
  sortOrder: string;
};

const EMPTY_ADDON_FORM: AddonForm = {
  type: "token",
  name: "",
  unitAmount: "1",
  priceIdr: "0",
  isActive: true,
  sortOrder: "0",
};

function addonToForm(a: Addon): AddonForm {
  return {
    type: a.type,
    name: a.name,
    unitAmount:
      a.type === "storage" ? bytesToGbStr(a.unitAmount) : String(a.unitAmount),
    priceIdr: String(a.priceIdr),
    isActive: a.isActive,
    sortOrder: String(a.sortOrder),
  };
}

function NumberField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId: string;
  prefix?: string;
  suffix?: string;
  min?: number;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{props.label}</span>
      <div className="flex items-center gap-1.5">
        {props.prefix && (
          <span className="text-xs text-muted-foreground">{props.prefix}</span>
        )}
        <input
          type="number"
          min={props.min ?? 0}
          step={1}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          data-testid={props.testId}
          className="w-full h-9 px-2.5 rounded-md border border-border bg-input text-sm text-right tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
        />
        {props.suffix && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {props.suffix}
          </span>
        )}
      </div>
    </label>
  );
}

export default function Plans() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const plansQuery = useAdminListPlans({
    query: { queryKey: getAdminListPlansQueryKey() },
  });
  const addonsQuery = useAdminListAddons({
    query: { queryKey: getAdminListAddonsQueryKey() },
  });

  const plans = (plansQuery.data as Plan[] | undefined) ?? [];
  const addons = (addonsQuery.data as Addon[] | undefined) ?? [];

  // --- plan editing state ---
  const [editingPlanId, setEditingPlanId] = useState<number | "new" | null>(
    null
  );
  const [planForm, setPlanForm] = useState<PlanForm>(EMPTY_PLAN_FORM);

  // --- addon editing state ---
  const [editingAddonId, setEditingAddonId] = useState<number | "new" | null>(
    null
  );
  const [addonForm, setAddonForm] = useState<AddonForm>(EMPTY_ADDON_FORM);

  function invalidatePlans() {
    qc.invalidateQueries({ queryKey: getAdminListPlansQueryKey() });
  }
  function invalidateAddons() {
    qc.invalidateQueries({ queryKey: getAdminListAddonsQueryKey() });
  }

  const createPlan = useAdminCreatePlan({
    mutation: {
      onSuccess: () => {
        setEditingPlanId(null);
        invalidatePlans();
      },
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal membuat paket"),
    },
  });
  const updatePlan = useAdminUpdatePlan({
    mutation: {
      onSuccess: () => {
        setEditingPlanId(null);
        invalidatePlans();
      },
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal menyimpan paket"),
    },
  });
  const deletePlan = useAdminDeletePlan({
    mutation: {
      onSettled: invalidatePlans,
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal menghapus paket"),
    },
  });

  const createAddon = useAdminCreateAddon({
    mutation: {
      onSuccess: () => {
        setEditingAddonId(null);
        invalidateAddons();
      },
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal membuat add-on"),
    },
  });
  const updateAddon = useAdminUpdateAddon({
    mutation: {
      onSuccess: () => {
        setEditingAddonId(null);
        invalidateAddons();
      },
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal menyimpan add-on"),
    },
  });
  const deleteAddon = useAdminDeleteAddon({
    mutation: {
      onSettled: invalidateAddons,
      onError: (err: any) =>
        setError(err?.data?.error ?? "Gagal menghapus add-on"),
    },
  });

  useEffect(() => {
    document.title = "MaxiChat.App Backend — Paket & Add-on";
  }, []);

  function startNewPlan() {
    setError(null);
    setPlanForm(EMPTY_PLAN_FORM);
    setEditingPlanId("new");
  }
  function startEditPlan(p: Plan) {
    setError(null);
    setPlanForm(planToForm(p));
    setEditingPlanId(p.id);
  }
  function submitPlan(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const nums = {
      priceIdr: Number(planForm.priceIdr),
      durationDays: Number(planForm.durationDays),
      quotaUsers: Number(planForm.quotaUsers),
      quotaChannels: Number(planForm.quotaChannels),
      quotaTokens: Number(planForm.quotaTokens),
      sortOrder: Number(planForm.sortOrder),
    };
    for (const [k, v] of Object.entries(nums)) {
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        setError(`Kolom "${k}" harus berupa angka bulat ≥ 0.`);
        return;
      }
    }
    const quotaStorageBytes = gbStrToBytes(planForm.quotaStorageGb);
    if (
      !Number.isFinite(quotaStorageBytes) ||
      !Number.isInteger(quotaStorageBytes) ||
      quotaStorageBytes < 0
    ) {
      setError("Kuota penyimpanan harus angka ≥ 0 (dalam GB).");
      return;
    }
    if (nums.durationDays < 1) {
      setError("Durasi minimal 1 hari.");
      return;
    }
    const retentionTrim = planForm.retentionLimitDays.trim();
    let retentionLimitDays: number | null = null;
    if (retentionTrim !== "") {
      const r = Number(retentionTrim);
      if (!Number.isFinite(r) || !Number.isInteger(r) || r < 1) {
        setError("Batas retensi harus angka bulat ≥ 1 hari, atau kosong (tanpa batas).");
        return;
      }
      retentionLimitDays = r;
    }
    if (editingPlanId === "new") {
      if (!/^[a-z0-9_]+$/.test(planForm.key.trim())) {
        setError("Key hanya boleh huruf kecil, angka, dan _ (mis. pro_plus).");
        return;
      }
      const body: CreatePlanInput = {
        key: planForm.key.trim(),
        name: planForm.name.trim(),
        description: planForm.description.trim() || undefined,
        priceIdr: nums.priceIdr,
        durationDays: nums.durationDays,
        quotaUsers: nums.quotaUsers,
        quotaChannels: nums.quotaChannels,
        quotaTokens: nums.quotaTokens,
        quotaStorageBytes,
        retentionLimitDays,
        isActive: planForm.isActive,
        sortOrder: nums.sortOrder,
        hasAiSalesAssistant: planForm.hasAiSalesAssistant,
      };
      createPlan.mutate({ data: body });
    } else if (typeof editingPlanId === "number") {
      updatePlan.mutate({
        id: editingPlanId,
        data: {
          name: planForm.name.trim(),
          description: planForm.description.trim() || null,
          priceIdr: nums.priceIdr,
          durationDays: nums.durationDays,
          quotaUsers: nums.quotaUsers,
          quotaChannels: nums.quotaChannels,
          quotaTokens: nums.quotaTokens,
          quotaStorageBytes,
          retentionLimitDays,
          isActive: planForm.isActive,
          sortOrder: nums.sortOrder,
          hasAiSalesAssistant: planForm.hasAiSalesAssistant,
        },
      });
    }
  }
  function doDeletePlan(p: Plan) {
    if (
      !window.confirm(
        `Hapus paket "${p.name}" (key: ${p.key}) secara permanen?\n\nJika paket masih dipakai tenant, penghapusan akan ditolak — arsipkan (nonaktifkan) paket itu sebagai gantinya.`
      )
    )
      return;
    setError(null);
    deletePlan.mutate({ id: p.id });
  }

  function startNewAddon() {
    setError(null);
    setAddonForm(EMPTY_ADDON_FORM);
    setEditingAddonId("new");
  }
  function startEditAddon(a: Addon) {
    setError(null);
    setAddonForm(addonToForm(a));
    setEditingAddonId(a.id);
  }
  function submitAddon(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const unitAmount =
      addonForm.type === "storage"
        ? gbStrToBytes(addonForm.unitAmount)
        : Number(addonForm.unitAmount);
    const priceIdr = Number(addonForm.priceIdr);
    const sortOrder = Number(addonForm.sortOrder);
    if (!Number.isInteger(unitAmount) || unitAmount < 1) {
      setError(
        addonForm.type === "storage"
          ? "Jumlah penyimpanan minimal lebih dari 0 (dalam GB)."
          : "Jumlah unit minimal 1."
      );
      return;
    }
    if (!Number.isInteger(priceIdr) || priceIdr < 0) {
      setError("Harga harus angka bulat ≥ 0.");
      return;
    }
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      setError("Urutan harus angka bulat ≥ 0.");
      return;
    }
    if (!addonForm.name.trim()) {
      setError("Nama add-on wajib diisi.");
      return;
    }
    if (editingAddonId === "new") {
      const body: CreateAddonInput = {
        type: addonForm.type,
        name: addonForm.name.trim(),
        unitAmount,
        priceIdr,
        isActive: addonForm.isActive,
        sortOrder,
      };
      createAddon.mutate({ data: body });
    } else if (typeof editingAddonId === "number") {
      updateAddon.mutate({
        id: editingAddonId,
        data: {
          type: addonForm.type,
          name: addonForm.name.trim(),
          unitAmount,
          priceIdr,
          isActive: addonForm.isActive,
          sortOrder,
        },
      });
    }
  }
  function doDeleteAddon(a: Addon) {
    if (!window.confirm(`Hapus add-on "${a.name}" secara permanen?`)) return;
    setError(null);
    deleteAddon.mutate({ id: a.id });
  }

  const planBusy = createPlan.isPending || updatePlan.isPending;
  const addonBusy = createAddon.isPending || updateAddon.isPending;

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Paket & Add-on
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Katalog langganan yang bisa dibeli tenant. Harga dalam Rupiah
            (bilangan bulat). Paket diarsipkan (bukan dihapus) agar pembelian
            lama tetap valid.
          </p>
        </div>
        <button
          onClick={() => {
            plansQuery.refetch();
            addonsQuery.refetch();
          }}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-catalog"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${
              plansQuery.isFetching || addonsQuery.isFetching
                ? "animate-spin"
                : ""
            }`}
          />
          Muat ulang
        </button>
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      {/* ---- PLANS ---- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Package className="w-4 h-4 text-muted-foreground" />
            Paket Langganan
          </h2>
          <button
            onClick={startNewPlan}
            data-testid="new-plan"
            className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 hover-elevate"
          >
            <PlusCircle className="w-3.5 h-3.5" /> Paket baru
          </button>
        </div>

        {editingPlanId === "new" && (
          <PlanEditor
            title="Paket baru"
            form={planForm}
            setForm={setPlanForm}
            onSubmit={submitPlan}
            onCancel={() => setEditingPlanId(null)}
            busy={planBusy}
            isNew
          />
        )}

        <div className="border border-border rounded-md overflow-hidden bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Paket</th>
                  <th className="text-right px-3 py-2 font-medium">Harga</th>
                  <th className="text-right px-3 py-2 font-medium">Durasi</th>
                  <th className="text-right px-3 py-2 font-medium">User</th>
                  <th className="text-right px-3 py-2 font-medium">Channel</th>
                  <th className="text-right px-3 py-2 font-medium">Token</th>
                  <th className="text-right px-3 py-2 font-medium">Storage</th>
                  <th className="text-right px-3 py-2 font-medium">Retensi</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-right px-3 py-2 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {plansQuery.isLoading && (
                  <tr>
                    <td
                      colSpan={10}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
                      Memuat...
                    </td>
                  </tr>
                )}
                {!plansQuery.isLoading && plans.length === 0 && (
                  <tr>
                    <td
                      colSpan={10}
                      className="px-3 py-8 text-center text-muted-foreground text-xs"
                    >
                      Belum ada paket. Klik "Paket baru" untuk menambah.
                    </td>
                  </tr>
                )}
                {plans.map((p) => (
                  <Fragment key={p.id}>
                    <tr
                      data-testid={`plan-row-${p.id}`}
                      className="border-t border-border hover:bg-muted/30"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-[11px] text-muted-foreground font-mono">
                          {p.key}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        Rp {fmtRp(p.priceIdr)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {p.durationDays} hari
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.quotaUsers}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {p.quotaChannels}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtRp(p.quotaTokens)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {fmtBytes(p.quotaStorageBytes)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {p.retentionLimitDays == null
                          ? "∞"
                          : `${p.retentionLimitDays} hari`}
                      </td>
                      <td className="px-3 py-2">
                        <ActiveBadge active={p.isActive} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => startEditPlan(p)}
                            data-testid={`edit-plan-${p.id}`}
                            className="h-7 px-2 rounded text-[11px] font-medium bg-muted text-foreground hover-elevate"
                          >
                            Ubah
                          </button>
                          <button
                            onClick={() => doDeletePlan(p)}
                            data-testid={`delete-plan-${p.id}`}
                            className="h-7 w-7 rounded inline-flex items-center justify-center text-destructive hover:bg-destructive/15"
                            title="Hapus permanen"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {editingPlanId === p.id && (
                      <tr>
                        <td colSpan={10} className="px-3 py-3 bg-muted/20">
                          <PlanEditor
                            title={`Ubah paket: ${p.name}`}
                            form={planForm}
                            setForm={setPlanForm}
                            onSubmit={submitPlan}
                            onCancel={() => setEditingPlanId(null)}
                            busy={planBusy}
                            isNew={false}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---- ADDONS ---- */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-muted-foreground" />
            Add-on / Top-up
          </h2>
          <button
            onClick={startNewAddon}
            data-testid="new-addon"
            className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 hover-elevate"
          >
            <PlusCircle className="w-3.5 h-3.5" /> Add-on baru
          </button>
        </div>

        {editingAddonId === "new" && (
          <AddonEditor
            title="Add-on baru"
            form={addonForm}
            setForm={setAddonForm}
            onSubmit={submitAddon}
            onCancel={() => setEditingAddonId(null)}
            busy={addonBusy}
          />
        )}

        <div className="border border-border rounded-md overflow-hidden bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Add-on</th>
                  <th className="text-left px-3 py-2 font-medium">Jenis</th>
                  <th className="text-right px-3 py-2 font-medium">Per unit</th>
                  <th className="text-right px-3 py-2 font-medium">Harga</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-right px-3 py-2 font-medium">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {addonsQuery.isLoading && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
                      Memuat...
                    </td>
                  </tr>
                )}
                {!addonsQuery.isLoading && addons.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-8 text-center text-muted-foreground text-xs"
                    >
                      Belum ada add-on. Klik "Add-on baru" untuk menambah.
                    </td>
                  </tr>
                )}
                {addons.map((a) => {
                  const meta = addonTypeMeta(a.type);
                  return (
                    <Fragment key={a.id}>
                      <tr
                        data-testid={`addon-row-${a.id}`}
                        className="border-t border-border hover:bg-muted/30"
                      >
                        <td className="px-3 py-2 font-medium">{a.name}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border bg-muted text-muted-foreground border-border">
                            <meta.Icon className="w-3 h-3" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {a.type === "storage"
                            ? fmtBytes(a.unitAmount)
                            : fmtRp(a.unitAmount)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          Rp {fmtRp(a.priceIdr)}
                        </td>
                        <td className="px-3 py-2">
                          <ActiveBadge active={a.isActive} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => startEditAddon(a)}
                              data-testid={`edit-addon-${a.id}`}
                              className="h-7 px-2 rounded text-[11px] font-medium bg-muted text-foreground hover-elevate"
                            >
                              Ubah
                            </button>
                            <button
                              onClick={() => doDeleteAddon(a)}
                              data-testid={`delete-addon-${a.id}`}
                              className="h-7 w-7 rounded inline-flex items-center justify-center text-destructive hover:bg-destructive/15"
                              title="Hapus permanen"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {editingAddonId === a.id && (
                        <tr>
                          <td colSpan={6} className="px-3 py-3 bg-muted/20">
                            <AddonEditor
                              title={`Ubah add-on: ${a.name}`}
                              form={addonForm}
                              setForm={setAddonForm}
                              onSubmit={submitAddon}
                              onCancel={() => setEditingAddonId(null)}
                              busy={addonBusy}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function PlanEditor(props: {
  title: string;
  form: PlanForm;
  setForm: React.Dispatch<React.SetStateAction<PlanForm>>;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
  isNew: boolean;
}) {
  const { form, setForm } = props;
  return (
    <form
      onSubmit={props.onSubmit}
      className="border border-border rounded-md bg-card p-4 space-y-4"
      data-testid="plan-editor"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:bg-muted"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">
            Key{" "}
            {!props.isNew && (
              <span className="text-muted-foreground">(tidak bisa diubah)</span>
            )}
          </span>
          <input
            value={form.key}
            disabled={!props.isNew}
            onChange={(e) =>
              setForm((p) => ({ ...p, key: e.target.value.toLowerCase() }))
            }
            placeholder="mis. pro"
            data-testid="plan-key"
            className="w-full h-9 px-2.5 rounded-md border border-border bg-input text-sm font-mono outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Nama</span>
          <input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="mis. Pro"
            data-testid="plan-name"
            className="w-full h-9 px-2.5 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-muted-foreground">
          Deskripsi (opsional)
        </span>
        <textarea
          value={form.description}
          onChange={(e) =>
            setForm((p) => ({ ...p, description: e.target.value }))
          }
          rows={2}
          data-testid="plan-description"
          className="w-full px-2.5 py-2 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40 resize-y"
        />
      </label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <NumberField
          label="Harga"
          prefix="Rp"
          value={form.priceIdr}
          onChange={(v) => setForm((p) => ({ ...p, priceIdr: v }))}
          testId="plan-priceIdr"
        />
        <NumberField
          label="Durasi"
          suffix="hari"
          min={1}
          value={form.durationDays}
          onChange={(v) => setForm((p) => ({ ...p, durationDays: v }))}
          testId="plan-durationDays"
        />
        <NumberField
          label="Urutan"
          value={form.sortOrder}
          onChange={(v) => setForm((p) => ({ ...p, sortOrder: v }))}
          testId="plan-sortOrder"
        />
        <NumberField
          label="Kuota User"
          value={form.quotaUsers}
          onChange={(v) => setForm((p) => ({ ...p, quotaUsers: v }))}
          testId="plan-quotaUsers"
        />
        <NumberField
          label="Kuota Channel"
          value={form.quotaChannels}
          onChange={(v) => setForm((p) => ({ ...p, quotaChannels: v }))}
          testId="plan-quotaChannels"
        />
        <NumberField
          label="Kuota Token"
          value={form.quotaTokens}
          onChange={(v) => setForm((p) => ({ ...p, quotaTokens: v }))}
          testId="plan-quotaTokens"
        />
        <NumberField
          label="Kuota Penyimpanan"
          suffix="GB"
          value={form.quotaStorageGb}
          onChange={(v) => setForm((p) => ({ ...p, quotaStorageGb: v }))}
          testId="plan-quotaStorageGb"
        />
        <NumberField
          label="Batas Retensi"
          suffix="hari"
          min={1}
          placeholder="tanpa batas"
          value={form.retentionLimitDays}
          onChange={(v) => setForm((p) => ({ ...p, retentionLimitDays: v }))}
          testId="plan-retentionLimitDays"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(e) =>
            setForm((p) => ({ ...p, isActive: e.target.checked }))
          }
          data-testid="plan-isActive"
          className="w-4 h-4"
        />
        Aktif (tampil di checkout)
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.hasAiSalesAssistant}
          onChange={(e) =>
            setForm((p) => ({ ...p, hasAiSalesAssistant: e.target.checked }))
          }
          data-testid="plan-hasAiSalesAssistant"
          className="w-4 h-4"
        />
        AI Sales Assistant (khusus Enterprise)
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={props.busy}
          data-testid="save-plan"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {props.busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-9 px-4 rounded-md bg-muted text-sm font-medium hover-elevate"
        >
          Batal
        </button>
      </div>
    </form>
  );
}

function AddonEditor(props: {
  title: string;
  form: AddonForm;
  setForm: React.Dispatch<React.SetStateAction<AddonForm>>;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { form, setForm } = props;
  return (
    <form
      onSubmit={props.onSubmit}
      className="border border-border rounded-md bg-card p-4 space-y-4"
      data-testid="addon-editor"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{props.title}</h3>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-7 w-7 rounded inline-flex items-center justify-center text-muted-foreground hover:bg-muted"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Jenis</span>
          <select
            value={form.type}
            onChange={(e) =>
              setForm((p) => ({
                ...p,
                type: e.target.value as AddonForm["type"],
              }))
            }
            data-testid="addon-type"
            className="w-full h-9 px-2.5 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
          >
            {ADDON_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Nama</span>
          <input
            value={form.name}
            onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            placeholder="mis. +100rb Token"
            data-testid="addon-name"
            className="w-full h-9 px-2.5 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <NumberField
          label="Jumlah per pembelian"
          suffix={form.type === "storage" ? "GB" : undefined}
          min={form.type === "storage" ? 0 : 1}
          value={form.unitAmount}
          onChange={(v) => setForm((p) => ({ ...p, unitAmount: v }))}
          testId="addon-unitAmount"
        />
        <NumberField
          label="Harga"
          prefix="Rp"
          value={form.priceIdr}
          onChange={(v) => setForm((p) => ({ ...p, priceIdr: v }))}
          testId="addon-priceIdr"
        />
        <NumberField
          label="Urutan"
          value={form.sortOrder}
          onChange={(v) => setForm((p) => ({ ...p, sortOrder: v }))}
          testId="addon-sortOrder"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.isActive}
          onChange={(e) =>
            setForm((p) => ({ ...p, isActive: e.target.checked }))
          }
          data-testid="addon-isActive"
          className="w-4 h-4"
        />
        Aktif (tampil di checkout)
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={props.busy}
          data-testid="save-addon"
          className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {props.busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          Simpan
        </button>
        <button
          type="button"
          onClick={props.onCancel}
          className="h-9 px-4 rounded-md bg-muted text-sm font-medium hover-elevate"
        >
          Batal
        </button>
      </div>
    </form>
  );
}
