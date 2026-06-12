import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAcrConfig,
  getGetAcrConfigQueryKey,
  useUpdateAcrConfig,
  useListAcrTeamMembers,
  getListAcrTeamMembersQueryKey,
  type AcrConfig,
} from "@workspace/api-client-react";
import { ArrowLeft, Loader2, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { usePermissions } from "@/hooks/use-permissions";
import { cn } from "@/lib/utils";

type FormState = {
  weightResponseTime: number;
  weightLanguageQuality: number;
  weightAnswerQuality: number;
  weightComplaintHandling: number;
  weightMissedChat: number;
  slaExcellentMinutes: number;
  slaGoodMinutes: number;
  slaAcceptableMinutes: number;
  slaPoorMinutes: number;
  slaCriticalMinutes: number;
  gradeAThreshold: number;
  gradeBThreshold: number;
  gradeCThreshold: number;
  gradeDThreshold: number;
  allowanceGradeA: number;
  allowanceGradeB: number;
  allowanceGradeC: number;
  allowanceGradeD: number;
  allowanceGradeE: number;
  complaintHandlingEnabled: boolean;
  autoScheduleEnabled: boolean;
  autoScheduleFrequency: "weekly" | "monthly" | "custom";
  autoScheduleDayOfMonth: number;
  autoScheduleDayOfWeek: number;
  autoScheduleEveryDays: number;
  autoScheduleNotifyUserIds: number[];
};

const DEFAULTS: FormState = {
  weightResponseTime: 25,
  weightLanguageQuality: 25,
  weightAnswerQuality: 25,
  weightComplaintHandling: 15,
  weightMissedChat: 10,
  slaExcellentMinutes: 3,
  slaGoodMinutes: 5,
  slaAcceptableMinutes: 15,
  slaPoorMinutes: 30,
  slaCriticalMinutes: 60,
  gradeAThreshold: 90,
  gradeBThreshold: 75,
  gradeCThreshold: 60,
  gradeDThreshold: 45,
  allowanceGradeA: 0,
  allowanceGradeB: 0,
  allowanceGradeC: 0,
  allowanceGradeD: 0,
  allowanceGradeE: 0,
  complaintHandlingEnabled: true,
  autoScheduleEnabled: false,
  autoScheduleFrequency: "monthly",
  autoScheduleDayOfMonth: 1,
  autoScheduleDayOfWeek: 1,
  autoScheduleEveryDays: 30,
  autoScheduleNotifyUserIds: [],
};

function fromConfig(c: AcrConfig): FormState {
  return {
    weightResponseTime: c.weightResponseTime,
    weightLanguageQuality: c.weightLanguageQuality,
    weightAnswerQuality: c.weightAnswerQuality,
    weightComplaintHandling: c.weightComplaintHandling,
    weightMissedChat: c.weightMissedChat,
    slaExcellentMinutes: c.slaExcellentMinutes,
    slaGoodMinutes: c.slaGoodMinutes,
    slaAcceptableMinutes: c.slaAcceptableMinutes,
    slaPoorMinutes: c.slaPoorMinutes,
    slaCriticalMinutes: c.slaCriticalMinutes,
    gradeAThreshold: c.gradeAThreshold,
    gradeBThreshold: c.gradeBThreshold,
    gradeCThreshold: c.gradeCThreshold,
    gradeDThreshold: c.gradeDThreshold,
    allowanceGradeA: c.allowanceGradeA,
    allowanceGradeB: c.allowanceGradeB,
    allowanceGradeC: c.allowanceGradeC,
    allowanceGradeD: c.allowanceGradeD,
    allowanceGradeE: c.allowanceGradeE,
    complaintHandlingEnabled: c.complaintHandlingEnabled,
    autoScheduleEnabled: c.autoScheduleEnabled,
    autoScheduleFrequency:
      c.autoScheduleFrequency === "weekly" || c.autoScheduleFrequency === "custom"
        ? c.autoScheduleFrequency
        : "monthly",
    autoScheduleDayOfMonth: c.autoScheduleDayOfMonth ?? 1,
    autoScheduleDayOfWeek: c.autoScheduleDayOfWeek ?? 1,
    autoScheduleEveryDays: c.autoScheduleEveryDays ?? 30,
    autoScheduleNotifyUserIds: c.autoScheduleNotifyUserIds ?? [],
  };
}

const WEIGHT_ROWS: Array<{
  key: keyof Pick<
    FormState,
    | "weightResponseTime"
    | "weightLanguageQuality"
    | "weightAnswerQuality"
    | "weightComplaintHandling"
    | "weightMissedChat"
  >;
  label: string;
  desc: string;
}> = [
  {
    key: "weightResponseTime",
    label: "Kecepatan Balas",
    desc: "Waktu rata-rata CS merespons pesan customer",
  },
  {
    key: "weightLanguageQuality",
    label: "Kualitas Bahasa",
    desc: "Ejaan, tata bahasa, sopan santun, kejelasan kalimat",
  },
  {
    key: "weightAnswerQuality",
    label: "Ketepatan Jawaban",
    desc: "Relevansi jawaban, tidak rancu, tidak membuat customer bingung",
  },
  {
    key: "weightComplaintHandling",
    label: "Handling Komplain",
    desc: "Kemampuan meredam customer marah/kesal",
  },
  {
    key: "weightMissedChat",
    label: "Chat Tak Terjawab",
    desc: "Persentase pesan customer yang tidak dibalas",
  },
];

const DAY_NAMES = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"];

export default function AIChatReportSettings() {
  const [, navigate] = useLocation();
  const { isSuperAdmin, isLoading: permsLoading } = usePermissions();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<FormState>(DEFAULTS);
  const [resetOpen, setResetOpen] = useState(false);

  // Settings is super_admin only (Section 6.5 self-guard).
  useEffect(() => {
    if (!permsLoading && !isSuperAdmin) navigate("/");
  }, [permsLoading, isSuperAdmin, navigate]);

  const { data: config, isLoading } = useGetAcrConfig({
    query: { queryKey: getGetAcrConfigQueryKey() },
  });
  useEffect(() => {
    if (config) setForm(fromConfig(config));
  }, [config]);

  const { data: members } = useListAcrTeamMembers({
    query: { queryKey: getListAcrTeamMembersQueryKey() },
  });

  const update = useUpdateAcrConfig();

  const totalWeight =
    form.weightResponseTime +
    form.weightLanguageQuality +
    form.weightAnswerQuality +
    form.weightComplaintHandling +
    form.weightMissedChat;

  const slaError = !(
    form.slaExcellentMinutes < form.slaGoodMinutes &&
    form.slaGoodMinutes < form.slaAcceptableMinutes &&
    form.slaAcceptableMinutes < form.slaPoorMinutes &&
    form.slaPoorMinutes < form.slaCriticalMinutes
  );
  const gradeError = !(
    form.gradeAThreshold > form.gradeBThreshold &&
    form.gradeBThreshold > form.gradeCThreshold &&
    form.gradeCThreshold > form.gradeDThreshold &&
    form.gradeDThreshold > 0
  );
  const allowanceError = [
    form.allowanceGradeA,
    form.allowanceGradeB,
    form.allowanceGradeC,
    form.allowanceGradeD,
    form.allowanceGradeE,
  ].some((v) => !Number.isInteger(v) || v < 0);
  const invalid = totalWeight !== 100 || slaError || gradeError || allowanceError;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const numInput = (v: string): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  };

  const save = (state: FormState) => {
    update.mutate(
      { data: state },
      {
        onSuccess: () => {
          toast({
            title: "Konfigurasi tersimpan",
            description:
              "Perubahan berlaku untuk laporan baru. Laporan yang sudah ada memakai snapshot konfigurasi lama.",
          });
          qc.invalidateQueries({ queryKey: getGetAcrConfigQueryKey() });
        },
        onError: (err: unknown) => {
          const e = err as { data?: { error?: string }; message?: string };
          toast({
            title: "Gagal menyimpan",
            description: e?.data?.error ?? e?.message ?? "Terjadi kesalahan.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const nextRunPreview = useMemo(() => {
    if (!form.autoScheduleEnabled) return null;
    if (form.autoScheduleFrequency === "monthly")
      return `Laporan dibuat otomatis setiap tanggal ${form.autoScheduleDayOfMonth}`;
    if (form.autoScheduleFrequency === "weekly")
      return `Laporan dibuat otomatis setiap hari ${DAY_NAMES[form.autoScheduleDayOfWeek - 1] ?? "Senin"}`;
    return `Laporan dibuat otomatis setiap ${form.autoScheduleEveryDays} hari`;
  }, [form]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/ai-chat-report")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-2xl font-semibold">Pengaturan AI Chat Report</h1>
      </div>

      {/* Section 1: Bobot KPI */}
      <Card>
        <CardHeader>
          <CardTitle>Bobot KPI</CardTitle>
          <CardDescription>Total semua bobot harus tepat 100.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {WEIGHT_ROWS.map((row) => (
            <div key={row.key}>
              <div className="mb-1 flex items-center justify-between">
                <div>
                  <Label>{row.label}</Label>
                  <p className="text-xs text-muted-foreground">{row.desc}</p>
                </div>
                <Input
                  type="number"
                  className="w-20 text-right"
                  min={0}
                  max={100}
                  value={form[row.key]}
                  onChange={(e) =>
                    set(row.key, Math.max(0, Math.min(100, numInput(e.target.value))))
                  }
                  data-testid={`acr-${row.key}`}
                />
              </div>
              <Slider
                value={[form[row.key]]}
                min={0}
                max={100}
                step={1}
                onValueChange={([v]) => set(row.key, v ?? 0)}
              />
            </div>
          ))}
          <p
            className={cn(
              "text-sm font-semibold",
              totalWeight === 100 ? "text-emerald-600" : "text-red-500"
            )}
          >
            Total: {totalWeight} / 100 {totalWeight === 100 ? "✓" : "— total bobot harus 100"}
          </p>
        </CardContent>
      </Card>

      {/* Section 2: SLA */}
      <Card>
        <CardHeader>
          <CardTitle>Target Waktu Respons (SLA)</CardTitle>
          <CardDescription>
            Nilai harus naik: Excellent &lt; Good &lt; Acceptable &lt; Poor &lt; Critical.
            Rekomendasi: target Excellent ≤ 3 menit untuk standar layanan premium.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ["slaExcellentMinutes", "Nilai Penuh — Excellent", "skor 100%"],
              ["slaGoodMinutes", "Nilai Baik — Good", "skor 85%"],
              ["slaAcceptableMinutes", "Nilai Cukup — Acceptable", "skor 65%"],
              ["slaPoorMinutes", "Nilai Buruk — Poor", "skor 40%"],
              ["slaCriticalMinutes", "Nilai Kritis — Critical", "skor 0% + Red Flag otomatis"],
            ] as const
          ).map(([key, label, hint]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <Label className="flex-1">{label}</Label>
              <Input
                type="number"
                min={1}
                className="w-24 text-right"
                value={form[key]}
                onChange={(e) => set(key, Math.max(1, numInput(e.target.value)))}
              />
              <span className="w-44 text-xs text-muted-foreground">menit → {hint}</span>
            </div>
          ))}
          {slaError && (
            <p className="text-sm text-red-500">
              Target SLA harus naik dari Excellent ke Critical.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Section 3: Grade thresholds */}
      <Card>
        <CardHeader>
          <CardTitle>Ambang Batas Grade</CardTitle>
          <CardDescription>Grade E otomatis — di bawah Grade D.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ["gradeAThreshold", "Grade A (Excellent)"],
              ["gradeBThreshold", "Grade B (Good)"],
              ["gradeCThreshold", "Grade C (Average)"],
              ["gradeDThreshold", "Grade D (Below Average)"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <Label>{label}</Label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">minimal skor</span>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  className="w-24 text-right"
                  value={form[key]}
                  onChange={(e) =>
                    set(key, Math.max(1, Math.min(100, numInput(e.target.value))))
                  }
                />
              </div>
            </div>
          ))}
          {gradeError && (
            <p className="text-sm text-red-500">Ambang grade harus menurun: A &gt; B &gt; C &gt; D &gt; 0.</p>
          )}
        </CardContent>
      </Card>

      {/* Section 4: Allowance */}
      <Card>
        <CardHeader>
          <CardTitle>Tunjangan Per Grade</CardTitle>
          <CardDescription>Rupiah bulat, tanpa desimal. 0 = tidak dapat tunjangan.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(
            [
              ["allowanceGradeA", "Grade A"],
              ["allowanceGradeB", "Grade B"],
              ["allowanceGradeC", "Grade C"],
              ["allowanceGradeD", "Grade D"],
              ["allowanceGradeE", "Grade E"],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between gap-3">
              <Label>{label}</Label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Rp</span>
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  className="w-40 text-right"
                  value={form[key]}
                  onChange={(e) => set(key, Math.max(0, numInput(e.target.value)))}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Section 5: Opsi tambahan */}
      <Card>
        <CardHeader>
          <CardTitle>Opsi Tambahan</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label>Aktifkan penilaian Handling Komplain</Label>
              <p className="text-xs text-muted-foreground">
                Jika dimatikan, bobot dimensi ini otomatis didistribusikan ke dimensi lain
                secara proporsional.
              </p>
            </div>
            <Switch
              checked={form.complaintHandlingEnabled}
              onCheckedChange={(v) => set("complaintHandlingEnabled", v)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 6: Auto-schedule */}
      <Card>
        <CardHeader>
          <CardTitle>Laporan Otomatis</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <Label>Buat laporan secara otomatis</Label>
            <Switch
              checked={form.autoScheduleEnabled}
              onCheckedChange={(v) => set("autoScheduleEnabled", v)}
            />
          </div>
          {form.autoScheduleEnabled && (
            <>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={form.autoScheduleFrequency === "weekly"}
                    onChange={() => set("autoScheduleFrequency", "weekly")}
                  />
                  Mingguan — setiap
                  <select
                    className="rounded-md border bg-background px-2 py-1"
                    value={form.autoScheduleDayOfWeek}
                    onChange={(e) => set("autoScheduleDayOfWeek", Number(e.target.value))}
                    disabled={form.autoScheduleFrequency !== "weekly"}
                  >
                    {DAY_NAMES.map((d, i) => (
                      <option key={d} value={i + 1}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={form.autoScheduleFrequency === "monthly"}
                    onChange={() => set("autoScheduleFrequency", "monthly")}
                  />
                  Bulanan — setiap tanggal
                  <Input
                    type="number"
                    min={1}
                    max={28}
                    className="w-16"
                    value={form.autoScheduleDayOfMonth}
                    onChange={(e) =>
                      set(
                        "autoScheduleDayOfMonth",
                        Math.max(1, Math.min(28, numInput(e.target.value)))
                      )
                    }
                    disabled={form.autoScheduleFrequency !== "monthly"}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={form.autoScheduleFrequency === "custom"}
                    onChange={() => set("autoScheduleFrequency", "custom")}
                  />
                  Kustom — setiap
                  <Input
                    type="number"
                    min={1}
                    max={90}
                    className="w-16"
                    value={form.autoScheduleEveryDays}
                    onChange={(e) =>
                      set(
                        "autoScheduleEveryDays",
                        Math.max(1, Math.min(90, numInput(e.target.value)))
                      )
                    }
                    disabled={form.autoScheduleFrequency !== "custom"}
                  />
                  hari
                </label>
              </div>
              <div>
                <Label className="mb-1 block">Notifikasi ke</Label>
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-md border p-2">
                  {(members ?? []).map((m) => (
                    <label key={m.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.autoScheduleNotifyUserIds.includes(m.id)}
                        onCheckedChange={(v) =>
                          set(
                            "autoScheduleNotifyUserIds",
                            v
                              ? [...form.autoScheduleNotifyUserIds, m.id]
                              : form.autoScheduleNotifyUserIds.filter((id) => id !== m.id)
                          )
                        }
                      />
                      {m.name ?? m.email}
                    </label>
                  ))}
                  {(members ?? []).length === 0 && (
                    <p className="text-xs text-muted-foreground">Belum ada anggota tim.</p>
                  )}
                </div>
              </div>
              {nextRunPreview && (
                <p className="text-xs text-muted-foreground">
                  {nextRunPreview}
                  {config?.autoScheduleNextRunAt
                    ? ` — berikutnya: ${new Date(config.autoScheduleNextRunAt).toLocaleDateString(
                        "id-ID",
                        { timeZone: "Asia/Jakarta", day: "numeric", month: "long", year: "numeric" }
                      )}`
                    : ""}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <Button variant="outline" onClick={() => setResetOpen(true)}>
          <RotateCcw className="mr-2 h-4 w-4" /> Reset ke Default
        </Button>
        <Button onClick={() => save(form)} disabled={invalid || update.isPending} data-testid="acr-save">
          {update.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Simpan Perubahan
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Perubahan konfigurasi berlaku untuk laporan baru. Laporan yang sudah ada menggunakan
        snapshot konfigurasi saat itu dan tidak berubah.
      </p>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset ke Default?</AlertDialogTitle>
            <AlertDialogDescription>
              Semua bobot, SLA, grade, dan tunjangan akan dikembalikan ke nilai awal dan
              langsung disimpan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setForm(DEFAULTS);
                save(DEFAULTS);
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
