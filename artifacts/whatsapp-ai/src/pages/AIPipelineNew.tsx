import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListChannels,
  useListCustomerLabels,
  useCreateAiPipeline,
  getListAiPipelinesQueryKey,
  type Channel,
  type CustomerLabel,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  Plus,
  Trash2,
  Loader2,
  X,
  Check,
  Search,
  Sparkles,
  FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { PROMPT_TEMPLATES, type PromptTemplate } from "@/lib/pipeline-prompt-templates";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

// ─── Score slider helpers ──────────────────────────────────────────────────────

function scoreColor(val: number) {
  if (val <= 40) return "#EF4444";
  if (val <= 60) return "#F59E0B";
  if (val <= 79) return "#3B82F6";
  return "#10B981";
}

function scoreLabel(val: number) {
  if (val <= 40) return "Dingin";
  if (val <= 60) return "Hangat";
  if (val <= 79) return "Potensial";
  return "Panas";
}

// ─── Multi-select dropdown ─────────────────────────────────────────────────────

function MultiSelect<T extends { id: number; name?: string; label?: string; color?: string; kind?: string }>({
  options,
  selected,
  onChange,
  placeholder,
  renderOption,
  renderSelected,
  emptyMessage,
}: {
  options: T[];
  selected: number[];
  onChange: (ids: number[]) => void;
  placeholder: string;
  renderOption: (item: T) => React.ReactNode;
  renderSelected?: (item: T) => React.ReactNode;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = options.filter((o) => {
    const label = o.name ?? o.label ?? "";
    return label.toLowerCase().includes(search.toLowerCase());
  });

  const selectedItems = options.filter((o) => selected.includes(o.id));

  const toggle = (id: number) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  return (
    <div className="relative">
      <div
        className="min-h-9 w-full border rounded-md px-3 py-1.5 cursor-pointer flex flex-wrap gap-1.5 items-center hover:border-primary/50"
        onClick={() => setOpen(!open)}
      >
        {selectedItems.length === 0 && (
          <span className="text-muted-foreground text-sm">{placeholder}</span>
        )}
        {selectedItems.map((item) => (
          <Badge key={item.id} variant="secondary" className="gap-1 text-xs pr-1">
            {renderSelected ? renderSelected(item) : (item.name ?? item.label)}
            <button
              onClick={(e) => { e.stopPropagation(); toggle(item.id); }}
              className="hover:text-destructive"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {selectedItems.length > 0 && (
          <span className="text-xs text-muted-foreground ml-auto">
            {selectedItems.length} dipilih
          </span>
        )}
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg">
            <div className="p-2 border-b">
              <div className="flex items-center gap-2 px-2 py-1 rounded border bg-background">
                <Search className="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  className="text-sm flex-1 bg-transparent outline-none"
                  placeholder="Cari..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto p-1">
              {filtered.length === 0 && (
                <p className="text-sm text-muted-foreground px-3 py-2">
                  {emptyMessage ?? "Tidak ada hasil"}
                </p>
              )}
              {filtered.map((item) => (
                <button
                  key={item.id}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-accent text-sm text-left"
                  onClick={() => toggle(item.id)}
                >
                  <Check
                    className={cn("h-4 w-4 shrink-0", selected.includes(item.id) ? "opacity-100" : "opacity-0")}
                  />
                  {renderOption(item)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Cutoff time helpers ──────────────────────────────────────────────────────

function computeWindows(times: string[]): Array<{ time: string; window: string }> {
  const sorted = [...times].sort();
  return sorted.map((time, i) => {
    const prev = i === 0 ? "00:00" : incrementMinute(sorted[i - 1]);
    return { time, window: `${prev} – ${time}` };
  });
}

function incrementMinute(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (m === 59) return `${String(h + 1).padStart(2, "0")}:00`;
  return `${String(h).padStart(2, "0")}:${String(m + 1).padStart(2, "0")}`;
}

// ─── Form data ────────────────────────────────────────────────────────────────

interface FormData {
  name: string;
  description: string;
  isActive: boolean;
  customPrompt: string;
  directionFilter: boolean;
  channelIds: number[];
  excludeLabelIds: number[];
  cutoffTimes: string[];
  scoreThreshold: number;
  autoCreateOpportunity: boolean;
  opportunityThreshold: number;
  autoFollowupEnabled: boolean;
  followupIntervals: string[];
}

const DEFAULT_FORM: FormData = {
  name: "",
  description: "",
  isActive: true,
  customPrompt: "",
  directionFilter: true,
  channelIds: [],
  excludeLabelIds: [],
  cutoffTimes: ["12:00", "23:59"],
  scoreThreshold: 70,
  autoCreateOpportunity: false,
  opportunityThreshold: 80,
  autoFollowupEnabled: false,
  followupIntervals: ["24h", "48h", "72h"],
};

const FOLLOWUP_PRESETS = [
  { label: "24 jam", value: "24h" },
  { label: "48 jam", value: "48h" },
  { label: "72 jam", value: "72h" },
  { label: "7 hari", value: "168h" },
];

// ─── Step 1 ───────────────────────────────────────────────────────────────────

function Step1({
  data,
  onChange,
  onNext,
  onCancel,
}: {
  data: FormData;
  onChange: (d: Partial<FormData>) => void;
  onNext: () => void;
  onCancel: () => void;
}) {
  const nameLen = data.name.trim().length;
  const nameError =
    nameLen > 0 && nameLen < 3
      ? "Nama pipeline minimal 3 karakter"
      : nameLen > 100
      ? "Nama pipeline maksimal 100 karakter"
      : null;
  const canNext = nameLen >= 3 && nameLen <= 100;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Buat Pipeline Baru</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Pipeline AI akan membaca percakapan dari channel yang kamu pilih secara otomatis,
          kemudian menganalisa dan memberi skor setiap kontak.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Nama Pipeline <span className="text-destructive">*</span></Label>
          <Input
            placeholder="Contoh: Pipeline Penjualan Utama"
            value={data.name}
            onChange={(e) => onChange({ name: e.target.value })}
            maxLength={100}
          />
          {nameError && <p className="text-xs text-destructive">{nameError}</p>}
        </div>

        <div className="space-y-2">
          <Label>Deskripsi (opsional)</Label>
          <Textarea
            placeholder="Tambahkan catatan untuk pipeline ini..."
            rows={3}
            value={data.description}
            onChange={(e) => onChange({ description: e.target.value })}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label>Status</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pipeline nonaktif tidak akan menjalankan analisa otomatis
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm">{data.isActive ? "Aktif" : "Nonaktif"}</span>
            <Switch checked={data.isActive} onCheckedChange={(v) => onChange({ isActive: v })} />
          </div>
        </div>
      </div>

      <div className="flex justify-between pt-4 border-t">
        <Button variant="outline" onClick={onCancel}>Batal</Button>
        <Button onClick={onNext} disabled={!canNext} className="gap-2">
          Lanjut <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Step 2: AI Prompt ────────────────────────────────────────────────────────

function Step2({
  data,
  onChange,
  onBack,
  onNext,
}: {
  data: FormData;
  onChange: (d: Partial<FormData>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [sampleMessages, setSampleMessages] = useState("");
  const [testResult, setTestResult] = useState<{
    score: number | null;
    status: string | null;
    recommendation: string | null;
  } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<PromptTemplate | null>(null);

  const applyTemplate = (t: PromptTemplate) => {
    if (
      data.customPrompt.trim().length > 0 &&
      data.customPrompt !== t.value &&
      !window.confirm("Prompt yang sudah kamu tulis akan ditimpa. Lanjutkan?")
    ) {
      return;
    }
    onChange({ customPrompt: t.value });
    setPreviewTemplate(null);
  };

  const promptLen = data.customPrompt.length;
  const promptValid = promptLen === 0 || (promptLen >= 80 && promptLen <= 1500);
  const canNext = true; // custom prompt is optional

  const runTest = async () => {
    if (!data.customPrompt || data.customPrompt.length < 80) return;
    if (!sampleMessages.trim()) {
      setTestError("Masukkan contoh percakapan terlebih dahulu");
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const res = await fetch("/api/ai-pipeline/test-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: data.customPrompt, sampleMessages: sampleMessages.trim() }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setTestError((err as any).error ?? "Gagal menguji prompt");
      } else {
        setTestResult(await res.json());
      }
    } catch {
      setTestError("Gagal terhubung ke server");
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Prompt AI</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Kustomisasi instruksi AI untuk pipeline ini. Biarkan kosong untuk menggunakan prompt bawaan.
        </p>
      </div>

      {/* Template buttons */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Template Cepat</p>
        <div className="flex flex-wrap gap-2">
          {PROMPT_TEMPLATES.map((t) => (
            <Button
              key={t.label}
              variant={data.customPrompt === t.value ? "default" : "outline"}
              size="sm"
              className="gap-1"
              onClick={() => setPreviewTemplate(t)}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Template preview modal */}
      <Dialog open={previewTemplate !== null} onOpenChange={(o) => !o && setPreviewTemplate(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              {previewTemplate?.label}
            </DialogTitle>
            <DialogDescription>
              Pratinjau template prompt. Salin ke kolom panduan untuk menggunakannya, lalu sesuaikan dengan bisnismu.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            readOnly
            rows={12}
            value={previewTemplate?.value ?? ""}
            className="text-sm font-mono"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewTemplate(null)}>
              Batal
            </Button>
            <Button
              className="gap-1"
              onClick={() => previewTemplate && applyTemplate(previewTemplate)}
            >
              <Check className="h-4 w-4" />
              Salin &amp; Gunakan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Prompt textarea */}
      <div className="space-y-2">
        <Label>Custom Prompt <span className="text-muted-foreground font-normal">(opsional)</span></Label>
        <Textarea
          placeholder="Tulis instruksi untuk AI, minimal 80 karakter..."
          rows={6}
          value={data.customPrompt}
          onChange={(e) => onChange({ customPrompt: e.target.value })}
          maxLength={1500}
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {promptLen > 0 && !promptValid && (
              <span className="text-destructive">Minimal 80 karakter</span>
            )}
          </span>
          <span className={promptLen > 1400 ? "text-yellow-600" : ""}>{promptLen}/1500</span>
        </div>
      </div>

      {/* Direction filter */}
      <div className="flex items-center justify-between border rounded-lg p-4">
        <div>
          <Label>Filter Arah Percakapan</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Lewati percakapan di mana agen/admin mengirim lebih banyak pesan daripada kontak
          </p>
        </div>
        <Switch
          checked={data.directionFilter}
          onCheckedChange={(v) => onChange({ directionFilter: v })}
        />
      </div>

      {/* Test prompt */}
      {data.customPrompt.length >= 80 && (
        <div className="space-y-3 border rounded-lg p-4">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-medium">Uji Prompt</p>
          </div>
          <Textarea
            placeholder="Tempel contoh percakapan di sini untuk menguji prompt..."
            rows={4}
            value={sampleMessages}
            onChange={(e) => setSampleMessages(e.target.value)}
          />
          <Button variant="outline" size="sm" onClick={runTest} disabled={isTesting} className="gap-2">
            {isTesting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Jalankan Test
          </Button>
          {testError && <p className="text-xs text-destructive">{testError}</p>}
          {testResult && (
            <div className="rounded-lg bg-muted/50 border p-3 space-y-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="text-muted-foreground">Skor:</span>
                <span
                  className="font-bold text-white px-2 py-0.5 rounded"
                  style={{ backgroundColor: scoreColor(testResult.score ?? 0) }}
                >
                  {testResult.score ?? "–"}
                </span>
                {testResult.status && <span className="text-muted-foreground">{testResult.status}</span>}
              </div>
              {testResult.recommendation && (
                <p className="text-xs text-muted-foreground">{testResult.recommendation}</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-between pt-4 border-t">
        <Button variant="outline" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Kembali
        </Button>
        <Button onClick={onNext} disabled={!canNext || (promptLen > 0 && !promptValid)} className="gap-2">
          Lanjut <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: Konfigurasi ──────────────────────────────────────────────────────

function Step3({
  data,
  onChange,
  onBack,
  onSubmit,
  isSubmitting,
}: {
  data: FormData;
  onChange: (d: Partial<FormData>) => void;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  const { data: channels } = useListChannels();
  const { data: labels } = useListCustomerLabels();

  const [customAmount, setCustomAmount] = useState("");
  const [customUnit, setCustomUnit] = useState<"jam" | "hari">("jam");

  const windows = computeWindows(data.cutoffTimes);

  const addCutoffTime = () => {
    if (data.cutoffTimes.length < 6) {
      onChange({ cutoffTimes: [...data.cutoffTimes, "18:00"] });
    }
  };

  const removeCutoffTime = (idx: number) => {
    if (data.cutoffTimes.length > 1) {
      onChange({ cutoffTimes: data.cutoffTimes.filter((_, i) => i !== idx) });
    }
  };

  const updateCutoffTime = (idx: number, val: string) => {
    const times = [...data.cutoffTimes];
    times[idx] = val;
    onChange({ cutoffTimes: times });
  };

  const toggleFollowupInterval = (val: string) => {
    const current = data.followupIntervals;
    onChange({
      followupIntervals: current.includes(val)
        ? current.filter((v) => v !== val)
        : [...current, val],
    });
  };

  const addCustomInterval = () => {
    const n = Number(customAmount);
    if (!Number.isInteger(n) || n <= 0) return;
    const hours = customUnit === "hari" ? n * 24 : n;
    const val = `${hours}h`;
    if (!data.followupIntervals.includes(val)) {
      onChange({ followupIntervals: [...data.followupIntervals, val] });
    }
    setCustomAmount("");
  };

  const canSubmit = data.channelIds.length >= 1;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Konfigurasi Analisa</h2>
      </div>

      {/* A. Channels */}
      <div className="space-y-2">
        <Label>Channel yang Dianalisa <span className="text-destructive">*</span></Label>
        <p className="text-xs text-muted-foreground">
          Pilih satu atau lebih channel yang percakapannya akan dianalisa AI
        </p>
        {channels && channels.length === 0 ? (
          <p className="text-sm text-muted-foreground border rounded-md p-3">
            Belum ada channel terhubung. Hubungkan channel terlebih dahulu di menu{" "}
            <strong>Pengaturan &gt; Channel</strong>.
          </p>
        ) : (
          <MultiSelect
            options={channels ?? []}
            selected={data.channelIds}
            onChange={(ids) => onChange({ channelIds: ids })}
            placeholder="Pilih channel..."
            renderOption={(c: Channel) => (
              <span className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
                <span>{c.label}</span>
                <span className="text-muted-foreground text-xs uppercase">{c.kind}</span>
              </span>
            )}
            renderSelected={(c: Channel) => (
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: c.color }} />
                {c.label}
              </span>
            )}
            emptyMessage="Tidak ada channel ditemukan"
          />
        )}
        {data.channelIds.length === 0 && (
          <p className="text-xs text-destructive">Pilih minimal 1 channel</p>
        )}
      </div>

      {/* B. Exclude labels */}
      <div className="space-y-2">
        <Label>Kecualikan Kontak dengan Label</Label>
        <p className="text-xs text-muted-foreground">
          Kontak yang memiliki label ini tidak akan dianalisa AI. Gunakan untuk
          mengecualikan teman, keluarga, atau kontak non-bisnis.
        </p>
        <MultiSelect
          options={labels ?? []}
          selected={data.excludeLabelIds}
          onChange={(ids) => onChange({ excludeLabelIds: ids })}
          placeholder="Pilih label yang dikecualikan..."
          renderOption={(l: CustomerLabel) => (
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          )}
          renderSelected={(l: CustomerLabel) => (
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          )}
        />
      </div>

      {/* C. Cutoff schedule */}
      <div className="space-y-3">
        <Label>Jadwal Analisa Harian</Label>
        <p className="text-xs text-muted-foreground">
          AI akan menganalisa percakapan pada jam-jam berikut setiap hari
        </p>
        <div className="space-y-2">
          {windows.map(({ time, window }, idx) => (
            <div key={idx} className="flex items-center gap-3">
              <input
                type="time"
                value={time}
                onChange={(e) => updateCutoffTime(idx, e.target.value)}
                className="border rounded-md px-2 py-1 text-sm w-28"
              />
              <span className="text-xs text-muted-foreground flex-1">
                Menganalisa chat dari {window}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => removeCutoffTime(idx)}
                disabled={data.cutoffTimes.length <= 1}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          {data.cutoffTimes.length < 6 && (
            <Button variant="outline" size="sm" onClick={addCutoffTime} className="gap-1">
              <Plus className="h-3.5 w-3.5" /> Tambah Jadwal
            </Button>
          )}
        </div>
      </div>

      {/* D. Score threshold */}
      <div className="space-y-3">
        <Label>Skor Minimum Masuk Pipeline</Label>
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Slider
              min={0}
              max={100}
              step={1}
              value={[data.scoreThreshold]}
              onValueChange={([v]) => onChange({ scoreThreshold: v })}
            />
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span className="text-red-500">Dingin (0-40)</span>
              <span className="text-yellow-500">Hangat (41-60)</span>
              <span className="text-blue-500">Potensial (61-79)</span>
              <span className="text-green-500">Panas (80-100)</span>
            </div>
          </div>
          <div
            className="flex items-center justify-center w-16 h-10 rounded-lg font-bold text-white text-sm"
            style={{ backgroundColor: scoreColor(data.scoreThreshold) }}
          >
            {data.scoreThreshold}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Kontak dengan skor di atas{" "}
          <strong style={{ color: scoreColor(data.scoreThreshold) }}>{data.scoreThreshold}</strong>{" "}
          ({scoreLabel(data.scoreThreshold)}) akan otomatis masuk ke pipeline
        </p>
      </div>

      {/* E. Auto-create opportunity */}
      <div className="space-y-3 border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label>Buat Opportunity Otomatis</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Kontak dengan skor tinggi otomatis menjadi opportunity di Sales Pipeline
            </p>
          </div>
          <Switch
            checked={data.autoCreateOpportunity}
            onCheckedChange={(v) => onChange({ autoCreateOpportunity: v })}
          />
        </div>
        {data.autoCreateOpportunity && (
          <div className="space-y-3 pt-2 border-t">
            <Label>Skor Minimum Buat Opportunity</Label>
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={[data.opportunityThreshold]}
                  onValueChange={([v]) => onChange({ opportunityThreshold: v })}
                />
              </div>
              <div
                className="flex items-center justify-center w-16 h-10 rounded-lg font-bold text-white text-sm"
                style={{ backgroundColor: scoreColor(data.opportunityThreshold) }}
              >
                {data.opportunityThreshold}
              </div>
            </div>
            {data.opportunityThreshold < data.scoreThreshold ? (
              <p className="text-xs text-destructive">
                Skor opportunity ({data.opportunityThreshold}) harus ≥ skor masuk pipeline ({data.scoreThreshold}).
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Kontak dengan skor ≥ <strong>{data.opportunityThreshold}</strong> otomatis dibuatkan opportunity.
              </p>
            )}
          </div>
        )}
      </div>

      {/* F. Auto follow-up */}
      <div className="space-y-3 border rounded-lg p-4">
        <div className="flex items-center justify-between">
          <div>
            <Label>Follow-up Otomatis</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Kirim pesan follow-up otomatis menggunakan AI
            </p>
          </div>
          <Switch
            checked={data.autoFollowupEnabled}
            onCheckedChange={(v) => onChange({ autoFollowupEnabled: v })}
          />
        </div>
        {data.autoFollowupEnabled && (
          <div className="space-y-3 pt-2 border-t">
            <p className="text-sm">Kirim follow-up bila tidak ada balasan selama:</p>
            <div className="flex flex-wrap gap-3">
              {FOLLOWUP_PRESETS.map(({ label, value }) => (
                <label key={value} className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={data.followupIntervals.includes(value)}
                    onCheckedChange={() => toggleFollowupInterval(value)}
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>

            {/* Custom interval */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Interval kustom</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={customAmount}
                    onChange={(e) => setCustomAmount(e.target.value)}
                    placeholder="cth: 5"
                    className="w-24"
                  />
                  <select
                    value={customUnit}
                    onChange={(e) => setCustomUnit(e.target.value as "jam" | "hari")}
                    className="border rounded-md px-2 py-1 text-sm h-9 bg-background"
                  >
                    <option value="jam">jam</option>
                    <option value="hari">hari</option>
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={addCustomInterval}
                    disabled={data.followupIntervals.length >= 3}
                    className="gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" /> Tambah
                  </Button>
                </div>
              </div>
            </div>

            {/* Custom intervals (non-preset) chips */}
            {data.followupIntervals.some((v) => !FOLLOWUP_PRESETS.some((p) => p.value === v)) && (
              <div className="flex flex-wrap gap-2">
                {data.followupIntervals
                  .filter((v) => !FOLLOWUP_PRESETS.some((p) => p.value === v))
                  .map((v) => (
                    <Badge key={v} variant="secondary" className="gap-1 pr-1">
                      {v}
                      <button
                        type="button"
                        onClick={() => toggleFollowupInterval(v)}
                        className="hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
              </div>
            )}

            {data.followupIntervals.length >= 3 && (
              <p className="text-xs text-muted-foreground">
                Maksimal 3 interval follow-up. Hapus salah satu untuk menambah yang lain.
              </p>
            )}
            {data.followupIntervals.length === 0 && (
              <p className="text-xs text-destructive">Pilih minimal 1 interval follow-up</p>
            )}
            <div className="rounded-lg bg-blue-50 border border-blue-200 p-3 text-xs text-blue-700">
              Follow-up dikirim menggunakan AI berdasarkan konteks percakapan. Maksimal 3 pesan
              follow-up per kontak. Follow-up berhenti otomatis bila kontak membalas atau meminta dihentikan.
            </div>
          </div>
        )}
      </div>

      {/* G. Review summary */}
      <div className="rounded-lg bg-muted/50 border p-4 space-y-2 text-sm">
        <p className="font-medium text-xs uppercase text-muted-foreground">Ringkasan Konfigurasi</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <span className="text-muted-foreground">Nama</span>
          <span className="font-medium">{data.name}</span>
          <span className="text-muted-foreground">Channel</span>
          <span>{data.channelIds.length} channel dipilih</span>
          <span className="text-muted-foreground">Exclude label</span>
          <span>{data.excludeLabelIds.length > 0 ? `${data.excludeLabelIds.length} label` : "Tidak ada"}</span>
          <span className="text-muted-foreground">Jadwal</span>
          <span>{data.cutoffTimes.join(", ")}</span>
          <span className="text-muted-foreground">Threshold pipeline</span>
          <span>{data.scoreThreshold}</span>
          <span className="text-muted-foreground">Auto opportunity</span>
          <span>{data.autoCreateOpportunity ? `Skor ≥ ${data.opportunityThreshold}` : "Nonaktif"}</span>
          <span className="text-muted-foreground">Auto follow-up</span>
          <span>
            {data.autoFollowupEnabled
              ? data.followupIntervals.join(", ")
              : "Nonaktif"}
          </span>
        </div>
      </div>

      <div className="flex justify-between pt-4 border-t">
        <Button variant="outline" onClick={onBack} className="gap-1">
          <ChevronLeft className="h-4 w-4" /> Kembali
        </Button>
        <Button
          onClick={onSubmit}
          disabled={!canSubmit || (data.autoFollowupEnabled && data.followupIntervals.length === 0) || (data.autoCreateOpportunity && data.opportunityThreshold < data.scoreThreshold) || isSubmitting}
          className="gap-2"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          Simpan Pipeline
        </Button>
      </div>
    </div>
  );
}

// ─── Step 4 (success) ────────────────────────────────────────────────────────

function Step4({ pipelineName, pipelineId, onReset }: { pipelineName: string; pipelineId: number; onReset: () => void }) {
  const [, navigate] = useLocation();
  return (
    <div className="flex flex-col items-center gap-6 py-8 text-center">
      <div className="p-4 rounded-full bg-green-100">
        <CheckCircle2 className="h-12 w-12 text-green-600" />
      </div>
      <div>
        <h2 className="text-2xl font-bold">Pipeline Berhasil Dibuat!</h2>
        <p className="text-muted-foreground mt-1">{pipelineName}</p>
      </div>
      <div className="flex gap-3">
        <Button variant="outline" onClick={onReset}>Buat Pipeline Lain</Button>
        <Button onClick={() => navigate(`/ai-pipeline/${pipelineId}`)}>
          Lihat Pipeline
        </Button>
      </div>
    </div>
  );
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export default function AIPipelineNewPage() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [form, setForm] = useState<FormData>(DEFAULT_FORM);
  const [createdId, setCreatedId] = useState<number>(0);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateForm = (partial: Partial<FormData>) =>
    setForm((prev) => ({ ...prev, ...partial }));

  const { mutate: createPipeline, isPending: isSubmitting } = useCreateAiPipeline({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListAiPipelinesQueryKey() });
        setCreatedId(data.id);
        setStep(4);
      },
      onError: () => {
        toast({ title: "Gagal membuat pipeline", variant: "destructive" });
      },
    },
  });

  const handleSubmit = () => {
    createPipeline({
      data: {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        isActive: form.isActive,
        customPrompt: form.customPrompt.trim() || undefined,
        directionFilter: form.directionFilter,
        channelIds: form.channelIds,
        excludeLabelIds: form.excludeLabelIds,
        cutoffTimes: [...form.cutoffTimes].sort(),
        scoreThreshold: form.scoreThreshold,
        autoCreateOpportunity: form.autoCreateOpportunity,
        // Clamp ≥ scoreThreshold so the server-side invariant always holds.
        opportunityThreshold: Math.max(form.opportunityThreshold, form.scoreThreshold),
        autoFollowupEnabled: form.autoFollowupEnabled,
        followupIntervals: form.followupIntervals.slice(0, 3),
      },
    });
  };

  const reset = () => {
    setForm(DEFAULT_FORM);
    setStep(1);
    setCreatedId(0);
  };

  const STEP_LABELS = ["Identitas", "AI Prompt", "Konfigurasi"];

  return (
    <div className="p-6 max-w-2xl mx-auto">
      {/* Breadcrumb */}
      <div className="text-sm text-muted-foreground mb-6 flex items-center gap-1">
        <button onClick={() => navigate("/ai-pipeline")} className="hover:text-foreground">
          AI Pipeline
        </button>
        <ChevronRight className="h-3 w-3" />
        <span>Buat Baru</span>
      </div>

      {/* Step indicator */}
      {step < 4 && (
        <div className="flex items-center gap-2 mb-8">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-colors",
                  step === s
                    ? "bg-primary text-primary-foreground border-primary"
                    : s < step
                    ? "bg-green-500 text-white border-green-500"
                    : "bg-muted text-muted-foreground border-muted"
                )}
              >
                {s < step ? <Check className="h-4 w-4" /> : s}
              </div>
              <span className={cn("text-sm", step === s ? "font-medium" : "text-muted-foreground")}>
                {STEP_LABELS[s - 1]}
              </span>
              {s < 3 && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
            </div>
          ))}
        </div>
      )}

      {/* Card */}
      <div className="border rounded-xl p-6 bg-card">
        {step === 1 && (
          <Step1
            data={form}
            onChange={updateForm}
            onNext={() => setStep(2)}
            onCancel={() => navigate("/ai-pipeline")}
          />
        )}
        {step === 2 && (
          <Step2
            data={form}
            onChange={updateForm}
            onBack={() => setStep(1)}
            onNext={() => setStep(3)}
          />
        )}
        {step === 3 && (
          <Step3
            data={form}
            onChange={updateForm}
            onBack={() => setStep(2)}
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
          />
        )}
        {step === 4 && (
          <Step4
            pipelineName={form.name}
            pipelineId={createdId}
            onReset={reset}
          />
        )}
      </div>
    </div>
  );
}
