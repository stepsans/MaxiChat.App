import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListAiPipelines,
  useToggleAiPipeline,
  useDeleteAiPipeline,
  getListAiPipelinesQueryKey,
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
  Trash2,
  Clock,
  Zap,
  Target,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  const queryClient = useQueryClient();
  const { toast } = useToast();

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

  const stats = pipeline.todayStats ?? { analyzed: 0, enteredPipeline: 0, opportunitiesCreated: 0 };

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
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Dianalisa", value: stats.analyzed },
            { label: "Masuk Pipeline", value: stats.enteredPipeline },
            { label: "Opportunity", value: stats.opportunitiesCreated },
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
