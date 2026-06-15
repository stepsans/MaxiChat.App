import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useAdminGetPlatformAi,
  useAdminUpdatePlatformAi,
  useAdminUpdatePlatformAiEngine,
  useAdminTestPlatformAiEngine,
  useAdminReorderPlatformAiEngines,
  useAdminGetPlatformAiMargin,
  getAdminGetPlatformAiQueryKey,
  getAdminGetPlatformAiMarginQueryKey,
  type PlatformAiEngineView,
  type PlatformAiMarginView,
} from "@workspace/api-client-react";
import {
  Loader2,
  Save,
  Plug,
  CheckCircle2,
  XCircle,
  Bot,
  ChevronUp,
  ChevronDown,
  Circle,
  TrendingUp,
} from "lucide-react";

type EngineName = "deepseek" | "gemini" | "openai" | "anthropic";

function fmtNum(n: number): string {
  return new Intl.NumberFormat("id-ID").format(n);
}

const ENGINE_LABELS: Record<string, string> = {
  deepseek: "DeepSeek",
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
};

// Owner margin & reconciliation (SPEC BAGIAN 14): revenue vs COGS per engine.
function MarginPanel() {
  const { data, isLoading } = useAdminGetPlatformAiMargin({
    query: { queryKey: getAdminGetPlatformAiMarginQueryKey(), refetchInterval: 120_000, retry: false },
  });
  const m = data as PlatformAiMarginView | undefined;

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium flex items-center gap-2">
        <TrendingUp className="w-4 h-4" /> Margin & Rekonsiliasi
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1.5">
        Revenue (kredit, sudah markup) vs biaya dasar per mesin. COGS Rupiah sebenarnya dicocokkan manual ke invoice
        tiap penyedia memakai total token di bawah.
      </p>

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Memuat margin…</div>
      ) : (
        <div className="border border-border rounded-md bg-card px-4 py-3 space-y-3">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-[11px] text-muted-foreground">Revenue top-up</div>
              <div className="text-sm font-semibold tabular-nums">Rp {fmtNum(m?.revenueIdr ?? 0)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">Margin (kredit)</div>
              <div className="text-sm font-semibold tabular-nums text-emerald-400">{fmtNum(m?.totals.marginCredits ?? 0)}</div>
            </div>
            <div>
              <div className="text-[11px] text-muted-foreground">Margin %</div>
              <div className="text-sm font-semibold tabular-nums">{m?.totals.marginPct ?? 0}%</div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3 font-medium">Mesin</th>
                  <th className="py-2 pr-3 font-medium text-right">Panggilan</th>
                  <th className="py-2 pr-3 font-medium text-right">Token</th>
                  <th className="py-2 pr-3 font-medium text-right">Revenue</th>
                  <th className="py-2 pr-3 font-medium text-right">Biaya</th>
                  <th className="py-2 font-medium text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {(m?.perEngine ?? []).length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-3 text-center text-xs text-muted-foreground">
                      Belum ada pemakaian AI berbayar.
                    </td>
                  </tr>
                ) : (
                  (m?.perEngine ?? []).map((e) => (
                    <tr key={e.engine} className="border-b border-border/50">
                      <td className="py-2 pr-3">{ENGINE_LABELS[e.engine] ?? e.engine}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-xs">{fmtNum(e.calls)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-xs">{fmtNum(e.totalTokens)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{fmtNum(e.revenueCredits)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{fmtNum(e.costCredits)}</td>
                      <td className="py-2 text-right tabular-nums text-emerald-400">
                        {fmtNum(e.marginCredits)} <span className="text-muted-foreground">({e.marginPct}%)</span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="text-[11px] text-muted-foreground border-t border-border pt-2 flex flex-wrap gap-x-4 gap-y-1">
            <span>Rekonsiliasi ledger —</span>
            <span>Pemakaian: {fmtNum(m?.reconciliation.usageCredits ?? 0)}</span>
            <span>Top-up: {fmtNum(m?.reconciliation.topupCredits ?? 0)}</span>
            <span>Hibah: {fmtNum(m?.reconciliation.grantCredits ?? 0)}</span>
            <span>Hangus: {fmtNum(m?.reconciliation.expireCredits ?? 0)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const ENGINE_HINTS: Record<EngineName, { baseUrl: string; model: string; keyHint: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash", keyHint: "sk-…" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    model: "gemini-2.5-flash",
    keyHint: "AIza…",
  },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", keyHint: "sk-…" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1/", model: "claude-sonnet-4-6", keyHint: "sk-ant-…" },
};

const inputCls =
  "w-full h-9 px-2.5 rounded-md border border-border bg-input text-sm outline-none focus:ring-2 focus:ring-primary/40";

function HealthBadge({ engine }: { engine: PlatformAiEngineView }) {
  const map: Record<string, { cls: string; label: string }> = {
    healthy: { cls: "text-emerald-400", label: "healthy" },
    unhealthy: { cls: "text-destructive", label: "unhealthy" },
    unknown: { cls: "text-muted-foreground", label: "unknown" },
  };
  const s = map[engine.health] ?? map.unknown;
  const skip =
    engine.unhealthyUntil && new Date(engine.unhealthyUntil).getTime() > Date.now()
      ? ` · dilewati s/d ${new Date(engine.unhealthyUntil).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
      : "";
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${s.cls}`} title={engine.lastError ?? ""}>
      <Circle className="w-2 h-2 fill-current" /> {s.label}
      {skip && <span className="text-muted-foreground">{skip}</span>}
    </span>
  );
}

// One engine block: editable credentials + per-engine test/save + reorder.
function EngineBlock({
  engine,
  index,
  total,
  onMove,
  hasApiKeyHint,
}: {
  engine: PlatformAiEngineView;
  index: number;
  total: number;
  onMove: (dir: -1 | 1) => void;
  hasApiKeyHint: boolean;
}) {
  const qc = useQueryClient();
  const name = engine.engine as EngineName;
  const hint = ENGINE_HINTS[name];

  const [baseUrl, setBaseUrl] = useState(engine.baseUrl ?? "");
  const [model, setModel] = useState(engine.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [credit, setCredit] = useState(String(engine.creditPer1kToken));
  const [isEnabled, setIsEnabled] = useState(engine.isEnabled);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-sync local form when the server row changes (e.g. after reorder/refetch).
  useEffect(() => {
    setBaseUrl(engine.baseUrl ?? "");
    setModel(engine.model ?? "");
    setCredit(String(engine.creditPer1kToken));
    setIsEnabled(engine.isEnabled);
    setApiKey("");
  }, [engine.baseUrl, engine.model, engine.creditPer1kToken, engine.isEnabled]);

  const update = useAdminUpdatePlatformAiEngine({
    mutation: {
      onSuccess: () => {
        setSaved(true);
        setError(null);
        qc.invalidateQueries({ queryKey: getAdminGetPlatformAiQueryKey() });
        window.setTimeout(() => setSaved(false), 2500);
      },
      onError: (err: any) => setError(err?.data?.error ?? "Gagal menyimpan engine"),
    },
  });

  const testMut = useAdminTestPlatformAiEngine({
    mutation: {
      onSuccess: (res: any) => setTest(res),
      onError: (err: any) => setTest({ ok: false, message: err?.data?.error ?? "Gagal menghubungi mesin" }),
    },
  });

  function onSave() {
    setError(null);
    const creditNum = Math.round(Number(credit));
    if (!Number.isFinite(creditNum) || creditNum < 1) {
      setError("Kredit / 1k token harus ≥ 1.");
      return;
    }
    const data: Record<string, unknown> = {
      baseUrl: baseUrl.trim() || null,
      model: model.trim() || null,
      isEnabled,
      creditPer1kToken: creditNum,
    };
    if (apiKey.trim()) data.apiKey = apiKey.trim();
    update.mutate({ engine: name, data: data as any });
  }

  function onTest() {
    setTest(null);
    testMut.mutate({
      engine: name,
      data: { apiKey: apiKey.trim() || null, baseUrl: baseUrl.trim() || null, model: model.trim() || null } as any,
    });
  }

  return (
    <div className="border border-border rounded-md bg-card px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label="Naikkan prioritas"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => onMove(1)}
              disabled={index === total - 1}
              className="text-muted-foreground hover:text-foreground disabled:opacity-30"
              aria-label="Turunkan prioritas"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
          <div>
            <div className="text-sm font-medium">
              #{engine.priority} {engine.label}
            </div>
            <HealthBadge engine={engine} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Aktif
          <input type="checkbox" checked={isEnabled} onChange={(e) => setIsEnabled(e.target.checked)} className="h-4 w-4" />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground">Base URL</label>
          <input className={inputCls} value={baseUrl} placeholder={hint.baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Model ID</label>
          <input className={inputCls} value={model} placeholder={hint.model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">API Key</label>
          <input
            type="password"
            className={inputCls}
            value={apiKey}
            placeholder={hasApiKeyHint ? `Tersimpan: ${engine.apiKeyMask ?? "••••"} — kosongkan untuk pertahankan` : hint.keyHint}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Kredit / 1k token</label>
          <input type="number" min={1} step={1} className={inputCls} value={credit} onChange={(e) => setCredit(e.target.value)} />
        </div>
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">{error}</div>
      )}
      {test && (
        <div
          className={`text-xs rounded-md px-3 py-2 border flex items-center gap-1.5 ${
            test.ok
              ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
              : "text-destructive bg-destructive/10 border-destructive/30"
          }`}
        >
          {test.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
          {test.message}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onTest}
          disabled={testMut.isPending}
          className="h-8 px-3 rounded-md bg-muted text-xs font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {testMut.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plug className="w-3.5 h-3.5" />}
          Tes koneksi
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={update.isPending}
          className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
        >
          {update.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Simpan
        </button>
        {saved && (
          <span className="text-xs text-emerald-400 flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5" /> Tersimpan
          </span>
        )}
      </div>
    </div>
  );
}

export default function MesinAi() {
  const qc = useQueryClient();
  const { data, isLoading } = useAdminGetPlatformAi({
    query: { queryKey: getAdminGetPlatformAiQueryKey() },
  });

  // Global knobs.
  const [isActive, setIsActive] = useState(false);
  const [autoFailover, setAutoFailover] = useState(true);
  const [autoFailback, setAutoFailback] = useState(true);
  const [unhealthyMin, setUnhealthyMin] = useState("5");
  const [markupPct, setMarkupPct] = useState("50");
  const [minStop, setMinStop] = useState("0");
  const [bothFailedRetry, setBothFailedRetry] = useState(true);
  const [globalSaved, setGlobalSaved] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setIsActive(data.isActive);
    setAutoFailover(data.autoFailover);
    setAutoFailback(data.autoFailback);
    setUnhealthyMin(String(data.unhealthyMinutes));
    setMarkupPct(String(Math.round(data.markupBps / 100)));
    setMinStop(String(data.minStopCredits));
    setBothFailedRetry(data.bothFailedRetry);
  }, [data]);

  const updateGlobal = useAdminUpdatePlatformAi({
    mutation: {
      onSuccess: () => {
        setGlobalSaved(true);
        setGlobalError(null);
        qc.invalidateQueries({ queryKey: getAdminGetPlatformAiQueryKey() });
        window.setTimeout(() => setGlobalSaved(false), 2500);
      },
      onError: (err: any) => setGlobalError(err?.data?.error ?? "Gagal menyimpan konfigurasi"),
    },
  });

  const reorder = useAdminReorderPlatformAiEngines({
    mutation: {
      onSuccess: () => qc.invalidateQueries({ queryKey: getAdminGetPlatformAiQueryKey() }),
    },
  });

  function onSaveGlobal(e: React.FormEvent) {
    e.preventDefault();
    setGlobalError(null);
    const markup = Number(markupPct);
    const minutes = Math.round(Number(unhealthyMin));
    if (!Number.isFinite(markup) || markup < 0) {
      setGlobalError("Markup harus angka ≥ 0.");
      return;
    }
    if (!Number.isFinite(minutes) || minutes < 1) {
      setGlobalError("Menit unhealthy harus ≥ 1.");
      return;
    }
    updateGlobal.mutate({
      data: {
        isActive,
        autoFailover,
        autoFailback,
        unhealthyMinutes: minutes,
        markupBps: Math.round(markup * 100),
        minStopCredits: Math.round(Number(minStop)),
        bothFailedRetry,
      } as any,
    });
  }

  // Move an engine up/down by swapping with its neighbour, then persist the order.
  function moveEngine(engines: PlatformAiEngineView[], from: number, dir: -1 | 1) {
    const to = from + dir;
    if (to < 0 || to >= engines.length) return;
    const order = engines.map((e) => e.engine);
    [order[from], order[to]] = [order[to]!, order[from]!];
    reorder.mutate({ data: { order: order as EngineName[] } as any });
  }

  const engines = data?.engines ?? [];

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
          <Bot className="w-5 h-5" /> Mesin AI Platform
        </h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          Empat mesin AI berprioritas dengan kredensial Anda yang dipakai SEMUA tenant. Saat #1 gagal, sistem otomatis
          beralih ke #2 → #3 → #4. Tagihan AI masuk ke Anda; Anda tagih ulang ke tenant lewat kredit. API key disimpan
          terenkripsi & tak pernah ditampilkan utuh.
        </p>
      </div>

      {isLoading ? (
        <div className="px-4 py-8 text-center text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" /> Memuat...
        </div>
      ) : (
        <>
          {/* Global config */}
          <form onSubmit={onSaveGlobal} className="space-y-4">
            <label className="flex items-center justify-between gap-4 border border-border rounded-md bg-card px-4 py-3">
              <div>
                <div className="text-sm font-medium">Aktifkan mesin platform</div>
                <div className="text-[11px] text-muted-foreground">
                  Saat aktif, semua tenant memakai mesin ini dengan failover berprioritas.
                </div>
              </div>
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4" />
            </label>

            <div className="border border-border rounded-md bg-card px-4 py-3 grid grid-cols-2 gap-3">
              <label className="flex items-center justify-between gap-2 text-sm">
                Auto-failover
                <input type="checkbox" checked={autoFailover} onChange={(e) => setAutoFailover(e.target.checked)} className="h-4 w-4" />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                Auto-failback
                <input type="checkbox" checked={autoFailback} onChange={(e) => setAutoFailback(e.target.checked)} className="h-4 w-4" />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm col-span-2">
                Coba ulang 1× jika semua gagal
                <input type="checkbox" checked={bothFailedRetry} onChange={(e) => setBothFailedRetry(e.target.checked)} className="h-4 w-4" />
              </label>
              <div>
                <label className="text-xs text-muted-foreground">Unhealthy (menit)</label>
                <input type="number" min={1} step={1} className={inputCls} value={unhealthyMin} onChange={(e) => setUnhealthyMin(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Markup (%)</label>
                <input type="number" min={0} step={1} className={inputCls} value={markupPct} onChange={(e) => setMarkupPct(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Saldo minimum stop (kredit)</label>
                <input type="number" min={0} step={1} className={inputCls} value={minStop} onChange={(e) => setMinStop(e.target.value)} />
              </div>
            </div>

            {globalError && (
              <div className="text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
                {globalError}
              </div>
            )}

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={updateGlobal.isPending}
                className="h-9 px-4 rounded-md bg-primary text-primary-foreground text-sm font-medium flex items-center gap-1.5 hover-elevate disabled:opacity-60"
              >
                {updateGlobal.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Simpan konfigurasi
              </button>
              {globalSaved && (
                <span className="text-xs text-emerald-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Tersimpan
                </span>
              )}
            </div>
          </form>

          {/* Engines (priority-ordered) */}
          <div className="space-y-1.5">
            <div className="text-sm font-medium flex items-center gap-2">
              Mesin berprioritas
              {reorder.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
            </div>
            <p className="text-[11px] text-muted-foreground">Atur urutan #1–#4 dengan tombol ▲▼. #1 dipakai utama; sisanya siaga.</p>
          </div>
          <div className="space-y-3">
            {engines.map((e, i) => (
              <EngineBlock
                key={e.engine}
                engine={e}
                index={i}
                total={engines.length}
                hasApiKeyHint={e.hasApiKey}
                onMove={(dir) => moveEngine(engines, i, dir)}
              />
            ))}
          </div>

          <MarginPanel />
        </>
      )}
    </div>
  );
}
