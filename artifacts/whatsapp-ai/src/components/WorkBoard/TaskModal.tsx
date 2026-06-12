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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import type { WorkboardTask, WorkboardColumn, WorkboardMember } from "@/hooks/useBoardDetail";

interface TaskModalProps {
  open: boolean;
  onClose: () => void;
  onSave: (data: {
    title: string;
    description?: string;
    columnId?: number | null;
    priority?: string;
    dueDate?: string;
    tags?: string;
    assigneeIds?: number[];
  }) => Promise<void>;
  onDelete?: () => Promise<void>;
  columns: WorkboardColumn[];
  members: WorkboardMember[];
  task?: WorkboardTask | null;
  readOnly?: boolean;
}

const PRIORITY_LABELS: Record<string, string> = {
  low: "Rendah",
  medium: "Sedang",
  high: "Tinggi",
};

export default function TaskModal({
  open,
  onClose,
  onSave,
  onDelete,
  columns,
  members,
  task,
  readOnly = false,
}: TaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnId, setColumnId] = useState<string>("");
  const [priority, setPriority] = useState("medium");
  const [dueDate, setDueDate] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [assigneeIds, setAssigneeIds] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (task) {
      setTitle(task.title);
      setDescription(task.description ?? "");
      setColumnId(task.columnId !== null && task.columnId !== undefined ? String(task.columnId) : "");
      setPriority(task.priority);
      setDueDate(task.dueDate ? task.dueDate.slice(0, 10) : "");
      setTags(task.tags ? task.tags.split(",").map((t) => t.trim()).filter(Boolean) : []);
      setAssigneeIds(task.assignees.map((a) => a.userId));
    } else {
      setTitle("");
      setDescription("");
      setColumnId(columns[0] ? String(columns[0].id) : "");
      setPriority("medium");
      setDueDate("");
      setTags([]);
      setAssigneeIds([]);
    }
  }, [task, columns, open]);

  async function handleSave() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        description: description.trim() || undefined,
        columnId: columnId ? Number(columnId) : null,
        priority,
        dueDate: dueDate || undefined,
        tags: tags.join(",") || undefined,
        assigneeIds,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    setDeleting(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  function addTag() {
    const t = tagInput.trim();
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  }

  function toggleAssignee(userId: number) {
    setAssigneeIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{task ? "Edit Task" : "Buat Task Baru"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label>Judul *</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Judul task"
              disabled={readOnly}
            />
          </div>

          <div className="space-y-1">
            <Label>Deskripsi</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Deskripsi (opsional)"
              rows={3}
              disabled={readOnly}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Status / Kolom</Label>
              <Select value={columnId} onValueChange={setColumnId} disabled={readOnly}>
                <SelectTrigger>
                  <SelectValue placeholder="Pilih kolom" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Tidak ada kolom</SelectItem>
                  {columns.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Prioritas</Label>
              <Select value={priority} onValueChange={setPriority} disabled={readOnly}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">Tinggi</SelectItem>
                  <SelectItem value="medium">Sedang</SelectItem>
                  <SelectItem value="low">Rendah</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>Tenggat Waktu</Label>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={readOnly}
            />
          </div>

          <div className="space-y-1">
            <Label>Assignee</Label>
            <div className="flex flex-wrap gap-2">
              {members.map((m) => {
                const selected = assigneeIds.includes(m.userId);
                return (
                  <button
                    key={m.userId}
                    type="button"
                    onClick={() => !readOnly && toggleAssignee(m.userId)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs border transition-colors ${
                      selected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted text-muted-foreground border-border hover:bg-accent"
                    } ${readOnly ? "cursor-default" : ""}`}
                  >
                    <span className="w-5 h-5 rounded-full bg-current/20 flex items-center justify-center font-medium text-[10px]">
                      {(m.name ?? m.email ?? "?").slice(0, 1).toUpperCase()}
                    </span>
                    {m.name ?? m.email}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label>Tags</Label>
            <div className="flex gap-2">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); addTag(); }
                }}
                placeholder="Ketik tag lalu Enter"
                disabled={readOnly}
              />
              {!readOnly && (
                <Button type="button" variant="outline" size="sm" onClick={addTag}>
                  Tambah
                </Button>
              )}
            </div>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1">
                    {tag}
                    {!readOnly && (
                      <X
                        className="w-3 h-3 cursor-pointer"
                        onClick={() => setTags(tags.filter((t) => t !== tag))}
                      />
                    )}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex justify-between">
          <div>
            {task && onDelete && !readOnly && (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
                size="sm"
              >
                {deleting ? "Menghapus..." : "Hapus Task"}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Batal
            </Button>
            {!readOnly && (
              <Button onClick={handleSave} disabled={saving || !title.trim()}>
                {saving ? "Menyimpan..." : "Simpan"}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
