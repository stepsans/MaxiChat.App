import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  useGetFlow,
  useUpdateFlow,
  useActivateFlow,
  useDeactivateActiveFlow,
  useListProducts,
  getGetFlowQueryKey,
  getListFlowsQueryKey,
} from "@workspace/api-client-react";
import {
  ArrowLeft,
  Save,
  Power,
  PowerOff,
  Plus,
  Trash2,
  Loader2,
  Zap,
  MessageSquare,
  HelpCircle,
  CircleStop,
  Bot,
  ImagePlus,
  Package,
  X as XIcon,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";

type NodeKind = "trigger" | "message" | "question" | "end" | "ai" | "products";

type FlowNodeData = {
  matchType?: "default" | "keyword";
  keywords?: string[];
  text?: string;
  imageUrl?: string | null;
  options?: { id: string; label: string }[];
  strictOptions?: boolean;
  strictRetryMessage?: string;
  productIds?: number[];
  aiInstruction?: string;
};

type RFNode = Node<FlowNodeData & { label?: string }, NodeKind>;

function uid(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

// ----- Custom node renderers -----

function NodeShell({
  selected,
  borderClass,
  icon,
  title,
  children,
}: {
  selected: boolean;
  borderClass: string;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border-2 bg-card text-card-foreground shadow-sm min-w-[180px] max-w-[240px] text-xs ${borderClass} ${
        selected ? "ring-2 ring-primary" : ""
      }`}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-border/60 font-medium">
        {icon}
        <span>{title}</span>
      </div>
      <div className="px-2 py-1.5 text-muted-foreground whitespace-pre-wrap break-words">
        {children}
      </div>
    </div>
  );
}

function TriggerNode({ data, selected }: NodeProps<RFNode>) {
  const isDefault = data.matchType === "default";
  return (
    <NodeShell
      selected={!!selected}
      borderClass="border-green-500/60"
      icon={<Zap className="w-3.5 h-3.5 text-green-500" />}
      title="Trigger"
    >
      {isDefault
        ? "Default (semua pesan)"
        : (data.keywords ?? []).length > 0
          ? `Kata kunci: ${(data.keywords ?? []).join(", ")}`
          : "Belum ada kata kunci"}
      <Handle type="source" position={Position.Bottom} />
    </NodeShell>
  );
}

function MessageNode({ data, selected }: NodeProps<RFNode>) {
  return (
    <NodeShell
      selected={!!selected}
      borderClass="border-orange-500/60"
      icon={<MessageSquare className="w-3.5 h-3.5 text-orange-500" />}
      title="Pesan"
    >
      {data.imageUrl && (
        <div className="mb-1 flex items-center gap-1 text-[10px] text-orange-500">
          <ImagePlus className="w-3 h-3" /> Gambar terlampir
        </div>
      )}
      {data.text || (
        <span className="italic opacity-60">
          {data.imageUrl ? "(tanpa caption)" : "(kosong)"}
        </span>
      )}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </NodeShell>
  );
}

function QuestionNode({ data, selected }: NodeProps<RFNode>) {
  const opts = data.options ?? [];
  return (
    <NodeShell
      selected={!!selected}
      borderClass="border-amber-500/60"
      icon={<HelpCircle className="w-3.5 h-3.5 text-amber-500" />}
      title="Pertanyaan"
    >
      {data.imageUrl && (
        <div className="mb-1 flex items-center gap-1 text-[10px] text-amber-500">
          <ImagePlus className="w-3 h-3" /> Gambar terlampir
        </div>
      )}
      <div>{data.text || <span className="italic opacity-60">(pertanyaan kosong)</span>}</div>
      <div className="mt-1 space-y-0.5">
        {opts.length === 0 && (
          <div className="italic opacity-60">(tidak ada pilihan)</div>
        )}
        {opts.map((o, i) => (
          <div key={o.id} className="relative pl-3">
            <span className="text-foreground">
              {i + 1}. {o.label}
            </span>
            <Handle
              id={o.id}
              type="source"
              position={Position.Right}
              style={{ top: `${100 / (opts.length + 1) * (i + 1)}%`, background: "#a855f7" }}
            />
          </div>
        ))}
      </div>
      <Handle type="target" position={Position.Top} />
    </NodeShell>
  );
}

function EndNode({ selected }: NodeProps<RFNode>) {
  return (
    <NodeShell
      selected={!!selected}
      borderClass="border-muted-foreground/40"
      icon={<CircleStop className="w-3.5 h-3.5 text-muted-foreground" />}
      title="End"
    >
      Akhiri flow
      <Handle type="target" position={Position.Top} />
    </NodeShell>
  );
}

function ProductsNode({ data, selected }: NodeProps<RFNode>) {
  const pid = (data.productIds ?? [])[0];
  const { data: products } = useListProducts();
  const product = pid ? products?.find((p) => p.id === pid) : undefined;
  return (
    <NodeShell
      selected={!!selected}
      borderClass="border-pink-500/60"
      icon={<Package className="w-3.5 h-3.5 text-pink-500" />}
      title="Products"
    >
      {!pid && (
        <span className="italic opacity-60">(belum ada produk dipilih)</span>
      )}
      {pid && !product && (
        <span className="italic opacity-60">Produk #{pid} (tidak ditemukan)</span>
      )}
      {product && (
        <div className="space-y-0.5">
          <div className="font-medium text-foreground line-clamp-2">{product.name}</div>
          <div className="opacity-70 text-[10px]">
            {product.code} · Rp {product.price.toLocaleString("id-ID")}
          </div>
        </div>
      )}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
    </NodeShell>
  );
}

function AINode({ data, selected }: NodeProps<RFNode>) {
  return (
    <NodeShell
      selected={!!selected}
      borderClass="border-amber-500/60"
      icon={<Bot className="w-3.5 h-3.5 text-amber-500" />}
      title="AI"
    >
      <div>
        {data.text || (
          <span className="italic opacity-60">
            (AI menjawab pesan berikutnya)
          </span>
        )}
      </div>
      <Handle type="target" position={Position.Top} />
    </NodeShell>
  );
}

const nodeTypes: NodeTypes = {
  trigger: TriggerNode,
  message: MessageNode,
  question: QuestionNode,
  end: EndNode,
  ai: AINode,
  products: ProductsNode,
} as unknown as NodeTypes;

// ----- Editor body -----

function EditorInner({ flowId }: { flowId: number }) {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: flow, isLoading } = useGetFlow(flowId);

  const [name, setName] = useState("");
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!flow) return;
    setName(flow.name);
    const g = flow.graph as { nodes: RFNode[]; edges: Edge[] };
    setNodes(
      (g.nodes ?? []).map((n) => ({
        ...n,
        type: n.type as NodeKind,
        data: n.data ?? {},
      }))
    );
    setEdges(
      (g.edges ?? []).map((e) => ({
        ...e,
        sourceHandle: e.sourceHandle ?? undefined,
      }))
    );
    setDirty(false);
  }, [flow, setNodes, setEdges]);

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId) ?? null,
    [nodes, selectedId]
  );

  const markDirty = () => setDirty(true);

  const updateSelected = (patch: Partial<FlowNodeData>) => {
    if (!selectedId) return;
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selectedId ? { ...n, data: { ...n.data, ...patch } } : n
      )
    );
    // If a question's options changed, prune edges whose sourceHandle no
    // longer points at a surviving option id (otherwise the runtime would
    // dead-end and the user wouldn't see it on the canvas).
    if (patch.options !== undefined) {
      const surviving = new Set(patch.options.map((o) => o.id));
      setEdges((es) =>
        es.filter(
          (e) =>
            e.source !== selectedId ||
            !e.sourceHandle ||
            surviving.has(e.sourceHandle)
        )
      );
    }
    markDirty();
  };

  const addNode = (type: NodeKind) => {
    const id = uid(type);
    const base: RFNode = {
      id,
      type,
      position: { x: 120 + Math.random() * 240, y: 120 + Math.random() * 240 },
      data: {},
    };
    if (type === "trigger") base.data = { matchType: "keyword", keywords: [] };
    if (type === "message") base.data = { text: "" };
    if (type === "question")
      base.data = {
        text: "",
        options: [
          { id: uid("opt"), label: "Pilihan 1" },
          { id: uid("opt"), label: "Pilihan 2" },
        ],
        strictOptions: false,
      };
    if (type === "ai")
      base.data = {
        text: "Baik, silakan tanya apa saja ya 🤖 AI kami akan langsung membantu.",
      };
    if (type === "products") base.data = { productIds: [] };
    setNodes((ns) => [...ns, base]);
    setSelectedId(id);
    markDirty();
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
    markDirty();
  };

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((es) => {
        // For question source: 1 outgoing edge per option. Replace existing
        // edge from the same (source, sourceHandle).
        const filtered = es.filter(
          (e) =>
            !(
              e.source === c.source &&
              (e.sourceHandle ?? null) === (c.sourceHandle ?? null)
            )
        );
        // For non-question (trigger/message/ai/end): only 1 outgoing edge
        // total. (AI/end nodes have no outgoing edges anyway — they're
        // terminal — but treat them the same way defensively.)
        const sourceNode = nodes.find((n) => n.id === c.source);
        const stripAllFromSource =
          sourceNode && sourceNode.type !== "question";
        const cleaned = stripAllFromSource
          ? filtered.filter((e) => e.source !== c.source)
          : filtered;
        return addEdge({ ...c, id: uid("e") }, cleaned);
      });
      markDirty();
    },
    [nodes, setEdges]
  );

  const update = useUpdateFlow({
    mutation: {
      onSuccess: () => {
        setDirty(false);
        qc.invalidateQueries({ queryKey: getGetFlowQueryKey(flowId) });
        qc.invalidateQueries({ queryKey: getListFlowsQueryKey() });
        toast({ title: "Flow disimpan" });
      },
      onError: (err: any) => {
        toast({
          title: "Gagal menyimpan",
          description: err?.message ?? "Coba lagi",
          variant: "destructive",
        });
      },
    },
  });

  const activate = useActivateFlow({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetFlowQueryKey(flowId) });
        qc.invalidateQueries({ queryKey: getListFlowsQueryKey() });
        toast({ title: "Flow diaktifkan" });
      },
    },
  });

  const deactivate = useDeactivateActiveFlow({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetFlowQueryKey(flowId) });
        qc.invalidateQueries({ queryKey: getListFlowsQueryKey() });
        toast({ title: "Flow dinonaktifkan" });
      },
    },
  });

  const save = () => {
    update.mutate({
      id: flowId,
      data: {
        name: name.trim() || "Untitled",
        graph: {
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.type as NodeKind,
            position: n.position,
            data: n.data,
          })),
          edges: edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? null,
          })),
        },
      },
    });
  };

  if (isLoading || !flow) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/flows")}
          data-testid="button-back"
        >
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            markDirty();
          }}
          className="max-w-sm h-8"
          data-testid="input-flow-name"
        />
        <span
          className={
            "text-xs px-2 py-0.5 rounded " +
            (flow.isActive
              ? "bg-green-500/15 text-green-500"
              : "bg-muted text-muted-foreground")
          }
        >
          {flow.isActive ? "Aktif" : "Nonaktif"}
        </span>
        <div className="flex-1" />
        {flow.isActive ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => deactivate.mutate()}
            disabled={deactivate.isPending}
            data-testid="button-deactivate"
          >
            <PowerOff className="w-4 h-4 mr-1" /> Nonaktifkan
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => activate.mutate({ id: flowId })}
            disabled={activate.isPending}
            data-testid="button-activate"
          >
            <Power className="w-4 h-4 mr-1" /> Aktifkan
          </Button>
        )}
        <Button
          size="sm"
          onClick={save}
          disabled={update.isPending || !dirty}
          data-testid="button-save"
        >
          <Save className="w-4 h-4 mr-1" />
          {dirty ? "Simpan" : "Tersimpan"}
        </Button>
      </div>

      {/* Body: palette | canvas | inspector */}
      <div className="flex-1 flex overflow-hidden">
        {/* Palette */}
        <div className="w-44 border-r border-border p-3 space-y-2 bg-sidebar/30">
          <p className="text-xs font-medium text-muted-foreground mb-1">Tambah Node</p>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => addNode("trigger")}
            data-testid="button-add-trigger"
          >
            <Zap className="w-4 h-4 mr-2 text-green-500" /> Trigger
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => addNode("message")}
            data-testid="button-add-message"
          >
            <MessageSquare className="w-4 h-4 mr-2 text-orange-500" /> Pesan
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => addNode("question")}
            data-testid="button-add-question"
          >
            <HelpCircle className="w-4 h-4 mr-2 text-amber-500" /> Pertanyaan
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => addNode("ai")}
            data-testid="button-add-ai"
          >
            <Bot className="w-4 h-4 mr-2 text-amber-500" /> AI
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => addNode("products")}
            data-testid="button-add-products"
          >
            <Package className="w-4 h-4 mr-2 text-pink-500" /> Products
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start"
            onClick={() => addNode("end")}
            data-testid="button-add-end"
          >
            <CircleStop className="w-4 h-4 mr-2 text-muted-foreground" /> End
          </Button>
          <Separator className="my-3" />
          <p className="text-[11px] leading-snug text-muted-foreground">
            Drag tepi node ke node lain untuk menghubungkan. Klik node untuk
            mengedit di panel kanan.
          </p>
        </div>

        {/* Canvas */}
        <div className="flex-1 bg-background">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={(c) => {
              onNodesChange(c);
              if (c.some((x) => x.type === "position" && x.dragging === false)) {
                markDirty();
              }
            }}
            onEdgesChange={(c) => {
              onEdgesChange(c);
              if (c.some((x) => x.type === "remove")) markDirty();
            }}
            onConnect={onConnect}
            onNodeClick={(_e, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            fitView
            colorMode="dark"
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable className="!bg-card" />
          </ReactFlow>
        </div>

        {/* Inspector */}
        <div className="w-72 border-l border-border p-4 overflow-y-auto bg-sidebar/30">
          {!selected ? (
            <p className="text-xs text-muted-foreground">
              Pilih sebuah node untuk mengedit propertinya.
            </p>
          ) : (
            <Inspector
              node={selected}
              onChange={updateSelected}
              onDelete={deleteSelected}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function Inspector({
  node,
  onChange,
  onDelete,
}: {
  node: RFNode;
  onChange: (patch: Partial<FlowNodeData>) => void;
  onDelete: () => void;
}) {
  const t = node.type as NodeKind;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold capitalize">{t}</h3>
        <Button
          variant="ghost"
          size="icon"
          onClick={onDelete}
          data-testid="button-delete-node"
        >
          <Trash2 className="w-4 h-4 text-destructive" />
        </Button>
      </div>

      {t === "trigger" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Tipe Pemicu</Label>
            <select
              className="w-full mt-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={node.data.matchType ?? "keyword"}
              onChange={(e) =>
                onChange({ matchType: e.target.value as "default" | "keyword" })
              }
              data-testid="select-trigger-type"
            >
              <option value="keyword">Kata kunci</option>
              <option value="default">Default (semua pesan)</option>
            </select>
          </div>
          {(node.data.matchType ?? "keyword") === "keyword" && (
            <div>
              <Label className="text-xs">Kata kunci (pisah koma)</Label>
              <Input
                value={(node.data.keywords ?? []).join(", ")}
                onChange={(e) =>
                  onChange({
                    keywords: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="halo, hi, info"
                data-testid="input-keywords"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Cocok jika pesan pelanggan mengandung salah satu kata
                (case-insensitive).
              </p>
            </div>
          )}
        </div>
      )}

      {t === "message" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Teks Pesan</Label>
            <Textarea
              rows={5}
              value={node.data.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value })}
              placeholder="Halo! Selamat datang di toko kami."
              data-testid="input-message-text"
            />
          </div>
          <ImageField
            value={node.data.imageUrl ?? null}
            onChange={(url) => onChange({ imageUrl: url })}
          />
        </div>
      )}

      {t === "question" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Pertanyaan</Label>
            <Textarea
              rows={3}
              value={node.data.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value })}
              placeholder="Mau pesan apa hari ini?"
              data-testid="input-question-text"
            />
          </div>
          <ImageField
            value={node.data.imageUrl ?? null}
            onChange={(url) => onChange({ imageUrl: url })}
          />
          <div>
            <Label className="text-xs">Pilihan Jawaban</Label>
            <div className="space-y-1.5 mt-1">
              {(node.data.options ?? []).map((o, i) => (
                <div key={o.id} className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground w-4">
                    {i + 1}.
                  </span>
                  <Input
                    value={o.label}
                    onChange={(e) => {
                      const next = [...(node.data.options ?? [])];
                      next[i] = { ...next[i]!, label: e.target.value };
                      onChange({ options: next });
                    }}
                    className="h-8"
                    data-testid={`input-option-${i}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => {
                      const next = (node.data.options ?? []).filter(
                        (_, j) => j !== i
                      );
                      onChange({ options: next });
                    }}
                    data-testid={`button-remove-option-${i}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() =>
                  onChange({
                    options: [
                      ...(node.data.options ?? []),
                      {
                        id: uid("opt"),
                        label: `Pilihan ${(node.data.options ?? []).length + 1}`,
                      },
                    ],
                  })
                }
                data-testid="button-add-option"
              >
                <Plus className="w-3.5 h-3.5 mr-1" /> Tambah Pilihan
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              Hubungkan tiap pilihan (titik di sisi kanan) ke node berikutnya.
              Pelanggan bisa membalas dengan nomor (1, 2…) atau teks pilihan.
            </p>
          </div>
          <div className="flex items-start justify-between gap-3 pt-1">
            <div className="space-y-0.5">
              <Label className="text-xs">Wajib pilih dari opsi</Label>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Jika ON: jawaban di luar pilihan akan membuat pertanyaan ini
                dikirim ulang. Jika OFF: AI yang menjawab.
              </p>
            </div>
            <Switch
              data-testid="switch-strict-options"
              checked={!!node.data.strictOptions}
              onCheckedChange={(v) => onChange({ strictOptions: v })}
            />
          </div>
          {node.data.strictOptions && (
            <div>
              <Label className="text-xs">Pesan error sebelum dikirim ulang</Label>
              <Textarea
                rows={2}
                value={node.data.strictRetryMessage ?? ""}
                onChange={(e) => onChange({ strictRetryMessage: e.target.value })}
                placeholder="Anda belum memilih dengan tepat, tulis angka 1-2 untuk memilih"
                data-testid="input-strict-retry-message"
              />
              <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                Dikirim sebelum pertanyaan diulang. Kosongkan untuk langsung mengirim ulang pertanyaan tanpa pesan error.
              </p>
            </div>
          )}
        </div>
      )}

      {t === "ai" && (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Pesan pembuka (opsional)</Label>
            <Textarea
              rows={4}
              value={node.data.text ?? ""}
              onChange={(e) => onChange({ text: e.target.value })}
              placeholder="Baik, silakan tanya apa saja ya 🤖"
              data-testid="input-ai-text"
            />
            <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
              Setelah node ini, flow keluar dan AI menjawab pesan-pesan
              berikutnya selama durasi cooldown (atur di Settings). Keyword
              Trigger tetap aktif.
            </p>
          </div>
          <div>
            <Label className="text-xs">Instruksi AI khusus (opsional)</Label>
            <Textarea
              rows={4}
              value={node.data.aiInstruction ?? ""}
              onChange={(e) => onChange({ aiInstruction: e.target.value })}
              placeholder="Mis: Kamu konsultan mesin laminating. Rekomendasikan hanya dari kategori M12 sesuai kebutuhan & budget customer."
              data-testid="input-ai-instruction"
            />
            <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
              Ditambahkan ke prompt AI Studio selama AI menangani chat setelah
              node ini (sepanjang cooldown). Berguna untuk memberi "persona"
              berbeda per jalur flow. Kosongkan untuk memakai prompt global apa
              adanya.
            </p>
          </div>
        </div>
      )}

      {t === "products" && (
        <ProductsPicker
          value={node.data.productIds ?? []}
          onChange={(ids) => onChange({ productIds: ids })}
        />
      )}

      {t === "end" && (
        <p className="text-xs text-muted-foreground">
          Setelah node ini tercapai, AI biasa kembali menangani chat.
        </p>
      )}
    </div>
  );
}

function ImageField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/flows/upload-image", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Upload gagal");
      }
      const data = (await res.json()) as { url: string };
      onChange(data.url);
    } catch (err: unknown) {
      toast({
        title: "Gagal upload gambar",
        description: err instanceof Error ? err.message : "",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <Label className="text-xs">Gambar (opsional)</Label>
      <div className="mt-1 flex items-start gap-2">
        <div className="relative w-20 h-20 rounded-md border border-dashed border-border bg-muted/40 overflow-hidden flex items-center justify-center">
          {uploading ? (
            <Loader2 className="w-4 h-4 animate-spin opacity-60" />
          ) : value ? (
            <>
              <img
                src={value}
                alt="preview"
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                }}
              />
              <button
                type="button"
                onClick={() => onChange(null)}
                className="absolute top-0.5 right-0.5 bg-background/90 rounded-full p-0.5 hover:bg-destructive hover:text-destructive-foreground transition"
                data-testid="button-flow-image-clear"
                aria-label="Hapus gambar"
              >
                <XIcon className="w-3 h-3" />
              </button>
            </>
          ) : (
            <ImagePlus className="w-5 h-5 text-muted-foreground" />
          )}
        </div>
        <div className="flex-1 space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            data-testid="button-flow-image-upload"
          >
            {value ? "Ganti gambar" : "Upload gambar"}
          </Button>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Dikirim ke customer bersama teks (teks jadi caption). Maks 16MB.
          </p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
        data-testid="input-flow-image"
      />
    </div>
  );
}

function ProductsPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const { data: products, isLoading } = useListProducts();
  const [query, setQuery] = useState("");
  const selectedId = value[0];
  const list = (products ?? []).filter((p) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q);
  });
  const pick = (id: number) => {
    // Single-select: clicking the same item clears it; clicking another replaces.
    if (selectedId === id) onChange([]);
    else onChange([id]);
  };
  return (
    <div className="space-y-2">
      <Label className="text-xs">Pilih produk yang akan dikirim</Label>
      <p className="text-[11px] text-muted-foreground leading-snug">
        Pilih 1 produk. Akan dikirim sebagai foto dengan caption: Nama, Kode,
        Harga. Untuk mengirim beberapa produk, buat node Products terpisah.
      </p>
      <Input
        placeholder="Cari nama atau kode…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8 text-xs"
        data-testid="input-products-search"
      />
      <div className="text-[11px] text-muted-foreground">
        {selectedId ? "1 produk dipilih" : "Belum ada produk dipilih"}
        {selectedId !== undefined && (
          <button
            type="button"
            className="ml-2 underline hover:text-foreground"
            onClick={() => onChange([])}
            data-testid="button-products-clear"
          >
            Kosongkan
          </button>
        )}
      </div>
      <div className="border border-border rounded-md max-h-64 overflow-y-auto divide-y divide-border/60">
        {isLoading && (
          <div className="p-3 text-xs text-muted-foreground">Memuat produk…</div>
        )}
        {!isLoading && list.length === 0 && (
          <div className="p-3 text-xs text-muted-foreground italic">
            {(products ?? []).length === 0
              ? "Belum ada produk. Tambahkan di halaman Products dulu."
              : "Tidak ada produk yang cocok."}
          </div>
        )}
        {list.map((p) => {
          const isOn = selectedId === p.id;
          return (
            <button
              type="button"
              key={p.id}
              onClick={() => pick(p.id)}
              className={`flex items-center gap-2 w-full px-2 py-1.5 text-left text-xs hover:bg-accent ${
                isOn ? "bg-accent/60" : ""
              }`}
              data-testid={`button-product-toggle-${p.id}`}
            >
              <input
                type="radio"
                checked={isOn}
                readOnly
                className="pointer-events-none"
              />
              {p.imageUrl ? (
                <img
                  src={p.imageUrl}
                  alt=""
                  className="w-8 h-8 rounded object-cover bg-muted shrink-0"
                />
              ) : (
                <div className="w-8 h-8 rounded bg-muted shrink-0 flex items-center justify-center">
                  <Package className="w-3.5 h-3.5 text-muted-foreground" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="truncate font-medium text-foreground">{p.name}</div>
                <div className="truncate text-muted-foreground">
                  {p.code} · Rp {p.price.toLocaleString("id-ID")}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function FlowEditor() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  if (!Number.isInteger(id)) {
    return <div className="p-6 text-sm text-muted-foreground">Flow tidak ditemukan.</div>;
  }
  return (
    <ReactFlowProvider>
      <EditorInner flowId={id} />
    </ReactFlowProvider>
  );
}
