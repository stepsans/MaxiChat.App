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
import AcrAdvancedSettings from "./AcrAdvancedSettings";

type FormState = {
  weightResponseTime: number;
  weightLanguageQuality: number;
  weightAnswerQuality: number;
  weightComplaintHandling: number;
  weightMissedChat: number;
  responseTimeSubweight: number;
  consistencySubweight: number;
  missedChatSubweight: number;
  leadCoverageSubweight: number;
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
  includeOwnerInEvaluation: boolean;
  // Global filter & action defaults (Section 5b).
  defaultLeadStatuses: ("lead" | "not_lead" | "unknown")[];
  defaultChatStatuses: ("ai_handled" | "needs_human" | "closed")[];
  defaultGeneratePdf: boolean;
  defaultSendWhatsappPdf: boolean;
  defaultNotifyUserIds: number[];
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
  responseTimeSubweight: 80,
  consistencySubweight: 20,
  missedChatSubweight: 60,
  leadCoverageSubweight: 40,
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
  includeOwnerInEvaluation: false,
  defaultLeadStatuses: ["lead", "unknown"],
  defaultChatStatuses: [],
  defaultGeneratePdf: true,
  defaultSendWhatsappPdf: false,
  defaultNotifyUserIds: [],
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
    responseTimeSubweight: c.responseTimeSubweight ?? 80,
    consistencySubweight: c.consistencySubweight ?? 20,
    missedChatSubweight: c.missedChatSubweight ?? 60,
    leadCoverageSubweight: c.leadCoverageSubweight ?? 40,
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
    includeOwnerInEvaluation: c.includeOwnerInEvaluation ?? false,
    defaultLeadStatuses: c.defaultLeadStatuses ?? ["lead", "unknown"],
    defaultChatStatuses: c.defaultChatStatuses ?? [],
    defaultGeneratePdf: c.defaultGeneratePdf ?? true,
    defaultSendWhatsappPdf: c.defaultSendWhatsappPdf ?? false,
    defaultNotifyUserIds: c.defaultNotifyUserIds ?? [],
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
    desc: "Kemampuan meredam customer tidak puas",
  },
  {
    key: "weightMissedChat",
    label: "Chat Tak Terjawab",
    desc: "Persentase pesan customer yang tidak dibalas",
  },
];

// Sub-weight pairs (Section 4.5 / 4.6). Each pair must total 100; editing one
// side auto-adjusts the other. Keyed by the parent dimension's weight key.
type SubKey =
  | "responseTimeSubweight"
  | "consistencySubweight"
  | "missedChatSubweight"
  | "leadCoverageSubweight";

const SUBWEIGHTS: Partial<
  Record<
    "weightResponseTime" | "weightMissedChat",
    { primary: [SubKey, string]; secondary: [SubKey, string]; hint: string }
  >
