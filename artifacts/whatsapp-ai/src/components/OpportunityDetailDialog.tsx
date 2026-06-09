import { useState } from "react";
import {
  useUpdateOpportunity,
  type Opportunity,
  type SalesStage,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  TrendingUp,
  ThumbsUp,
  ThumbsDown,
  MessageSquareQuote,
  Package,
  Cpu,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

type AgentLike = { id: number; name?: string | null; email: string };

interface Props {
  opp: Opportunity;
  stages: SalesStage[];
  agents: AgentLike[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

function scoreBand(score: number): { label: string; className: string } {
  if (score >= 70)
    return { label: "Tinggi", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" };
  if (score >= 40)
    return { label: "Sedang", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" };
  return { label: "Rendah", className: "bg-muted text-muted-foreground" };
}

type Tab = "detail" | "evidence";

export default function OpportunityDetailDialog({
  opp,
  stages,
  agents,
  canEdit,
  onClose,
  onSaved,
}: Props) {
  const { toast } = useToast();
  const update = useUpdateOpportunity();

  const [tab, setTab] = useState<Tab>("detail");
  const [stageId, setStageId] = useState<string>(
    opp.stageId == null ? "__none__" : String(opp.stageId)
  );
  const [status, setStatus] = useState(opp.status ?? "open");
  const [value, setValue] = useState(String(opp.estimatedValueIdr ?? 0));
  const [notes, setNotes] = useState(opp.aiNotes ?? "");
  const [assignedUserId, setAssignedUserId] = useState<string>(
    opp.assignedUserId == null ? "__unassigned" : String(opp.assignedUserId)
  );

  const dirty =
    stageId !== (opp.stageId == null ? "__none__" : String(opp.stageId)) ||
    status !== (opp.status ?? "open") ||
    value !== String(opp.estimatedValueIdr ?? 0) ||
    notes !== (opp.aiNotes ?? "") ||
    assignedUserId !==
      (opp.assignedUserId == null ? "__unassigned" : String(opp.assignedUserId));

  function handleSave() {
    const parsedValue = Math.max(0, Math.floor(Number(value) || 0));
    const parsedStageId = stageId === "__none__" ? null : Number(stageId);
    const parsedAssignee =
      assignedUserId === "__unassigned" ? null : Number(assignedUserId);

    update.mutate(
      {
        id: opp.id,
        data: {
          stageId: parsedStageId,
          status,
          estimatedValueIdr: parsedValue,
          aiNotes: notes.trim() || null,
          assignedUserId: parsedAssignee,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Opportunity diperbarui." });
          onSaved();
        },
        onError: (err: any) =>
          toast({
            title: "Gagal menyimpan",
            description: err?.message ?? "Coba lagi.",
            variant: "destructive",
          }),
      }
    );
  }

  const band = scoreBand(opp.leadScore);
  const keyQuotes = opp.keyQuotes as
    | { positive?: string[]; negative?: string[]; verbatim?: string[] }
    | null
    | undefined;

  const hasEvidence =
    opp.scoreReason ||
    opp.recommendation ||
    (opp.analyzedMessageIds && opp.analyzedMessageIds.length > 0) ||
    (keyQuotes &&
      (
        (keyQuotes.positive?.length ?? 0) +
        (keyQuotes.negative?.length ?? 0) +
        (keyQuotes.verbatim?.length ?? 0)
      ) > 0);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-5 pt-5 pb-0">
          <div className="flex items-start gap-3">
            {opp.profilePicUrl ? (
              <img
                src={opp.profilePicUrl}
                alt=""
                className="w-10 h-10 rounded-full object-cover shrink-0"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-muted-foreground shrink-0">
                {(opp.contactName || opp.contactPhone).charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base leading-snug truncate">
                {opp.contactName || opp.contactPhone}
              </DialogTitle>
              {opp.contactName ? (
                <p className="text-xs text-muted-foreground">{opp.contactPhone}</p>
              ) : null}
              {opp.channelLabel ? (
                <div className="flex items-center gap-1 mt-0.5">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: opp.channelColor ?? "#25D366" }}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {opp.channelLabel}
                  </span>
                </div>
              ) : null}
            </div>
            {/* Score badge */}
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold shrink-0",
                band.className
              )}
            >
              <TrendingUp className="w-3.5 h-3.5" />
              {opp.leadScore}
            </span>
          </div>

          {/* Pipeline path */}
          <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
            <Cpu className="w-3.5 h-3.5 shrink-0" />
            <span>{opp.pipelineName ?? "Pipeline"}</span>
            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
            <span>{opp.stageName ?? "Tanpa Stage"}</span>
            {opp.intentKey ? (
              <>
                <ChevronRight className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono text-[10px]">{opp.intentKey}</span>
              </>
            ) : null}
          </div>
        </DialogHeader>

        {/* Sub-tabs */}
        <div className="flex border-b px-5 mt-3">
          {(
            [
              { key: "detail" as Tab, label: "Detail" },
              { key: "evidence" as Tab, label: "Sinyal AI" },
            ]
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                tab === key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === "detail" ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Stage</Label>
                  {canEdit ? (
                    <Select value={stageId} onValueChange={setStageId}>
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue placeholder="Pilih stage…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">Tanpa Stage</SelectItem>
                        {stages.map((s) => (
                          <SelectItem key={s.id} value={String(s.id)}>
                            {s.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm">{opp.stageName ?? "Tanpa Stage"}</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Status</Label>
                  {canEdit ? (
                    <Select
                      value={status}
                      onValueChange={(v) => setStatus(v as typeof status)}
                    >
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="open">Terbuka</SelectItem>
                        <SelectItem value="won">Menang</SelectItem>
                        <SelectItem value="lost">Kalah</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm capitalize">{status}</p>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Estimasi nilai (IDR)</Label>
                {canEdit ? (
                  <Input
                    type="number"
                    min={0}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="h-9 text-xs"
                  />
                ) : (
                  <p className="text-sm font-semibold">
                    {formatRupiah(opp.estimatedValueIdr)}
                  </p>
                )}
              </div>

              {agents.length > 0 ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Ditugaskan ke</Label>
                  {canEdit ? (
                    <Select
                      value={assignedUserId}
                      onValueChange={setAssignedUserId}
                    >
                      <SelectTrigger className="h-9 text-xs">
                        <SelectValue placeholder="Belum di-assign" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__unassigned">
                          Belum di-assign
                        </SelectItem>
                        {agents.map((a) => (
                          <SelectItem key={a.id} value={String(a.id)}>
                            {a.name ?? a.email}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <p className="text-sm">
                      {opp.assignedUserId
                        ? agents.find((a) => a.id === opp.assignedUserId)
                            ?.name ??
                          agents.find((a) => a.id === opp.assignedUserId)
                            ?.email ??
                          "—"
                        : "Belum di-assign"}
                    </p>
                  )}
                </div>
              ) : null}

              {canEdit ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Catatan</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Catatan internal…"
                    className="text-xs min-h-[72px]"
                  />
                </div>
              ) : opp.aiNotes ? (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide">
                    Catatan AI
                  </Label>
                  <p className="text-xs">{opp.aiNotes}</p>
                </div>
              ) : null}

              {/* Products */}
              {opp.products && opp.products.length > 0 ? (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                    <Package className="w-3 h-3" />
                    Produk
                  </Label>
                  <div className="flex flex-wrap gap-1.5">
                    {opp.products.map((p, i) => (
                      <Badge
                        key={i}
                        variant="secondary"
                        className="text-xs font-normal"
                      >
                        {p.productName}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* Intent metadata */}
              <div className="grid grid-cols-2 gap-3 pt-1 border-t">
                {opp.intentCategory ? (
                  <div className="space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Kategori
                    </p>
                    <p className="text-xs">{opp.intentCategory}</p>
                  </div>
                ) : null}
                {opp.intentType ? (
                  <div className="space-y-0.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Tipe
                    </p>
                    <p className="text-xs">{opp.intentType}</p>
                  </div>
                ) : null}
                {opp.lastActivityAt ? (
                  <div className="space-y-0.5 col-span-2">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Aktivitas terakhir
                    </p>
                    <p className="text-xs">
                      {new Date(opp.lastActivityAt).toLocaleString("id-ID")}
                    </p>
                  </div>
                ) : null}
                {opp.analyzedAt ? (
                  <div className="space-y-0.5 col-span-2">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                      Dianalisa
                    </p>
                    <p className="text-xs">
                      {new Date(opp.analyzedAt).toLocaleString("id-ID")}
                      {opp.analyzedMessageIds &&
                      opp.analyzedMessageIds.length > 0
                        ? ` · ${opp.analyzedMessageIds.length} pesan`
                        : null}
                    </p>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            /* Evidence tab */
            <div className="space-y-4">
              {!hasEvidence ? (
                <p className="py-8 text-sm text-center text-muted-foreground">
                  Belum ada sinyal AI yang tersimpan. Jalankan analisa ulang dari
                  chat.
                </p>
              ) : null}

              {opp.recommendation ? (
                <div className="rounded-md border bg-primary/5 p-3 space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-primary">
                    Rekomendasi AI
                  </p>
                  <p className="text-sm">{opp.recommendation}</p>
                </div>
              ) : null}

              {opp.scoreReason ? (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Alasan skor {opp.leadScore}
                  </p>
                  <p className="text-xs text-foreground">{opp.scoreReason}</p>
                </div>
              ) : null}

              {keyQuotes && (keyQuotes.positive?.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <ThumbsUp className="w-3.5 h-3.5" />
                    <p className="text-[10px] font-semibold uppercase tracking-wide">
                      Sinyal Positif
                    </p>
                  </div>
                  <ul className="space-y-1">
                    {keyQuotes.positive!.map((q, i) => (
                      <li
                        key={i}
                        className="flex gap-2 text-xs"
                      >
                        <span className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {keyQuotes && (keyQuotes.negative?.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
                    <ThumbsDown className="w-3.5 h-3.5" />
                    <p className="text-[10px] font-semibold uppercase tracking-wide">
                      Sinyal Negatif
                    </p>
                  </div>
                  <ul className="space-y-1">
                    {keyQuotes.negative!.map((q, i) => (
                      <li key={i} className="flex gap-2 text-xs">
                        <span className="mt-1 w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
                        <span>{q}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {keyQuotes && (keyQuotes.verbatim?.length ?? 0) > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <MessageSquareQuote className="w-3.5 h-3.5" />
                    <p className="text-[10px] font-semibold uppercase tracking-wide">
                      Kutipan Customer
                    </p>
                  </div>
                  <ul className="space-y-1.5">
                    {keyQuotes.verbatim!.map((q, i) => (
                      <li
                        key={i}
                        className="rounded border-l-2 border-muted-foreground/30 pl-2.5 py-1 text-xs italic text-muted-foreground"
                      >
                        "{q}"
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {opp.analyzedMessageIds && opp.analyzedMessageIds.length > 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  Berdasarkan {opp.analyzedMessageIds.length} pesan yang dianalisa
                  {opp.analyzedAt
                    ? ` · ${new Date(opp.analyzedAt).toLocaleString("id-ID")}`
                    : null}
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* Footer */}
        {canEdit ? (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
            <Button variant="outline" size="sm" onClick={onClose}>
              Batal
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!dirty || update.isPending}
            >
              {update.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              Simpan
            </Button>
          </div>
        ) : (
          <div className="flex justify-end px-5 py-3 border-t">
            <Button variant="outline" size="sm" onClick={onClose}>
              Tutup
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
