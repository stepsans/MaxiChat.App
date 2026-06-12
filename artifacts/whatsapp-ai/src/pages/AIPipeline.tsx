import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  useListAiPipelines,
  useToggleAiPipeline,
  useDeleteAiPipeline,
  useUpdateAiPipeline,
  getListAiPipelinesQueryKey,
  getGetPipelineHealthQueryKey,
  type AiPipeline,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  Plus,
  Eye,
  Pencil,
  Power,
  MoreVertical,
  ShieldAlert,
  Trash2,
  Clock,
  Zap,
  Target,
  AlertTriangle,
  Loader2,
  Info,
  TrendingUp,
  Users,
  CalendarClock,
  BarChart3,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ─── Types for info-stats API ─────────────────────────────────────────────────

interface InfoStats {
  pipeline: {
    id: number;
    name: string;
    scoreThreshold: number;
    autoFollowupEnabled: boolean;
    followupIntervals: string[];
    cutoffTimes: string[];
    directionFilter: boolean;
    channels: Array<{ id: number; name: string; type: string }>;
    excludeLabels: Array<{ id: number; name: string }>;
    customPrompt: string | null;
    promptLastUpdatedAt: string | null;
    promptLastUpdatedBy: string | null;
  };
  stats: {
    activeContacts: number;
    lateFollowups: number;
    totalEstimatedValue: number;
    analyzedToday: number;
  };
  scoreBreakdownExplanation: {
    threshold: number;
    thresholdCategory: string;
    thresholdColor: string;
  };
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function formatRupiah(v: number): string {
  if (v === 0) return "Rp 0";
  if (v >= 1_000_000_000) return `Rp ${(v / 1_000_000_000).toFixed(1)}M`;
  if (v >= 1_000_000) return `Rp ${(v / 1_000_000).toFixed(1)} Jt`;
  if (v >= 1_000) return `Rp ${(v / 1_000).toFixed(0)} Rb`;
  return `Rp ${v}`;
}

// ─── Collapsible section ──────────────────────────────────────────────────────

function InfoSection({
  heading,
  children,
  defaultOpen = true,
}: {
  heading: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="font-semibold text-sm">{heading}</span>
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="px-4 py-4 space-y-3 text-sm">{children}</div>}
    </div>
  );
}

// ─── Score category helpers ───────────────────────────────────────────────────

function scoreCategory(v: number): { label: string; color: string } {
  if (v <= 40) return { label: "Dingin", color: "#EF4444" };
  if (v <= 60) return { label: "Hangat", color: "#F59E0B" };
  if (v <= 79) return { label: "Potensial", color: "#3B82F6" };
  return { label: "Panas", color: "#10B981" };
}

// ─── PipelineInfoModal ────────────────────────────────────────────────────────