> = {
  weightResponseTime: {
    primary: ["responseTimeSubweight", "Response Time Murni"],
    secondary: ["consistencySubweight", "Konsistensi Aktif Harian"],
    hint: "Agent cepat balas tapi hanya aktif sebagian hari kerja → skor kecepatan balas dikurangi dari porsi konsistensi.",
  },
  weightMissedChat: {
    primary: ["missedChatSubweight", "Chat Tak Terjawab"],
    secondary: ["leadCoverageSubweight", "Lead Status Coverage %"],
    hint: "0 chat terlewat tapi banyak kontak tanpa lead status → skor dimensi ini tidak sempurna.",
  },
};

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
  const { data: teamMembers } = useListAcrTeamMembers({
    query: { queryKey: getListAcrTeamMembersQueryKey() },
  });
  useEffect(() => {
    if (config) setForm(fromConfig(config));
  }, [config]);

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
  const rtSubError = form.responseTimeSubweight + form.consistencySubweight !== 100;
  const missedSubError = form.missedChatSubweight + form.leadCoverageSubweight !== 100;
  const invalid =
    totalWeight !== 100 ||
    slaError ||
    gradeError ||
    allowanceError ||
    rtSubError ||
    missedSubError;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Edit one sub-weight; the partner is forced to the complement so the pair
  // always totals 100 (Section 2.1 invariant).
  const setSubPair = (changed: SubKey, partner: SubKey, value: number) => {
    const v = Math.max(0, Math.min(100, value));
    setForm((f) => ({ ...f, [changed]: v, [partner]: 100 - v }));
  };

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
              {SUBWEIGHTS[row.key as "weightResponseTime" | "weightMissedChat"] &&
                (() => {
                  const sw = SUBWEIGHTS[row.key as "weightResponseTime" | "weightMissedChat"]!;
                  const sum = form[sw.primary[0]] + form[sw.secondary[0]];
                  return (
                    <div className="mt-3 ml-1 space-y-2 border-l-2 border-border/60 pl-3">
                      <p className="text-xs font-medium text-foreground/70">
                        Sub-bobot (total harus 100)
                      </p>
                      {[sw.primary, sw.secondary].map(([k, l]) => (
                        <div key={k} className="flex items-center justify-between gap-2">
                          <Label className="text-xs font-normal">{l}</Label>
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            className="h-8 w-20 text-right"
                            value={form[k]}
                            onChange={(e) =>
                              setSubPair(
                                k,
                                k === sw.primary[0] ? sw.secondary[0] : sw.primary[0],
                                numInput(e.target.value)
                              )
                            }
                            data-testid={`acr-${k}`}
                          />
                        </div>
                      ))}
                      <p
                        className={cn(
                          "text-xs",
                          sum === 100 ? "text-emerald-600" : "text-red-500"
                        )}
                      >
                        Total sub: {sum} / 100 {sum === 100 ? "✓" : "— harus 100"}
                      </p>
                      <p className="text-[11px] text-muted-foreground">ℹ️ {sw.hint}</p>
                    </div>
                  );
                })()}
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
          <div className="mt-4 flex items-center justify-between gap-3">
            <div>
              <Label>Ikutkan super admin dalam penilaian</Label>
              <p className="text-xs text-muted-foreground">
                Super admin tenant ini ikut dinilai sebagai agent. Berguna saat super admin
                menangani chat sendiri atau untuk testing. Pesan lama tanpa atribusi agent
                juga akan dihitung sebagai milik super admin saat aktif.
              </p>
            </div>
            <Switch
              checked={form.includeOwnerInEvaluation}
              onCheckedChange={(v) => set("includeOwnerInEvaluation", v)}
              data-testid="acr-include-owner"
            />
          </div>
        </CardContent>
      </Card>

      {/* Section 5b: Default Filter Global */}
      <Card>
        <CardHeader>
          <CardTitle>Default Filter Global</CardTitle>
          <CardDescription>
            Setelan awal untuk SEMUA laporan baru (Manual maupun Otomatis). Bisa diubah per
            laporan. Perubahan hanya berlaku untuk laporan yang dibuat setelah disimpan.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <Label className="mb-1 block">Default Status Lead</Label>
            <p className="mb-2 text-xs text-muted-foreground">
              Status lead customer yang diikutkan secara default. Bisa diubah per laporan.
            </p>
            <div className="flex flex-wrap gap-3">
              {(
                [
                  ["lead", "Leads"],
                  ["not_lead", "Bukan Leads"],
                  ["unknown", "Belum Ditandai"],
                ] as const
              ).map(([v, text]) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.defaultLeadStatuses.includes(v)}
                    onCheckedChange={(c) =>
                      set(
                        "defaultLeadStatuses",
                        c
                          ? [...form.defaultLeadStatuses, v]
                          : form.defaultLeadStatuses.filter((x) => x !== v)
                      )
                    }
                    data-testid={`acr-default-lead-${v}`}
                  />
                  {text}
                </label>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Default Status Penanganan Chat</Label>
            <p className="mb-2 text-xs text-muted-foreground">
              Jika tidak ada yang dicentang, semua status percakapan diikutkan. Bisa diubah per
              laporan.
            </p>
            <div className="flex flex-wrap gap-3">
              {(
                [
                  ["ai_handled", "Ditangani AI"],
                  ["needs_human", "Perlu Manusia"],
                  ["closed", "Selesai"],
                ] as const
              ).map(([v, text]) => (
                <label key={v} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.defaultChatStatuses.includes(v)}
                    onCheckedChange={(c) =>
                      set(
                        "defaultChatStatuses",
                        c
                          ? [...form.defaultChatStatuses, v]
                          : form.defaultChatStatuses.filter((x) => x !== v)
                      )
                    }
                    data-testid={`acr-default-chat-${v}`}
                  />
                  {text}
                </label>
              ))}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Penerima Laporan Default</Label>
            <label className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox checked disabled />
              Super Admin / Owner Tenant (selalu menerima, tidak bisa dimatikan)
            </label>
            <p className="mb-2 text-xs text-muted-foreground">
              Tambah penerima lain yang menerima notifikasi setiap laporan selesai. Bisa diubah
              per laporan.
            </p>
            <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
              {(teamMembers ?? []).map((m) => (
                <label key={m.id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={form.defaultNotifyUserIds.includes(m.id)}
                    onCheckedChange={(c) =>
                      set(
                        "defaultNotifyUserIds",
                        c
                          ? [...form.defaultNotifyUserIds, m.id]
                          : form.defaultNotifyUserIds.filter((x) => x !== m.id)
                      )
                    }
                  />
                  {m.name ?? m.email}
                  <span className="text-xs text-muted-foreground">({m.teamRole})</span>
                </label>
              ))}
              {(teamMembers ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">Belum ada anggota tim.</p>
              )}
            </div>
          </div>

          <div>
            <Label className="mb-1 block">Aksi Default Setelah Laporan Selesai</Label>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <Checkbox checked disabled />
                Simpan ke Dashboard KPI (selalu aktif)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.defaultGeneratePdf}
                  onCheckedChange={(c) => set("defaultGeneratePdf", c === true)}
                />
                Generate PDF otomatis
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.defaultSendWhatsappPdf}
                  onCheckedChange={(c) => set("defaultSendWhatsappPdf", c === true)}
                />
                Kirim PDF via WhatsApp ke penerima
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section 6: Auto-schedule — now managed as multiple named schedules. */}
      <Card>
        <CardHeader>
          <CardTitle>Laporan Otomatis</CardTitle>
          <CardDescription>
            Jadwal laporan otomatis (harian/mingguan/bulanan) kini dikelola sebagai jadwal
            bernama yang bisa lebih dari satu.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => navigate("/ai-chat-report")}>
            Kelola di tab “Jadwal Otomatis” →
          </Button>
        </CardContent>
      </Card>

      {/* Bagian IV: Target KPI per agent + Tim/Shift */}
      <AcrAdvancedSettings />

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
