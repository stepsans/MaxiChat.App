import type { ReactNode } from "react";
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Crown, Edit2, Eye, Trash2 } from "lucide-react";
import type { WorkboardMember } from "@/hooks/useBoardDetail";

interface InvitableUser {
  id: number;
  name: string | null;
  email: string;
}

interface InviteMemberModalProps {
  open: boolean;
  onClose: () => void;
  boardId: number;
  members: WorkboardMember[];
  myRole: string;
  onInvite: (userId: number, role: string) => Promise<void>;
  onUpdateRole: (memberId: number, role: string) => Promise<void>;
  onRemove: (memberId: number) => Promise<void>;
}

const ROLE_ICONS: Record<string, ReactNode> = {
  owner: <Crown className="w-3 h-3" />,
  editor: <Edit2 className="w-3 h-3" />,
  viewer: <Eye className="w-3 h-3" />,
};
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  editor: "Editor",
  viewer: "Viewer",
};
const ROLE_COLORS: Record<string, string> = {
  owner: "bg-amber-100 text-amber-800 border-amber-200",
  editor: "bg-blue-100 text-blue-800 border-blue-200",
  viewer: "bg-gray-100 text-gray-700 border-gray-200",
};

export default function InviteMemberModal({
  open,
  onClose,
  boardId,
  members,
  myRole,
  onInvite,
  onUpdateRole,
  onRemove,
}: InviteMemberModalProps) {
  const [invitableUsers, setInvitableUsers] = useState<InvitableUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState("editor");
  const [loading, setLoading] = useState(false);
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch(`/api/workboard/boards/${boardId}/invitable-users`, { credentials: "include" })
      .then((r) => r.json())
      .then((d) => setInvitableUsers(d.users ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open, boardId, members.length]);

  async function handleInvite() {
    if (!selectedUserId) return;
    setInviting(true);
    try {
      await onInvite(Number(selectedUserId), selectedRole);
      setSelectedUserId("");
      setSelectedRole("editor");
    } finally {
      setInviting(false);
    }
  }

  const isOwner = myRole === "owner";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Kelola Member Board</DialogTitle>
        </DialogHeader>

        {isOwner && (
          <div className="space-y-3 border rounded-lg p-3 bg-muted/30">
            <p className="text-sm font-medium">Undang Member Baru</p>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Pilih user</Label>
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger>
                  <SelectValue placeholder={loading ? "Memuat..." : "Pilih user untuk diundang"} />
                </SelectTrigger>
                <SelectContent>
                  {invitableUsers.map((u) => (
                    <SelectItem key={u.id} value={String(u.id)}>
                      {u.name ?? u.email}
                      {u.name && (
                        <span className="text-muted-foreground text-xs ml-1">({u.email})</span>
                      )}
                    </SelectItem>
                  ))}
                  {invitableUsers.length === 0 && !loading && (
                    <SelectItem value="__none" disabled>
                      Semua user sudah menjadi member
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Role</Label>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="editor">
                    <div>
                      <p className="font-medium">Editor</p>
                      <p className="text-xs text-muted-foreground">Bisa buat, edit, hapus task</p>
                    </div>
                  </SelectItem>
                  <SelectItem value="viewer">
                    <div>
                      <p className="font-medium">Viewer</p>
                      <p className="text-xs text-muted-foreground">Hanya bisa melihat</p>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              className="w-full"
              onClick={handleInvite}
              disabled={!selectedUserId || inviting}
              size="sm"
            >
              {inviting ? "Mengundang..." : "Undang"}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium">Member ({members.length})</p>
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {members.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2 p-2 rounded-lg border bg-card"
              >
                <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium flex-shrink-0">
                  {(m.name ?? m.email ?? "?").slice(0, 1).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{m.name ?? m.email}</p>
                  {m.name && <p className="text-xs text-muted-foreground truncate">{m.email}</p>}
                </div>
                <div className="flex items-center gap-1">
                  {isOwner ? (
                    <Select
                      value={m.role}
                      onValueChange={(role) => onUpdateRole(m.id, role)}
                    >
                      <SelectTrigger className="h-7 text-xs w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="owner">Owner</SelectItem>
                        <SelectItem value="editor">Editor</SelectItem>
                        <SelectItem value="viewer">Viewer</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <span
                      className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${ROLE_COLORS[m.role] ?? ""}`}
                    >
                      {ROLE_ICONS[m.role]}
                      {ROLE_LABELS[m.role]}
                    </span>
                  )}
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => onRemove(m.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
