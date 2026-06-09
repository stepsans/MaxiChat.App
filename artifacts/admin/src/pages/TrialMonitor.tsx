import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

interface TrialTenant {
  id: number;
  email: string;
  name: string | null;
  companyName: string | null;
  businessVolume: string | null;
  businessTeamSize: string | null;
  trialEndsAt: string | null;
  trialDaysLeft: number;
  healthScore: number;
  riskLevel: "low" | "medium" | "high";
  waConnected: boolean;
  productAdded: boolean;
  teamMemberAdded: boolean;
  firstMessageAt: string | null;
  aiTriedAt: string | null;
  flowActivated: boolean;
  lastCsFollowUpAt: string | null;
}

function RiskBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    high: "bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-400",
    medium:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-400",
    low: "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-semibold ${colors[level] ?? ""}`}
    >
      {level.toUpperCase()}
    </span>
  );
}

function ProgressBar({ score }: { score: number }) {
  const color =
    score >= 70 ? "bg-green-500" : score >= 40 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-muted rounded-full h-2">
        <div className={`h-2 rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-mono w-8 text-right tabular-nums">{score}</span>
    </div>
  );
}

function CheckIcon({ done }: { done: boolean }) {
  return (
    <span className={done ? "text-green-500" : "text-muted-foreground/40"}>
      {done ? "✓" : "○"}
    </span>
  );
}

export default function TrialMonitor() {
  const [tenants, setTenants] = useState<TrialTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "high" | "medium" | "low">("all");
  const [grantModal, setGrantModal] = useState<{
    userId: number;
    email: string;
  } | null>(null);
  const [grantDays, setGrantDays] = useState(7);
  const [grantNote, setGrantNote] = useState("");
  const [granting, setGranting] = useState(false);

  const loadTenants = () => {
    setLoading(true);
    fetch("/api/admin/trial-monitor", { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        setTenants(data.tenants ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadTenants();
  }, []);

  const filtered = tenants.filter(
    (t) => filter === "all" || t.riskLevel === filter
  );

  const handleGrantTrial = async () => {
    if (!grantModal) return;
    setGranting(true);
    try {
      await fetch(`/api/admin/users/${grantModal.userId}/grant-trial`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trialDays: grantDays, note: grantNote }),
      });
      setGrantModal(null);
      setGrantNote("");
      setGrantDays(7);
      loadTenants();
    } finally {
      setGranting(false);
    }
  };

  const volumeLabels: Record<string, string> = {
    lt50: "< 50 msg/hari",
    "50to200": "50–200 msg/hari",
    "200to500": "200–500 msg/hari",
    gt500: "> 500 msg/hari",
  };
  const teamLabels: Record<string, string> = {
    solo: "Solo",
    "2to5": "2–5 orang",
    "6to20": "6–20 orang",
    gt20: "> 20 orang",
  };

  if (loading) {
    return (
      <div className="p-8 text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Memuat data trial...
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Trial Monitor</h1>
      <p className="text-muted-foreground text-sm mb-6">
        {tenants.length} tenant aktif trial —{" "}
        {tenants.filter((t) => t.riskLevel === "high").length} high risk
      </p>

      {/* Filter */}
      <div className="flex gap-2 mb-4">
        {(["all", "high", "medium", "low"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            data-testid={`filter-${f}`}
            className={`px-3 py-1 rounded text-sm font-medium border ${
              filter === f
                ? "bg-foreground text-background border-foreground"
                : "bg-card text-muted-foreground border-border hover-elevate"
            }`}
          >
            {f === "all" ? "Semua" : f.charAt(0).toUpperCase() + f.slice(1)}{" "}
            {f !== "all" &&
              `(${tenants.filter((t) => t.riskLevel === f).length})`}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground">
                Tenant
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground">
                Profil Bisnis
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground">
                Sisa Trial
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground">
                Health Score
              </th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">
                WA
              </th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">
                Produk
              </th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">
                Pesan
              </th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">
                AI
              </th>
              <th className="px-4 py-3 text-center font-semibold text-muted-foreground">
                Tim
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground">
                Aksi
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => (
              <tr
                key={t.id}
                className="border-t border-border hover:bg-muted/40"
                data-testid={`trial-row-${t.id}`}
              >
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground">
                    {t.companyName || t.name || "—"}
                  </div>
                  <div className="text-muted-foreground text-xs">{t.email}</div>
                  <div className="mt-1">
                    <RiskBadge level={t.riskLevel} />
                  </div>
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  <div className="text-xs">
                    {t.businessVolume ? volumeLabels[t.businessVolume] : "—"}
                  </div>
                  <div className="text-xs">
                    {t.businessTeamSize ? teamLabels[t.businessTeamSize] : "—"}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`font-mono font-bold ${
                      t.trialDaysLeft <= 1
                        ? "text-red-600 dark:text-red-400"
                        : t.trialDaysLeft <= 3
                        ? "text-yellow-600 dark:text-yellow-400"
                        : "text-foreground"
                    }`}
                  >
                    {t.trialDaysLeft}h
                  </span>
                </td>
                <td className="px-4 py-3 min-w-[120px]">
                  <ProgressBar score={t.healthScore} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={t.waConnected} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={t.productAdded} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={!!t.firstMessageAt} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={!!t.aiTriedAt} />
                </td>
                <td className="px-4 py-3 text-center">
                  <CheckIcon done={t.teamMemberAdded} />
                </td>
                <td className="px-4 py-3">
                  <button
                    onClick={() =>
                      setGrantModal({ userId: t.id, email: t.email })
                    }
                    data-testid={`grant-trial-${t.id}`}
                    className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/20"
                  >
                    Grant Trial
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={10}
                  className="px-4 py-8 text-center text-muted-foreground"
                >
                  Tidak ada tenant dengan filter ini.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Grant Trial Modal */}
      {grantModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card border border-border rounded-lg p-6 w-96 shadow-xl">
            <h2 className="font-bold text-lg mb-1">Grant Trial Baru</h2>
            <p className="text-muted-foreground text-sm mb-4">
              {grantModal.email}
            </p>
            <label className="block text-sm font-medium text-foreground mb-1">
              Durasi Trial (hari)
            </label>
            <input
              type="number"
              min={1}
              max={30}
              value={grantDays}
              onChange={(e) => setGrantDays(Number(e.target.value))}
              data-testid="grant-days-input"
              className="w-full bg-background border border-border rounded px-3 py-2 mb-3 text-sm"
            />
            <label className="block text-sm font-medium text-foreground mb-1">
              Catatan (opsional)
            </label>
            <textarea
              value={grantNote}
              onChange={(e) => setGrantNote(e.target.value)}
              placeholder="Alasan grant trial..."
              data-testid="grant-note-input"
              className="w-full bg-background border border-border rounded px-3 py-2 mb-4 text-sm h-20 resize-none"
            />
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setGrantModal(null)}
                disabled={granting}
                className="px-4 py-2 text-sm rounded border border-border hover-elevate"
              >
                Batal
              </button>
              <button
                onClick={handleGrantTrial}
                disabled={granting}
                data-testid="confirm-grant-trial"
                className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5 disabled:opacity-60"
              >
                {granting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Grant Trial
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
