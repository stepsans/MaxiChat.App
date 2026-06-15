import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetPricing,
  useAdminUpdatePricing,
  getAdminGetPricingQueryKey,
  type PricingConfig,
} from "@workspace/api-client-react";
import { Loader2, Save, RefreshCw, Tag, CheckCircle2 } from "lucide-react";

function fmtRp(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

type FieldKey = keyof PricingConfig;

const FIELDS: { key: FieldKey; label: string; unit: string }[] = [
  { key: "dbPricePer500Mb", label: "Penyimpanan Database", unit: "per 500 MB" },
  { key: "userPricePerUser", label: "User Tim (anak)", unit: "per user" },
  { key: "channelPricePer2", label: "Channel", unit: "per 2 channel" },
];

export default function Pricing() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching, refetch } = useAdminGetPricing({
    query: { queryKey: getAdminGetPricingQueryKey() },
  });

  const [form, setForm] = useState<Record<FieldKey, string>>({
    dbPricePer500Mb: "",
    userPricePerUser: "",
    channelPricePer2: "",
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setForm({
        dbPricePer500Mb: String(data.dbPricePer500Mb),
        userPricePerUser: String(data.userPricePerUser),
        channelPricePer2: String(data.channelPricePer2),
      });
    }
  }, [data]);

  const update = useAdminUpdatePricing({
    mutation: {
      onSuccess: () => {
        setSaved(true);
        setError(null);
        qc.invalidateQueries({ queryKey: getAdminGetPricingQueryKey() });
        window.setTimeout(() => setSaved(false), 2500);
      },
      onError: (err: any) => {
        setError(err?.data?.error ?? "Gagal menyimpan harga");
      },
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed: PricingConfig = {
      dbPricePer500Mb: Number(form.dbPricePer500Mb),
      userPricePerUser: Number(form.userPricePerUser),
      channelPricePer2: Number(form.channelPricePer2),
    };
    for (const f of FIELDS) {
      const v = parsed[f.key];
      if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) {
        setError(
          `"${f.label}" harus berupa angka bulat ≥ 0 (Rupiah, tanpa desimal).`
        );
        return;
      }
    }
    update.mutate({ data: parsed });
  }

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Harga Pemakaian
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Tarif global berbasis pemakaian (Rupiah, bilangan bulat). Berlaku
            untuk semua tenant. Tagihan dihitung dari pemakaian aktual tiap
            tenant.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate"
          data-testid="refresh-pricing"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`}
          />
          Muat ulang
        </button>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="border border-border rounded-md bg-card divide-y divide-border">
          {isLoading && (
            <div className="px-4 py-8 text-center text-muted-foreground text-sm">
              <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
              Memuat...
            </div>
          )}
          {!isLoading &&
            FIELDS.map((f) => (
              <div
                key={f.key}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-muted-foreground" />
                    {f.label}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {f.unit}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">Rp</span>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={form[f.key]}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, [f.key]: e.target.value }))
                    }
                    data-testid={`price-${f.key}`}
                    className="w-36 h-9 px-2.5 rounded-md border border-border bg-input text-sm text-right tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
              </div>
            ))}
        </div>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={update.isPending || isLoading}
            data-testid="save-pricing"
            className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
          >
            {update.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            Simpan harga
          </button>
          {saved && (
            <span className="text-xs text-emerald-400 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Tersimpan
            </span>
          )}
        </div>
      </form>

      {data && (
        <p className="text-[11px] text-muted-foreground">
          Contoh saat ini: penyimpanan Rp {fmtRp(data.dbPricePer500Mb)}/500MB,
          user Rp {fmtRp(data.userPricePerUser)}/user, channel Rp{" "}
          {fmtRp(data.channelPricePer2)}/2 channel.
        </p>
      )}
    </div>
  );
}