function PipelineInfoModal({
  pipeline,
  open,
  onClose,
}: {
  pipeline: AiPipeline;
  open: boolean;
  onClose: () => void;
}) {
  const [, navigate] = useLocation();
  const [data, setData] = useState<InfoStats | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ai-pipeline/${pipeline.id}/info-stats`, { credentials: "include" });
      if (res.ok) setData(await res.json());
    } finally {
      setLoading(false);
    }
  }, [pipeline.id]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const cat = scoreCategory(pipeline.scoreThreshold);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Info className="h-4 w-4 text-primary shrink-0" />
            Cara Kerja — {pipeline.name}
          </DialogTitle>
          <DialogDescription>
            Panduan lengkap tentang bagaimana AI menganalisa, menghitung skor, dan menentukan
            siapa yang masuk ke pipeline ini.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 mt-2">

          {/* SECTION 1 — Kondisi saat ini */}
          <InfoSection heading="Kondisi Saat Ini">
            {loading || !data ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 rounded-lg" />
                ))}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {[
                    { icon: Users, label: "Kontak Aktif", value: String(data.stats.activeContacts), hint: "Belum ditutup" },
                    { icon: CalendarClock, label: "Follow-up Terlambat", value: String(data.stats.lateFollowups), hint: "Jadwal sudah lewat", accent: data.stats.lateFollowups > 0 ? "#EF4444" : undefined },
                    { icon: TrendingUp, label: "Est. Total Nilai", value: formatRupiah(data.stats.totalEstimatedValue), hint: "Dari kontak aktif" },
                    { icon: BarChart3, label: "Dianalisa Hari Ini", value: String(data.stats.analyzedToday), hint: "Percakapan diproses AI" },
                  ].map(({ icon: Icon, label, value, hint, accent }) => (
                    <div key={label} className="rounded-lg border bg-card p-3 space-y-1">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <Icon className="h-3.5 w-3.5" />
                        <span className="text-[11px]">{label}</span>
                      </div>
                      <p className="text-2xl font-bold leading-none" style={accent ? { color: accent } : undefined}>{value}</p>
                      <p className="text-[10px] text-muted-foreground">{hint}</p>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground space-y-2 leading-relaxed">
                  <p><strong className="text-foreground">Kontak Aktif</strong> adalah kontak yang masuk pipeline dan statusnya belum Closed Won, Closed Lost, atau Jangan Follow-up.</p>
                  {data.stats.lateFollowups > 0 && (
                    <p><strong className="text-destructive">Follow-up Terlambat</strong> artinya sistem sudah menjadwalkan pesan otomatis tapi jadwalnya sudah lewat dan belum terkirim — biasanya karena pipeline sedang nonaktif. Buka tab <strong className="text-foreground">Pipeline Entries</strong> untuk mengirim manual.</p>
                  )}
                  <p><strong className="text-foreground">Estimasi Total Nilai</strong> berasal dari analisa AI yang memperkirakan nilai transaksi berdasarkan produk yang disebutkan dalam percakapan.</p>
                </div>
              </>
            )}
          </InfoSection>

          {/* SECTION 2 — Cara AI membaca percakapan */}
          <InfoSection heading="Bagaimana AI Membaca Percakapan">
            <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">
              <p>
                Pipeline ini berjalan otomatis{" "}
                <strong className="text-foreground">{pipeline.cutoffTimes.length}x sehari</strong> pada jam{" "}
                <strong className="text-foreground">{pipeline.cutoffTimes.join(" & ")}</strong>.
                Setiap kali jadwal tiba, AI membaca semua percakapan dari channel yang kamu pilih
                {data && data.pipeline.channels.length > 0 && (
                  <> (<strong className="text-foreground">{data.pipeline.channels.map((c) => c.name).join(", ")}</strong>)</>
                )} selama periode waktu sebelumnya.
              </p>
              <p>
                AI membaca percakapan seperti seorang analis penjualan berpengalaman — memperhatikan
                kata-kata yang digunakan customer, seberapa antusias mereka, apakah mereka bertanya
                tentang harga atau cara beli, dan apakah ada hambatan yang membuat mereka ragu.
              </p>
              {pipeline.directionFilter && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-blue-800">
                  <strong>Filter arah percakapan aktif:</strong> AI hanya menganalisa percakapan di
                  mana customer yang aktif bertanya ke kamu, bukan sebaliknya. Kalau kamu yang
                  menghubungi supplier atau pihak lain, percakapan itu diabaikan otomatis. Ini
                  mencegah percakapan pembelian kamu sendiri dianggap sebagai prospek.
                </div>
              )}
            </div>
          </InfoSection>

          {/* SECTION 3 — Cara AI menghitung skor */}
          <InfoSection heading="Cara AI Menghitung Skor (0–100)" defaultOpen={false}>
            <p className="text-xs text-muted-foreground mb-3">Skor dihitung dari 6 komponen. Total maksimal = 100.</p>
            <div className="space-y-3">
              {[
                {
                  title: "Sinyal Beli", max: "30 poin",
                  desc: "Mengukur seberapa jelas customer menunjukkan niat untuk membeli.",
                  rows: [
                    ["25–30", "Menyebut harga spesifik, minta invoice, konfirmasi mau beli"],
                    ["15–24", "Tanya detail harga, cara pembayaran, info produk spesifik"],
                    ["5–14", "Menyebut nama produk, tanya ketersediaan, minta katalog"],
                    ["0–4", "Hanya salam atau pertanyaan umum, belum ada sinyal beli"],
                  ],
                },
                {
                  title: "Urgensi", max: "20 poin",
                  desc: "Mengukur seberapa mendesak kebutuhan customer.",
                  rows: [
                    ["17–20", 'Menyebut "hari ini", "sekarang", "segera", atau deadline spesifik'],
                    ["10–16", '"Minggu ini", "bulan ini", ada kebutuhan yang cukup mendesak'],
                    ["5–9", '"Nanti", "dalam waktu dekat", tidak terlalu mendesak'],
                    ["0–4", "Tidak ada urgensi, customer hanya browsing atau iseng tanya"],
                  ],
                },
                {
                  title: "Keterlibatan", max: "20 poin",
                  desc: "Mengukur seberapa aktif dan serius customer terlibat dalam percakapan.",
                  rows: [
                    ["17–20", "Percakapan panjang, banyak pertanyaan spesifik, aktif bolak-balik"],
                    ["10–16", "Beberapa pertanyaan relevan, ada diskusi dua arah"],
                    ["5–9", "Sedikit pertanyaan, respons singkat tapi masih relevan"],
                    ["0–4", "Jawaban satu kata, tidak banyak engage"],
                  ],
                },
                {
                  title: "Komitmen", max: "15 poin",
                  desc: "Mengukur seberapa jauh customer menunjukkan kesediaan untuk melangkah maju.",
                  rows: [
                    ["13–15", '"Oke saya mau", "transfer ke mana", minta jadwal, konfirmasi'],
                    ["8–12", "Menyatakan minat jelas, meminta tindak lanjut dari agent"],
                    ["4–7", "Tertarik tapi masih ragu, ada pertanyaan atau keberatan"],
                    ["0–3", "Belum ada komitmen sama sekali"],
                  ],
                },
                {
                  title: "Kesesuaian Produk", max: "10 poin",
                  desc: "Mengukur apakah produk yang diminati customer sesuai dengan yang kamu jual.",
                  rows: [
                    ["9–10", "Produk yang diminati persis ada di katalog kamu"],
                    ["6–8", "Produk yang diminati ada dengan sedikit penyesuaian"],
                    ["3–5", "Ada kebutuhan yang bisa dipenuhi tapi tidak langsung"],
                    ["0–2", "Produk tidak sesuai atau kamu tidak menjualnya"],
                  ],
                },
                {
                  title: "Penyesuaian Hambatan", max: "−5 hingga +5 poin",
                  desc: "Satu-satunya komponen yang bisa bernilai negatif. Mengukur apakah ada hambatan yang mengurangi kemungkinan closing.",
                  rows: [
                    ["+5", "Semua keberatan sudah terjawab, customer sangat antusias"],
                    ["+1–+4", "Ada keberatan kecil tapi sudah ditangani dengan baik"],
                    ["0", "Tidak ada hambatan berarti"],
                    ["−1–−4", "Ada keberatan yang belum terselesaikan (harga mahal, ragu kualitas)"],
                    ["−5", "Hambatan besar: pakai kompetitor, tidak punya budget, tidak butuh"],
                  ],
                },
              ].map(({ title, max, desc, rows }) => (
                <div key={title} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{title}</span>
                    <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{max}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{desc}</p>
                  <table className="w-full text-xs">
                    <tbody>
                      {rows.map(([score, meaning]) => (
                        <tr key={score} className="border-t first:border-t-0">
                          <td className="py-1 pr-3 font-mono text-muted-foreground whitespace-nowrap w-16">{score}</td>
                          <td className="py-1 text-muted-foreground">{meaning}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            <div className="rounded-lg bg-muted/40 border p-3 text-xs space-y-1">
              <p className="font-medium text-foreground">Rumus total:</p>
              <p className="text-muted-foreground font-mono">
                Total = Sinyal Beli (30) + Urgensi (20) + Keterlibatan (20) + Komitmen (15) + Kesesuaian (10) + Hambatan (±5) = maks 100
              </p>
            </div>
          </InfoSection>

          {/* SECTION 4 — Kapan kontak masuk */}
          <InfoSection heading="Kapan Kontak Masuk ke Pipeline">
            <div className="space-y-3 text-sm leading-relaxed">
              <p className="text-muted-foreground">
                Setelah AI menghitung skor, sistem membandingkan hasilnya dengan ambang batas yang kamu tetapkan.
              </p>
              <div className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                <Target className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <p className="font-medium">Ambang batas pipeline ini: skor ≥ <span style={{ color: cat.color }}>{pipeline.scoreThreshold}</span></p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Kontak dengan skor di bawah {pipeline.scoreThreshold} tetap dicatat di tab Hasil Analisa tapi tidak masuk pipeline.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { range: "0–40", label: "Dingin", color: "#EF4444", desc: "Belum ada sinyal jelas" },
                  { range: "41–60", label: "Hangat", color: "#F59E0B", desc: "Ada minat, belum kuat" },
                  { range: "61–79", label: "Potensial", color: "#3B82F6", desc: "Sinyal positif cukup kuat" },
                  { range: "80–100", label: "Panas", color: "#10B981", desc: "Sangat siap beli" },
                ].map(({ range, label, color, desc }) => {
                  const [lo, hi] = range.split("–").map(Number);
                  const active = pipeline.scoreThreshold >= lo && pipeline.scoreThreshold <= hi;
                  return (
                  <div
                    key={label}
                    className={cn("rounded-lg border p-2.5 text-center space-y-1")}
                    style={active ? { outline: `2px solid ${color}`, outlineOffset: "2px" } : undefined}
                  >
                    <div className="w-3 h-3 rounded-full mx-auto" style={{ backgroundColor: color }} />
                    <p className="font-semibold text-xs" style={{ color }}>{label}</p>
                    <p className="text-[10px] text-muted-foreground font-mono">{range}</p>
                    <p className="text-[10px] text-muted-foreground leading-tight">{desc}</p>
                  </div>
                  );
                })}
              </div>

              <p className="text-xs text-muted-foreground">
                Pipeline ini aktif menerima kontak mulai skor{" "}
                <strong style={{ color: cat.color }}>{pipeline.scoreThreshold}</strong>,
                kategori <strong style={{ color: cat.color }}>{cat.label}</strong>.
              </p>
            </div>
          </InfoSection>

          {/* SECTION 5 — Follow-up terlambat */}
          <InfoSection heading="Apa Itu Follow-up Terlambat?" defaultOpen={false}>
            <div className="space-y-2 text-sm text-muted-foreground leading-relaxed">
              <p>
                <strong className="text-foreground">Follow-up terlambat</strong> artinya sistem sudah menjadwalkan
                pengiriman pesan otomatis untuk menghubungi kembali kontak tertentu, tapi jadwal pengirimannya
                sudah lewat dan pesan belum berhasil dikirim.
              </p>
              <p className="font-medium text-foreground">Kenapa ini bisa terjadi?</p>
              <ol className="list-decimal list-inside space-y-1 ml-1">
                <li><strong className="text-foreground">Pipeline dinonaktifkan</strong> — semua follow-up otomatis dijeda. Saat diaktifkan kembali, sistem akan mengirim yang tertunda.</li>
                <li><strong className="text-foreground">Gangguan koneksi channel</strong> — kalau WhatsApp atau channel lain sedang terputus, pesan tidak bisa terkirim.</li>
                <li><strong className="text-foreground">Kontak tidak bisa dihubungi</strong> — nomor tidak aktif atau sudah memblokir.</li>
              </ol>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-800">
                <strong>Yang harus dilakukan:</strong> Buka tab <strong>Pipeline Entries</strong>, filter status
                "Follow-up Terlambat", lalu kirim secara manual atau tandai sebagai tidak perlu follow-up.
                {data && data.stats.lateFollowups > 0 && (
                  <span> Pipeline ini saat ini punya <strong>{data.stats.lateFollowups} kontak</strong> dengan follow-up terlambat.</span>
                )}
              </div>
            </div>
          </InfoSection>

          {/* SECTION 6 — Konfigurasi */}
          <InfoSection heading="Konfigurasi Pipeline Ini" defaultOpen={false}>
            {loading || !data ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-5 w-full" />)}
              </div>
            ) : (
              <div className="space-y-3">
                <dl className="space-y-2 text-sm">
                  {[
                    ["Channel dianalisa", data.pipeline.channels.length > 0 ? data.pipeline.channels.map((c) => c.name).join(", ") : "—"],
                    ["Label dikecualikan", data.pipeline.excludeLabels.length > 0 ? data.pipeline.excludeLabels.map((l) => l.name).join(", ") : "Tidak ada"],
                    ["Jadwal analisa", `${data.pipeline.cutoffTimes.join(", ")} — ${data.pipeline.cutoffTimes.length}x sehari`],
                    ["Ambang skor masuk", `${data.pipeline.scoreThreshold} (${data.scoreBreakdownExplanation.thresholdCategory})`],
                    ["Auto follow-up", data.pipeline.autoFollowupEnabled ? `Aktif — ${(data.pipeline.followupIntervals as string[]).join(", ")}` : "Nonaktif"],
                    ["Filter percakapan", data.pipeline.directionFilter ? "Hanya incoming (customer → kamu)" : "Semua arah"],
                    ["AI Prompt", data.pipeline.customPrompt ? `Custom — terakhir diubah ${data.pipeline.promptLastUpdatedAt ? new Date(data.pipeline.promptLastUpdatedAt).toLocaleDateString("id-ID") : "—"} oleh ${data.pipeline.promptLastUpdatedBy ?? "—"}` : "Menggunakan prompt bawaan"],
                  ].map(([key, val]) => (
                    <div key={key} className="flex gap-3">
                      <dt className="text-muted-foreground shrink-0 w-44">{key}</dt>
                      <dd className="font-medium">{val}</dd>
                    </div>
                  ))}
                </dl>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => { onClose(); navigate(`/ai-pipeline/${pipeline.id}`); }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit Konfigurasi
                </Button>
              </div>
            )}
          </InfoSection>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatLastRun(lastRunAt: string | null | undefined): string {
  if (!lastRunAt) return "Belum pernah dijalankan";
  const date = new Date(lastRunAt);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins} menit lalu`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours} jam lalu`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} hari lalu`;
}

