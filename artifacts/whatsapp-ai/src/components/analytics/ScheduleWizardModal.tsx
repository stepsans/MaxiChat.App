import { useEffect, useState } from "react";
import {
  useCreateReportSchedule,
  useUpdateReportSchedule,
  getListReportSchedulesQueryKey,
  type ReportSchedule,
  type ReportScheduleInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { BarChart3, Bot, MessageSquare, TrendingUp, X, Check } from "lucide-react";
import { ISO_WEEKDAYS, CONTENT_TYPE_LABEL, frequencyLabel, formatRecurrenceDays } from "./format";

const CONTENT_OPTIONS = [
  { key: "kpi", icon: BarChart3, desc: "Total chat, response time, kepuasan" },
  { key: "ai_analysis", icon: Bot, desc: "Eskalasi, topik, rekomendasi" },
  { key: "chat_history", icon: MessageSquare, desc: "Daftar percakapan" },
  { key: "trend", icon: TrendingUp, desc: "vs periode sebelumnya" },
] as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Mode = "recurring" | "once";
type Recur = "daily" | "weekly" | "monthly";

export function ScheduleWizardModal({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  editing?: ReportSchedule | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const createMut = useCreateReportSchedule();
  const updateMut = useUpdateReportSchedule();

  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [contentTypes, setContentTypes] = useState<Set<string>>(new Set(["kpi"]));
  const [mode, setMode] = useState<Mode>("recurring");
  const [recur, setRecur] = useState<Recur>("weekly");
  const [weeklyDays, setWeeklyDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [sendTime, setSendTime] = useState("07:00");
  const [emails, setEmails] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");
  const [done, setDone] = useState(false);

  // Reset / prefill whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setDone(false);
    if (editing) {
      setName(editing.name);
      setContentTypes(new Set(editing.contentTypes ?? ["kpi"]));
      setMode(editing.frequency === "once" ? "once" : "recurring");
      setRecur(editing.frequency === "once" ? "weekly" : (editing.frequency as Recur));
      setWeeklyDays(new Set(editing.recurrenceDays ?? [1, 2, 3, 4, 5]));
      setSendTime(editing.sendTime ?? "07:00");
      setEmails(editing.recipientEmails ?? []);
    } else {
      setName("");
      setContentTypes(new Set(["kpi"]));
      setMode("recurring");
      setRecur("weekly");
      setWeeklyDays(new Set([1, 2, 3, 4, 5]));
      setSendTime("07:00");
      setEmails([]);
    }
    setEmailInput("");
  }, [open, editing]);

  const frequency = mode === "once" ? "once" : recur;
  const step1Valid =
    name.trim().length > 0 &&
    contentTypes.size > 0 &&
    !(mode === "recurring" && recur === "weekly" && weeklyDays.size === 0);
  const step2Valid = emails.length > 0;
  const saving = createMut.isPending || updateMut.isPending;

  const toggleContent = (k: string) =>
    setContentTypes((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  const toggleDay = (iso: number) =>
    setWeeklyDays((prev) => {
      const next = new Set(prev);
      next.has(iso) ? next.delete(iso) : next.add(iso);
      return next;
    });

  const addEmail = () => {
    const e = emailInput.trim().replace(/,$/, "");
    if (e && EMAIL_RE.test(e) && !emails.includes(e)) {
      setEmails((prev) => [...prev, e]);
      setEmailInput("");
    } else if (e && !EMAIL_RE.test(e)) {
      toast({ title: "Email tidak valid", description: e, variant: "destructive" });
    }
  };

  const submit = async () => {
    const body: ReportScheduleInput = {
      name: name.trim(),
      contentTypes: [...contentTypes] as ReportScheduleInput["contentTypes"],
      frequency,
      recurrenceDays: frequency === "weekly" ? [...weeklyDays].sort((a, b) => a - b) : null,
      sendTime,
      timezone: "Asia/Jakarta",
      recipientEmails: emails,
      isActive: true,
    };
    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, data: body });
        toast({ title: "Jadwal diperbarui." });
      } else {
        await createMut.mutateAsync({ data: body });
        toast({ title: frequency === "once" ? "Laporan sedang dikirim." : "Jadwal berhasil dibuat!" });
      }
      await qc.invalidateQueries({ queryKey: getListReportSchedulesQueryKey() });
      setDone(true);
    } catch {
      toast({ title: "Gagal menyimpan jadwal", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit Jadwal" : "Buat Jadwal Baru"}
            {!done && <span className="ml-2 text-sm font-normal text-muted-foreground">Langkah {step} dari 3</span>}
          </DialogTitle>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40">
              <Check className="h-6 w-6 text-green-600" />
            </div>
            <p className="font-medium">{editing ? "Jadwal diperbarui!" : "Jadwal berhasil dibuat!"}</p>
            <Button onClick={() => onOpenChange(false)}>Tutup</Button>
          </div>
        ) : (
          <>
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium">Nama jadwal</label>
                  <Input
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Contoh: Laporan Harian Tim Sales"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium">Isi laporan (pilih minimal 1)</label>
                  <div className="grid grid-cols-2 gap-2">
                    {CONTENT_OPTIONS.map((o) => {
                      const active = contentTypes.has(o.key);
                      return (
                        <button
                          key={o.key}
                          type="button"
                          onClick={() => toggleContent(o.key)}
                          className={cn(
                            "flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors",
                            active ? "border-primary bg-primary/5" : "border-border hover:border-primary/40",
                          )}
                        >
                          <o.icon className={cn("h-4 w-4", active ? "text-primary" : "text-muted-foreground")} />
                          <span className="text-sm font-medium">{CONTENT_TYPE_LABEL[o.key]}</span>
                          <span className="text-xs text-muted-foreground">{o.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="mb-1.5 block text-sm font-medium">Frekuensi</label>
                  <div className="flex gap-2">
                    <ToggleBtn active={mode === "recurring"} onClick={() => setMode("recurring")}>
                      Berulang (otomatis)
                    </ToggleBtn>
                    <ToggleBtn active={mode === "once"} onClick={() => setMode("once")}>
                      Sekali kirim
                    </ToggleBtn>
                  </div>

                  {mode === "recurring" && (
                    <div className="mt-3 space-y-3 rounded-lg border border-border p-3">
                      <div className="flex gap-2">
                        {(["daily", "weekly", "monthly"] as Recur[]).map((r) => (
                          <ToggleBtn key={r} active={recur === r} onClick={() => setRecur(r)}>
                            {frequencyLabel(r)}
                          </ToggleBtn>
                        ))}
                      </div>
                      {recur === "weekly" && (
                        <div className="flex flex-wrap gap-1.5">
                          {ISO_WEEKDAYS.map((d) => (
                            <button
                              key={d.iso}
                              type="button"
                              onClick={() => toggleDay(d.iso)}
                              className={cn(
                                "h-8 w-10 rounded-md border text-xs font-medium transition-colors",
                                weeklyDays.has(d.iso)
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-border hover:border-primary/40",
                              )}
                            >
                              {d.label}
                            </button>
                          ))}
                        </div>
                      )}
                      {recur === "monthly" && (
                        <p className="text-xs text-muted-foreground">Dikirim setiap tanggal 1 setiap bulan.</p>
                      )}
                      <div className="flex items-center gap-2">
                        <span className="text-sm">Jam pengiriman (WIB):</span>
                        <Input
                          type="time"
                          value={sendTime}
                          onChange={(e) => setSendTime(e.target.value)}
                          className="w-28"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <label className="block text-sm font-medium">Email penerima</label>
                <div className="flex min-h-[42px] flex-wrap items-center gap-1.5 rounded-md border border-border p-2">
                  {emails.map((e) => (
                    <Badge key={e} variant="secondary" className="gap-1">
                      {e}
                      <button type="button" onClick={() => setEmails((prev) => prev.filter((x) => x !== e))}>
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  <input
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === ",") {
                        e.preventDefault();
                        addEmail();
                      }
                    }}
                    onBlur={addEmail}
                    placeholder={emails.length ? "" : "ketik email lalu Enter…"}
                    className="min-w-[140px] flex-1 bg-transparent text-sm outline-none"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Tekan Enter atau koma untuk menambah. Minimal 1 email.
                </p>
                <div className="rounded-md bg-muted/40 p-3 text-sm">
                  Laporan berisi: <strong>{[...contentTypes].map((c) => CONTENT_TYPE_LABEL[c]).join(", ")}</strong>
                  {emails.length > 0 && <> dan dikirim ke {emails.length} alamat email.</>}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
                <Row label="Nama" value={name} />
                <Row label="Konten" value={[...contentTypes].map((c) => CONTENT_TYPE_LABEL[c]).join(", ")} />
                <Row
                  label="Frekuensi"
                  value={
                    frequency === "once"
                      ? "Sekali kirim (langsung)"
                      : frequency === "weekly"
                        ? `Setiap ${formatRecurrenceDays([...weeklyDays])} jam ${sendTime}`
                        : `${frequencyLabel(frequency)} jam ${sendTime}`
                  }
                />
                <Row label="Kirim ke" value={emails.join(", ")} />
              </div>
            )}

            <div className="mt-2 flex justify-between gap-2">
              <Button variant="ghost" onClick={() => (step === 1 ? onOpenChange(false) : setStep((s) => s - 1))}>
                {step === 1 ? "Batal" : "← Kembali"}
              </Button>
              {step < 3 ? (
                <Button
                  disabled={(step === 1 && !step1Valid) || (step === 2 && !step2Valid)}
                  onClick={() => setStep((s) => s + 1)}
                >
                  Berikutnya →
                </Button>
              ) : (
                <Button disabled={saving} onClick={submit}>
                  {saving ? "Menyimpan…" : frequency === "once" ? "Kirim Sekarang" : "Simpan Jadwal"}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors",
        active ? "border-primary bg-primary/5 text-primary" : "border-border hover:border-primary/40",
      )}
    >
      {children}
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 flex-shrink-0 text-muted-foreground">{label}:</span>
      <span className="font-medium">{value || "—"}</span>
    </div>
  );
}
