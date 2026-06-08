import { useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFlows,
  useCreateFlow,
  useDeleteFlow,
  useActivateFlow,
  useDeactivateFlow,
  useUpdateFlow,
  useResetFlowCooldown,
  useImportFlow,
  getFlow,
  getListFlowsQueryKey,
} from "@workspace/api-client-react";
import { Plus, Trash2, Power, PowerOff, Pencil, GitBranch, HelpCircle, RefreshCw, Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChannelMultiSelect } from "@/components/ChannelMultiSelect";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { usePermissions } from "@/hooks/use-permissions";

export default function Flows() {
  const { can } = usePermissions();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: flows, isLoading } = useListFlows();
  const [name, setName] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListFlowsQueryKey() });

  const create = useCreateFlow({
    mutation: {
      onSuccess: () => {
        setName("");
        invalidate();
        toast({ title: "Flow dibuat" });
      },
    },
  });
  const remove = useDeleteFlow({
    mutation: { onSuccess: () => invalidate() },
  });
  const activate = useActivateFlow({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Flow diaktifkan" });
      },
    },
  });
  const deactivate = useDeactivateFlow({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Flow dinonaktifkan" });
      },
    },
  });
  const update = useUpdateFlow({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Penempatan channel disimpan" });
      },
      onError: () => {
        toast({ title: "Gagal menyimpan channel", variant: "destructive" });
      },
    },
  });
  const resetCooldown = useResetFlowCooldown({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: "Cooldown direset",
          description: `${data.cleared} chat siap memulai flow lagi tanpa menunggu.`,
        });
      },
      onError: () => {
        toast({ title: "Gagal reset cooldown", variant: "destructive" });
      },
    },
  });
  const importFlowMut = useImportFlow({
    mutation: {
      onSuccess: (f) => {
        invalidate();
        toast({
          title: "Flow diimpor",
          description: `"${f.name}" berhasil dipulihkan (nonaktif). Aktifkan & pasang channel jika perlu.`,
        });
      },
      onError: () => {
        toast({
          title: "Gagal impor flow",
          description: "File tidak valid atau bukan ekspor flow Maxichat.app.",
          variant: "destructive",
        });
      },
    },
  });

  // Export pulls the full graph (the list only carries summaries) then
  // downloads a self-describing JSON envelope the import side recognizes.
  async function handleExport(id: number, flowName: string) {
    setExportingId(id);
    try {
      const full = await getFlow(id);
      const envelope = {
        app: "maxichat",
        kind: "chatbot-flow",
        version: 1,
        exportedAt: new Date().toISOString(),
        name: full.name,
        graph: full.graph,
      };
      const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const safe = flowName.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40) || "flow";
      const a = document.createElement("a");
      a.href = url;
      a.download = `maxichat-flow-${safe}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Gagal ekspor flow", variant: "destructive" });
    } finally {
      setExportingId(null);
    }
  }

  async function handleImportFile(file: File) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast({
        title: "Gagal impor flow",
        description: "File bukan JSON yang valid.",
        variant: "destructive",
      });
      return;
    }
    const obj = parsed as Record<string, unknown>;
    // Accept either our export envelope or a bare flow object that carries a graph.
    const rawGraph = (obj?.["graph"] ?? obj) as Record<string, unknown> | undefined;
    const nodes = rawGraph?.["nodes"];
    const edges = rawGraph?.["edges"];
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
      toast({
        title: "Gagal impor flow",
        description: "File tidak berisi graph flow yang valid.",
        variant: "destructive",
      });
      return;
    }
    const importedName =
      typeof obj?.["name"] === "string" && obj["name"].trim()
        ? (obj["name"] as string).trim().slice(0, 120)
        : file.name.replace(/\.json$/i, "").slice(0, 120) || "Flow impor";
    importFlowMut.mutate({
      data: { name: importedName, graph: { nodes, edges } as never },
    });
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-4 flex items-center gap-3">
        <GitBranch className="w-5 h-5 text-primary" />
        <div className="flex-1">
          <h1 className="text-lg font-semibold">Chatbot Flow</h1>
          <p className="text-xs text-muted-foreground">
            Susun alur balasan otomatis. Maksimal 1 flow aktif per channel — flow
            bisa dipasang ke beberapa channel sekaligus.
          </p>
        </div>
        {can.mutateFlows && (
          <Button
            variant="outline"
            size="sm"
            disabled={resetCooldown.isPending}
            onClick={() => resetCooldown.mutate()}
            data-testid="button-reset-cooldown"
            title="Hapus cooldown semua chat — Default trigger akan langsung jalan di pesan berikutnya. Khusus testing."
          >
            <RefreshCw className={`w-4 h-4 mr-1.5 ${resetCooldown.isPending ? "animate-spin" : ""}`} />
            Reset Cooldown
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setGuideOpen(true)}
          data-testid="button-flow-guide"
        >
          <HelpCircle className="w-4 h-4 mr-1.5" /> Panduan
        </Button>
      </div>

      <FlowGuideDialog open={guideOpen} onOpenChange={setGuideOpen} />

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {can.mutateFlows && (
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="flex gap-2 flex-1 min-w-[18rem] max-w-md"
              onSubmit={(e) => {
                e.preventDefault();
                const v = name.trim();
                if (!v) return;
                create.mutate({ data: { name: v } });
              }}
            >
              <Input
                placeholder="Nama flow baru (mis. Greeting Toko)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="input-flow-name"
              />
              <Button
                type="submit"
                disabled={create.isPending || !name.trim()}
                data-testid="button-create-flow"
              >
                <Plus className="w-4 h-4 mr-1" /> Buat Flow
              </Button>
            </form>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="input-import-flow"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleImportFile(file);
                e.target.value = "";
              }}
            />
            <Button
              variant="outline"
              disabled={importFlowMut.isPending}
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-import-flow"
              title="Pulihkan flow dari file backup (.json)"
            >
              <Upload className="w-4 h-4 mr-1.5" /> Impor
            </Button>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Memuat…</p>
        ) : !flows || flows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <GitBranch className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Belum ada flow. Buat yang pertama di atas.</p>
          </div>
        ) : (
          <div className="grid gap-3 max-w-3xl">
            {flows.map((f) => (
              <div
                key={f.id}
                className="border border-border rounded-lg p-4 flex flex-col gap-3 bg-card hover-elevate"
                data-testid={`row-flow-${f.id}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={
                        "inline-block w-2 h-2 rounded-full " +
                        (f.isActive ? "bg-green-500" : "bg-muted-foreground/40")
                      }
                    />
                    <div>
                      <div className="font-medium">{f.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {f.isActive ? "Aktif" : "Nonaktif"} · diperbarui{" "}
                        {new Date(f.updatedAt).toLocaleString("id-ID")}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Link href={`/flows/${f.id}`}>
                      <Button variant="outline" size="sm" data-testid={`button-edit-${f.id}`}>
                        <Pencil className="w-4 h-4 mr-1" /> {can.mutateFlows ? "Edit" : "Lihat"}
                      </Button>
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={exportingId === f.id}
                      onClick={() => handleExport(f.id, f.name)}
                      data-testid={`button-export-${f.id}`}
                      title="Unduh backup flow ini (.json)"
                    >
                      <Download className="w-4 h-4 mr-1" /> Ekspor
                    </Button>
                    {can.mutateFlows && (f.isActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deactivate.isPending}
                        onClick={() => deactivate.mutate({ id: f.id })}
                        data-testid={`button-deactivate-${f.id}`}
                      >
                        <PowerOff className="w-4 h-4 mr-1" /> Nonaktifkan
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        disabled={activate.isPending}
                        onClick={() => activate.mutate({ id: f.id })}
                        data-testid={`button-activate-${f.id}`}
                      >
                        <Power className="w-4 h-4 mr-1" /> Aktifkan
                      </Button>
                    ))}
                    {can.mutateFlows && (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (confirm(`Hapus flow "${f.name}"?`)) {
                            remove.mutate({ id: f.id });
                          }
                        }}
                        data-testid={`button-delete-${f.id}`}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 border-t border-border pt-3">
                  <span className="text-xs text-muted-foreground shrink-0">Channel:</span>
                  {can.mutateFlows ? (
                    <ChannelMultiSelect
                      value={f.channelIds}
                      onChange={(next) =>
                        update.mutate({ id: f.id, data: { channelIds: next } })
                      }
                      disabled={update.isPending}
                      testIdPrefix={`flow-channels-${f.id}`}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {f.channelIds.length === 0
                        ? "Semua channel"
                        : `${f.channelIds.length} channel`}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FlowGuideDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Panduan Chatbot Flow</DialogTitle>
          <DialogDescription>
            Cara kerja flow, jenis node, dan kenapa kadang chat tidak masuk ke flow.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 text-sm leading-relaxed pt-2">
          <section>
            <h3 className="font-semibold text-base mb-2">1. Konsep Dasar</h3>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Setiap flow bisa dipasang ke <b>satu atau beberapa channel</b>
                (kolom Channel). Kosong = <b>semua channel</b>. Maksimal{" "}
                <b>1 flow aktif per channel</b> — mengaktifkan flow baru otomatis
                mematikan flow lain yang memakai channel yang sama.
              </li>
              <li>
                Setiap pesan masuk dicek ke flow <b>sebelum</b> dijawab AI.
                Kalau flow merespons, AI dilewati.
              </li>
              <li>
                Flow harus punya minimal 1 <b>Trigger</b> yang tersambung ke
                node lain. Trigger yang menggantung (tanpa edge keluar) akan
                diabaikan.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-base mb-2">2. Jenis Node</h3>

            <div className="space-y-3">
              <div className="rounded-md border border-border p-3">
                <div className="font-medium text-emerald-600 dark:text-emerald-400">
                  ⚡ Trigger
                </div>
                <p className="mt-1">
                  Titik masuk flow. Dua mode:
                </p>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li>
                    <b>Keyword</b> — flow jalan kalau pesan customer
                    mengandung salah satu kata kunci (case-insensitive,
                    substring). Mengabaikan cooldown — selalu menang.
                  </li>
                  <li>
                    <b>Default</b> — flow jalan untuk pesan apa pun, tapi
                    <b> sekali jalan langsung di-jeda</b>. Setelah customer
                    sampai ke node End atau AI, Default trigger <b>tidak akan
                    memulai flow lagi</b> untuk customer yang sama selama
                    periode jeda (5 / 15 / 30 / 60 / 120 menit, atur di
                    Settings → Cooldown Flow). Tujuannya: supaya customer
                    tidak terus-terusan dilempar ke menu awal setiap kali
                    membalas. Setelah jeda habis, Default boleh memulai
                    ulang. Keyword trigger tetap bisa memotong jeda ini
                    kapan saja.
                  </li>
                </ul>
              </div>

              <div className="rounded-md border border-border p-3">
                <div className="font-medium text-orange-600 dark:text-orange-400">
                  💬 Pesan (Message)
                </div>
                <p className="mt-1">
                  Kirim teks ke customer, lalu otomatis lanjut ke node
                  berikutnya. Pakai untuk sapaan, info singkat, instruksi.
                </p>
              </div>

              <div className="rounded-md border border-border p-3">
                <div className="font-medium text-amber-600 dark:text-amber-400">
                  ❓ Pertanyaan (Question)
                </div>
                <p className="mt-1">
                  Kirim pertanyaan + daftar opsi bernomor. Cabang flow
                  mengikuti opsi yang customer pilih.
                </p>
                <ul className="list-disc pl-5 mt-1 space-y-1">
                  <li>
                    Customer bisa jawab dengan <b>angka</b> (1, 2, 3) atau
                    <b> label</b> persis (mis. "Beli").
                  </li>
                  <li>
                    <b>Toggle "Wajib pilih dari opsi"</b>: kalau ON, jawaban
                    di luar opsi → pertanyaan dikirim ulang, flow tidak
                    keluar, AI tidak ikut campur. Kalau OFF → flow keluar,
                    AI ambil alih.
                  </li>
                </ul>
              </div>

              <div className="rounded-md border border-border p-3">
                <div className="font-medium text-amber-600 dark:text-amber-400">
                  🤖 AI (Handoff ke AI)
                </div>
                <p className="mt-1">
                  Akhiri flow + alihkan ke AI assistant. Mengirim teks
                  pembuka (mis. <i>"Baik, silakan tanya apa saja ya 🤖…"</i>),
                  lalu pesan berikutnya dari customer <b>dijawab AI</b>
                  (pakai Knowledge Base + Sales Prompt). Default trigger
                  di-mute selama cooldown.
                </p>
              </div>

              <div className="rounded-md border border-border p-3">
                <div className="font-medium text-rose-600 dark:text-rose-400">
                  ⛔ End
                </div>
                <p className="mt-1">
                  Akhiri flow tanpa kirim pesan apa pun. Pesan customer
                  berikutnya <b>tidak dibalas</b> (sampai cooldown habis atau
                  keyword trigger memotong). Cocok untuk skenario "tutup
                  percakapan", customer batal, atau bot harus diam karena
                  admin manusia akan ambil alih.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-md border-2 border-primary/40 bg-primary/5 p-4">
            <h3 className="font-semibold text-base mb-2">
              3. End vs AI — Kapan Pakai yang Mana?
            </h3>
            <table className="w-full text-xs mt-2">
              <thead>
                <tr className="text-left border-b border-border">
                  <th className="py-1.5 pr-2">Situasi</th>
                  <th className="py-1.5 pr-2">Pakai</th>
                  <th className="py-1.5">Alasan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                <tr>
                  <td className="py-1.5 pr-2">Customer pilih "Tidak jadi"</td>
                  <td className="py-1.5 pr-2"><b>End</b></td>
                  <td className="py-1.5">Diam, jangan ganggu.</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2">Customer pilih "Tanya admin manusia"</td>
                  <td className="py-1.5 pr-2"><b>End</b></td>
                  <td className="py-1.5">Bot mundur, admin yang jawab.</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2">Customer pilih "Konsultasi / tanya bebas"</td>
                  <td className="py-1.5 pr-2"><b>AI</b></td>
                  <td className="py-1.5">AI bisa jawab pertanyaan apa pun pakai Knowledge Base.</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2">Customer pilih "Lihat produk"</td>
                  <td className="py-1.5 pr-2"><b>AI</b></td>
                  <td className="py-1.5">Setelah sync katalog ke KB, AI bisa list/jawab harga.</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2">Customer pilih "Cek resi"</td>
                  <td className="py-1.5 pr-2"><b>End</b></td>
                  <td className="py-1.5">Kirim instruksi lewat node Pesan, lalu End — admin lanjut manual.</td>
                </tr>
                <tr>
                  <td className="py-1.5 pr-2">Setelah ucapan terima kasih</td>
                  <td className="py-1.5 pr-2"><b>End</b></td>
                  <td className="py-1.5">Percakapan selesai.</td>
                </tr>
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">
              <b>Aturan ringkas:</b> kalau customer masih akan tanya hal yang
              <b> bot/AI bisa jawab</b> → pakai <b>AI</b>. Kalau customer
              butuh <b>manusia</b> atau memang sudah selesai → pakai <b>End</b>.
            </p>
          </section>

          <section>
            <h3 className="font-semibold text-base mb-2">4. Contoh Flow Lengkap</h3>
            <pre className="bg-muted/50 border border-border rounded-md p-3 text-xs overflow-x-auto whitespace-pre-wrap">
{`Trigger (Default)
   ↓
Pesan: "Halo 👋 Saya bot Toko ABC, ada yang bisa dibantu?"
   ↓
Pertanyaan: "Silakan pilih:"
   ├─ 1. Lihat produk        → AI ("Baik, mau cari apa? Ketik bebas ya 🤖")
   ├─ 2. Cek pesanan / resi  → Pesan ("Kirim nomor order Anda, admin akan cek") → End
   ├─ 3. Chat admin          → End (admin manusia ambil alih)
   └─ 4. Tanya bebas         → AI ("Silakan tanya apa saja 🤖")
`}
            </pre>
          </section>

          <section className="rounded-md border-2 border-amber-500/40 bg-amber-500/5 p-4">
            <h3 className="font-semibold text-base mb-2">
              5. Kenapa chat tidak masuk ke flow?
            </h3>
            <p className="mb-2">
              Kalau fitur sudah aktif tapi customer kirim pesan tidak ditanggapi
              flow, cek satu per satu:
            </p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                <b>Flow benar-benar aktif?</b> Di halaman ini titik harus
                <span className="inline-block w-2 h-2 rounded-full bg-green-500 mx-1 align-middle" />
                hijau. Cuma 1 flow yang boleh aktif.
              </li>
              <li>
                <b>Trigger tersambung?</b> Buka editor → pastikan node Trigger
                punya garis keluar ke node berikutnya. Trigger menggantung =
                diabaikan.
              </li>
              <li>
                <b>Mode Trigger sesuai?</b>
                <ul className="list-disc pl-5 mt-1">
                  <li>
                    <b>Keyword</b>: cek kata kuncinya. Match-nya
                    case-insensitive + substring (mis. keyword "menu" akan kena
                    pesan "Saya mau lihat menu"). Tapi salah ketik / typo tidak
                    kena.
                  </li>
                  <li>
                    <b>Default</b>: pasti jalan untuk pesan pertama, tapi
                    <b> tidak jalan</b> kalau chat masih dalam <b>cooldown</b>
                    setelah End/AI sebelumnya.
                  </li>
                </ul>
              </li>
              <li>
                <b>Cooldown aktif?</b> Setelah flow customer berakhir di
                End/AI, Default trigger di-mute 5–120 menit (atur di
                Settings). Selama itu hanya Keyword trigger yang bisa
                memotong. Mau test ulang? Tunggu cooldown habis atau pakai
                keyword.
              </li>
              <li>
                <b>Chat dalam "Human Takeover"?</b> Kalau di halaman Chat Anda
                pernah klik "Ambil alih", flow & AI <b>dimatikan</b> untuk
                chat itu sampai dilepas kembali.
              </li>
              <li>
                <b>Customer di tengah Question?</b> Kalau flow sebelumnya
                berhenti di node Pertanyaan dan customer baru balas sekarang,
                jawaban diproses sebagai pilihan opsi — bukan trigger ulang.
              </li>
              <li>
                <b>WhatsApp tersambung?</b> Cek halaman WhatsApp — status
                harus "Connected". Tanpa koneksi, pesan tidak diterima sama
                sekali.
              </li>
            </ol>
            <p className="mt-3 text-xs">
              <b>Tip debug cepat:</b> buat flow test dengan Keyword
              <code className="mx-1 px-1 rounded bg-muted">test_bot</code>
              → Pesan "Halo, bot aktif" → End. Kirim "test_bot" dari WA
              customer; kalau dapat balasan, mesin flow bekerja dan masalahnya
              ada di trigger flow utama Anda.
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
