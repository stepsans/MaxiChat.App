import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFlows,
  useCreateFlow,
  useDeleteFlow,
  useActivateFlow,
  useDeactivateActiveFlow,
  getListFlowsQueryKey,
} from "@workspace/api-client-react";
import { Plus, Trash2, Power, PowerOff, Pencil, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

export default function Flows() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: flows, isLoading } = useListFlows();
  const [name, setName] = useState("");

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
  const deactivate = useDeactivateActiveFlow({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Semua flow dinonaktifkan" });
      },
    },
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="border-b border-border px-6 py-4 flex items-center gap-3">
        <GitBranch className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-lg font-semibold">Chatbot Flow</h1>
          <p className="text-xs text-muted-foreground">
            Susun alur balasan otomatis. Hanya 1 flow yang aktif untuk semua chat.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        <form
          className="flex gap-2 max-w-md"
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
                className="border border-border rounded-lg p-4 flex items-center justify-between bg-card hover-elevate"
                data-testid={`row-flow-${f.id}`}
              >
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
                      <Pencil className="w-4 h-4 mr-1" /> Edit
                    </Button>
                  </Link>
                  {f.isActive ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={deactivate.isPending}
                      onClick={() => deactivate.mutate()}
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
                  )}
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
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