function formatCutoffTimes(times: string[]): string {
  return `${times.length}x/hari · ${times.join(" & ")}`;
}

function PipelineCardSkeleton() {
  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div className="flex items-start justify-between">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-5 w-16" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex gap-4">
        <Skeleton className="h-12 w-20" />
        <Skeleton className="h-12 w-20" />
        <Skeleton className="h-12 w-20" />
      </div>
    </div>
  );
}

function PipelineCard({ pipeline }: { pipeline: AiPipeline }) {
  const [, navigate] = useLocation();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [staleDraft, setStaleDraft] = useState("");
  const [highValueDraft, setHighValueDraft] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  useEffect(() => {
    if (riskOpen) {
      setStaleDraft(String(pipeline.staleDaysThreshold));
      setHighValueDraft(String(pipeline.highValueThresholdIdr));
    }
  }, [riskOpen, pipeline.staleDaysThreshold, pipeline.highValueThresholdIdr]);

  const { mutate: updatePipeline, isPending: savingRisk } = useUpdateAiPipeline({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetPipelineHealthQueryKey() });
        setRiskOpen(false);
        toast({ description: "Setelan risiko disimpan." });
      },
      onError: () => {
        toast({ variant: "destructive", description: "Gagal menyimpan setelan risiko." });
      },
    },
  });

  function submitRisk() {
    const stale = Number(staleDraft);
    const highValue = Number(highValueDraft);
    if (!Number.isInteger(stale) || stale < 1 || stale > 365) {
      toast({ variant: "destructive", description: "Hari tidak aktif harus bilangan bulat 1–365." });
      return;
    }
    if (!Number.isInteger(highValue) || highValue < 0) {
      toast({ variant: "destructive", description: "Nilai minimum harus bilangan bulat ≥ 0." });
      return;
    }
    updatePipeline({
      id: pipeline.id,
      data: {
        name: pipeline.name,
        channelIds: pipeline.channelIds,
        staleDaysThreshold: stale,
        highValueThresholdIdr: highValue,
      },
    });
  }

  const { mutate: toggle, isPending: toggling } = useToggleAiPipeline({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        toast({ title: pipeline.isActive ? "Pipeline dinonaktifkan" : "Pipeline diaktifkan" });
      },
    },
  });

  const { mutate: deletePipeline, isPending: deleting } = useDeleteAiPipeline({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        toast({ title: "Pipeline dihapus" });
        setDeleteOpen(false);
      },
      onError: () => {
        toast({ title: "Gagal menghapus pipeline", variant: "destructive" });
      },
    },
  });

  const stats = pipeline.todayStats ?? { analyzed: 0, enteredPipeline: 0 };

  return (
    <>
      <div className="rounded-xl border bg-card p-5 hover:shadow-md transition-shadow flex flex-col gap-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2 min-w-0">
            <BrainCircuit className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div className="min-w-0">
              <h3 className="font-semibold text-base leading-tight truncate">{pipeline.name}</h3>
              {pipeline.description && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{pipeline.description}</p>
              )}
            </div>
          </div>
          <Badge
            className={cn(
              "shrink-0 text-xs",
              pipeline.isActive
                ? "bg-green-100 text-green-700 border-green-200"
                : "bg-muted text-muted-foreground"
            )}
          >
            {pipeline.isActive ? "Aktif" : "Nonaktif"}
          </Badge>
        </div>

        {/* Meta */}
        <div className="text-sm text-muted-foreground space-y-1">
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5" />
            <span>{pipeline.channelIds.length} Channel dianalisa</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Target className="h-3.5 w-3.5" />
            <span>Min. skor: {pipeline.scoreThreshold}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            <span>{formatCutoffTimes(pipeline.cutoffTimes)}</span>
          </div>
        </div>

        {/* Today stats */}
        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "Dianalisa", value: stats.analyzed },
            { label: "Masuk Pipeline", value: stats.enteredPipeline },
          ].map(({ label, value }) => (
            <div key={label} className="rounded-lg bg-muted/50 p-2 text-center">
              <p className="text-xl font-bold">{value}</p>
              <p className="text-[10px] text-muted-foreground leading-tight">{label}</p>
            </div>
          ))}
        </div>

        {/* Last run + actions */}
        <div className="flex items-center justify-between pt-1 border-t">
          <span className="text-xs text-muted-foreground">
            Terakhir: {formatLastRun(pipeline.lastRunAt)}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 text-muted-foreground hover:text-primary"
              onClick={() => setInfoOpen(true)}
              title="Cara kerja pipeline ini"
            >
              <Info className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => navigate(`/ai-pipeline/${pipeline.id}`)}
              title="Lihat detail"
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => navigate(`/ai-pipeline/${pipeline.id}/edit`)}
              title="Edit konfigurasi"
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className={cn("h-8 w-8", pipeline.isActive ? "text-green-600" : "text-muted-foreground")}
              onClick={() => toggle({ id: pipeline.id })}
              disabled={toggling}
              title={pipeline.isActive ? "Nonaktifkan" : "Aktifkan"}
            >
              <Power className="h-4 w-4" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setRiskOpen(true)}>
                  <ShieldAlert className="h-4 w-4 mr-2 text-destructive" />
                  Setelan Risiko
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Hapus Pipeline
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Info modal */}
      <PipelineInfoModal
        pipeline={pipeline}
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
      />

      {/* Per-pipeline risk settings */}
      <Dialog open={riskOpen} onOpenChange={setRiskOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-destructive" />
              Setelan Risiko — {pipeline.name}
            </DialogTitle>
            <DialogDescription>
              Peluang dari pipeline ini akan ditandai berisiko tinggi jika
              memenuhi kedua kriteria di bawah.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-1.5">
              <Label htmlFor={`stale-${pipeline.id}`}>Tidak aktif selama (hari)</Label>
              <Input
                id={`stale-${pipeline.id}`}
                type="number"
                min={1}
                max={365}
                value={staleDraft}
                onChange={(e) => setStaleDraft(e.target.value)}
                placeholder="14"
              />
              <p className="text-xs text-muted-foreground">
                Peluang tanpa aktivitas ≥ N hari dianggap stagnan. Rentang: 1–365.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`highval-${pipeline.id}`}>Nilai minimum (Rupiah)</Label>
              <Input
                id={`highval-${pipeline.id}`}
                type="number"
                min={0}
                step={1000}
                value={highValueDraft}
                onChange={(e) => setHighValueDraft(e.target.value)}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">
                Hanya peluang dengan estimasi nilai ≥ angka ini yang masuk
                hitungan. Isi <strong>0</strong> agar semua nilai ikut terdeteksi.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRiskOpen(false)} disabled={savingRisk}>
              Batal
            </Button>
            <Button onClick={submitRisk} disabled={savingRisk}>
              {savingRisk ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : null}
              Simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus Pipeline?</AlertDialogTitle>
            <AlertDialogDescription>
              Pipeline <strong>{pipeline.name}</strong> akan dihapus permanen beserta semua
              data analisa dan entries. Tindakan ini tidak dapat dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deletePipeline({ id: pipeline.id })}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default function AIPipelinePage() {
  const [, navigate] = useLocation();
  const { data: pipelines, isLoading, isError } = useListAiPipelines();

  if (isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-9 w-36" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <PipelineCardSkeleton />
          <PipelineCardSkeleton />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 max-w-5xl mx-auto flex flex-col items-center gap-3 mt-12">
        <AlertTriangle className="h-10 w-10 text-destructive" />
        <p className="text-muted-foreground">Gagal memuat data pipeline.</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Coba Lagi
        </Button>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BrainCircuit className="h-6 w-6 text-primary" />
            AI Pipeline
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Analisa percakapan otomatis dan masukkan prospek ke pipeline penjualan
          </p>
        </div>
        <Button onClick={() => navigate("/ai-pipeline/new")} className="gap-2 shrink-0">
          <Plus className="h-4 w-4" />
          Buat Pipeline Baru
        </Button>
      </div>

      {/* Empty state */}
      {!pipelines || pipelines.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-4 py-20 border-2 border-dashed rounded-xl">
          <div className="p-4 rounded-full bg-primary/10">
            <BrainCircuit className="h-10 w-10 text-primary" />
          </div>
          <div className="text-center">
            <p className="font-semibold text-lg">Belum ada AI Pipeline</p>
            <p className="text-muted-foreground text-sm mt-1 max-w-sm">
              Buat pipeline pertama Anda untuk mulai menganalisa percakapan secara otomatis
              dan menemukan prospek bernilai tinggi.
            </p>
          </div>
          <Button onClick={() => navigate("/ai-pipeline/new")} className="gap-2 mt-2">
            <Plus className="h-4 w-4" />
            Buat Pipeline Pertama
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {pipelines.map((pipeline) => (
            <PipelineCard key={pipeline.id} pipeline={pipeline} />
          ))}
        </div>
      )}
    </div>
  );
}
