import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#64748b",
];

const EMOJIS = [
  // existing
  "📋", "🚀", "🎯", "💡", "🛠️", "📊", "🎨", "📱", "🌟", "🔥",
  // added (business / sales / logistics)
  "⚙️", "📈", "🤝", "📦", "🚚", "👥", "🧑‍💼", "💰", "💳", "💵", "🛒", "📑", "💻", "🖥️",
];

interface BoardModalProps {
  open: boolean;
  onClose: () => void;
  mode?: "create" | "edit";
  // Required when mode === "edit": pre-fills the form.
  initial?: {
    id: number;
    name: string;
    description?: string | null;
    color: string;
    emoji?: string | null;
  };
  onSubmit: (data: {
    name: string;
    description?: string;
    color?: string;
    emoji?: string;
  }) => Promise<void>;
}

export default function CreateBoardModal({
  open,
  onClose,
  mode = "create",
  initial,
  onSubmit,
}: BoardModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [emoji, setEmoji] = useState("");
  const [saving, setSaving] = useState(false);

  // Sync form with edit target (or reset for create) whenever the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && initial) {
      setName(initial.name);
      setDescription(initial.description ?? "");
      setColor(initial.color);
      setEmoji(initial.emoji ?? "");
    } else {
      setName("");
      setDescription("");
      setColor(COLORS[0]);
      setEmoji("");
    }
  }, [open, mode, initial]);

  async function handleSubmit() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        color,
        emoji: emoji || undefined,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const isEdit = mode === "edit";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Board" : "Buat Board Baru"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Nama Board *</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nama board"
              maxLength={100}
            />
          </div>

          <div className="space-y-1">
            <Label>Deskripsi</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Deskripsi singkat (opsional)"
              rows={2}
            />
          </div>

          <div className="space-y-1">
            <Label>Warna Board</Label>
            <div className="flex gap-2 flex-wrap">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`w-7 h-7 rounded-full border-2 transition-transform hover:scale-110 ${
                    color === c ? "border-foreground scale-110" : "border-transparent"
                  }`}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label>Emoji Ikon (opsional)</Label>
            <div className="flex gap-2 flex-wrap">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`w-9 h-9 text-xl rounded border transition-colors ${
                    emoji === e ? "bg-primary/10 border-primary" : "border-border hover:bg-accent"
                  }`}
                  onClick={() => setEmoji(emoji === e ? "" : e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Batal
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !name.trim()}>
            {saving ? "Menyimpan..." : isEdit ? "Simpan" : "Buat Board"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
