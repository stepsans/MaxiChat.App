import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const COLORS = [
  "#6366f1", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#64748b",
];

const EMOJIS = ["📋", "🚀", "🎯", "💡", "🛠️", "📊", "🎨", "📱", "🌟", "🔥"];

interface CreateBoardModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (data: {
    name: string;
    description?: string;
    defaultView?: string;
    color?: string;
    emoji?: string;
  }) => Promise<void>;
}

export default function CreateBoardModal({ open, onClose, onCreate }: CreateBoardModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultView, setDefaultView] = useState("kanban");
  const [color, setColor] = useState(COLORS[0]);
  const [emoji, setEmoji] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim() || undefined,
        defaultView,
        color,
        emoji: emoji || undefined,
      });
      setName("");
      setDescription("");
      setDefaultView("kanban");
      setColor(COLORS[0]);
      setEmoji("");
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Buat Board Baru</DialogTitle>
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
            <Label>Tampilan Default</Label>
            <Select value={defaultView} onValueChange={setDefaultView}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kanban">Kanban</SelectItem>
                <SelectItem value="table">Table</SelectItem>
                <SelectItem value="todo">Todo List</SelectItem>
              </SelectContent>
            </Select>
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
          <Button onClick={handleCreate} disabled={saving || !name.trim()}>
            {saving ? "Membuat..." : "Buat Board"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
