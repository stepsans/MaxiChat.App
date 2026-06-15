import { useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  useGetAnalyticsChatHistory,
  getGetAnalyticsChatHistoryQueryKey,
  getAnalyticsChatHistory,
  useListChannels,
  getListChannelsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download, Search } from "lucide-react";
import type { PeriodKey } from "./format";
import { formatMinutes, formatDateTime } from "./format";

const HANDLED_LABEL: Record<string, string> = { ai: "AI", agent: "Agent", escalated: "Eskalasi" };
const HANDLED_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  ai: "default",
  agent: "secondary",
  escalated: "outline",
};
const STATUS_LABEL: Record<string, string> = { done: "Selesai", in_progress: "Dalam proses", unreplied: "Belum dibalas" };

export function ChatHistoryTable({ period, from, to }: { period: PeriodKey; from?: string; to?: string }) {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  // Seed filters from the URL once (a KPI-card click deep-links here, e.g.
  // ?tab=history&hStatus=unreplied). Read at mount only.
  const initial = new URLSearchParams(useSearch());
  const [searchInput, setSearchInput] = useState(initial.get("hSearch") ?? "");
  const [search, setSearch] = useState(initial.get("hSearch") ?? "");
  const [channel, setChannel] = useState(initial.get("hChannel") ?? "all");
  const [handledBy, setHandledBy] = useState(initial.get("hHandled") ?? "all");
  const [status, setStatus] = useState(initial.get("hStatus") ?? "all");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const limit = 50;

  const { data: channels } = useListChannels({
    query: { queryKey: getListChannelsQueryKey() },
  });

  const params = {
    period,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(channel !== "all" ? { channel } : {}),
    ...(handledBy !== "all" ? { handledBy: handledBy as "ai" | "agent" | "escalated" } : {}),
    ...(status !== "all" ? { status: status as "done" | "in_progress" | "unreplied" } : {}),
    ...(search ? { search } : {}),
    page,
    limit,
  };
  const { data, isLoading } = useGetAnalyticsChatHistory(params, {
    query: { queryKey: getGetAnalyticsChatHistoryQueryKey(params) },
  });

  const records = data?.records ?? [];

  const resetPageThen = (fn: () => void) => {
    setPage(1);
    fn();
  };

  // Export the WHOLE filtered dataset (not just the visible page) by paging
  // through the API at the server's max page size.
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    toast({ title: "Menyiapkan CSV…", description: "Mengumpulkan seluruh data yang cocok." });
    try {
      const base = { ...params, limit: 200 };
      const all: typeof records = [];
      for (let p = 1; p <= 50; p++) {
        const res = await getAnalyticsChatHistory({ ...base, page: p });
        all.push(...res.records);
        if (!res.hasMore || res.records.length === 0) break;
      }
      if (all.length === 0) {
        toast({ title: "Tidak ada data untuk diekspor." });
        return;
      }
      const header = ["Kontak", "Telepon", "Channel", "Ditangani", "Durasi (mnt)", "Status", "Mulai"];
      const lines = all.map((r) =>
        [
          r.contactName,
          r.phoneNumber ?? "",
          r.channelName,
          HANDLED_LABEL[r.handledBy] ?? r.handledBy,
          r.durationMinutes ?? "",
          STATUS_LABEL[r.status] ?? r.status,
          formatDateTime(r.startedAt),
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(","),
      );
      const csv = [header.join(","), ...lines].join("\n");
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `riwayat-chat-${period}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: `CSV siap`, description: `${all.length} percakapan diekspor.` });
    } catch {
      toast({ title: "Gagal menyiapkan CSV", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") resetPageThen(() => setSearch(searchInput.trim()));
            }}
            placeholder="Cari nama kontak atau isi pesan…"
            className="pl-8"
          />
        </div>
        <Select value={channel} onValueChange={(v) => resetPageThen(() => setChannel(v))}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Channel" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Semua channel</SelectItem>
            {(channels ?? []).map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={handledBy} onValueChange={(v) => resetPageThen(() => setHandledBy(v))}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Ditangani" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Semua</SelectItem>
            <SelectItem value="ai">AI</SelectItem>
            <SelectItem value="agent">Agent</SelectItem>
            <SelectItem value="escalated">Eskalasi</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status} onValueChange={(v) => resetPageThen(() => setStatus(v))}>
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Semua status</SelectItem>
            <SelectItem value="done">Selesai</SelectItem>
            <SelectItem value="in_progress">Dalam proses</SelectItem>
            <SelectItem value="unreplied">Belum dibalas</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={exportCsv}
          disabled={records.length === 0 || exporting}
        >
          <Download className="h-4 w-4" /> {exporting ? "Menyiapkan…" : "Export CSV"}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kontak &amp; channel</TableHead>
                <TableHead>Ditangani</TableHead>
                <TableHead>Durasi</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Aksi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-6 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : records.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                    Tidak ada chat yang cocok.
                    {(search || channel !== "all" || handledBy !== "all" || status !== "all") && (
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() =>
                          resetPageThen(() => {
                            setSearch("");
                            setSearchInput("");
                            setChannel("all");
                            setHandledBy("all");
                            setStatus("all");
                          })
                        }
                      >
                        Reset filter
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ) : (
                records.map((r) => (
                  <TableRow key={r.chatId}>
                    <TableCell>
                      <div className="font-medium">{r.contactName || r.phoneNumber || "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.channelName} · {formatDateTime(r.startedAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={HANDLED_VARIANT[r.handledBy] ?? "outline"}>
                        {HANDLED_LABEL[r.handledBy] ?? r.handledBy}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{formatMinutes(r.durationMinutes)}</TableCell>
                    <TableCell>
                      <span
                        className={
                          r.status === "unreplied"
                            ? "text-sm text-red-600"
                            : r.status === "done"
                              ? "text-sm text-green-600"
                              : "text-sm text-muted-foreground"
                        }
                      >
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => navigate(`/chats?chat=${r.chatId}`)}>
                        Buka
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {data && data.total > limit && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Halaman {page} · {data.total} percakapan
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Sebelumnya
            </Button>
            <Button variant="outline" size="sm" disabled={!data.hasMore} onClick={() => setPage((p) => p + 1)}>
              Berikutnya
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
