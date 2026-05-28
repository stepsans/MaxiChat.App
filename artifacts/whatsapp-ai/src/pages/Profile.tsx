import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Camera, Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Profile() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useGetMe({
    query: { queryKey: ["/api/auth/me"] },
  });
  const user = data?.user ?? null;
  const isSuperAdmin = user?.teamRole === "super_admin";

  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Hydrate the form once the /me request returns. We intentionally don't
  // sync on every change so the user's in-progress edits aren't blown away
  // by background refetches.
  useEffect(() => {
    if (user) {
      setName(user.name ?? "");
      setCompanyName(user.companyName ?? "");
    }
  }, [user?.id]);

  if (isLoading || !user) {
    return (
      <div className="p-6 space-y-4 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const dirty =
    name.trim() !== (user.name ?? "") ||
    (isSuperAdmin && companyName.trim() !== (user.companyName ?? ""));

  async function uploadPhoto(file: File) {
    setPhotoBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const up = await fetch("/api/agents/upload-photo", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!up.ok) throw new Error("Upload gagal");
      const { url } = (await up.json()) as { url: string };
      const patch = await fetch("/api/auth/me/photo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profilePhotoUrl: url }),
      });
      if (!patch.ok) throw new Error("Simpan foto gagal");
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      toast({ title: "Foto profil diperbarui" });
    } catch (err) {
      toast({
        title: "Gagal mengganti foto",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    setPhotoBusy(true);
    try {
      const r = await fetch("/api/auth/me/photo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ profilePhotoUrl: "" }),
      });
      if (!r.ok) throw new Error("Hapus foto gagal");
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      toast({ title: "Foto profil dihapus" });
    } catch (err) {
      toast({
        title: "Gagal menghapus foto",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setPhotoBusy(false);
    }
  }

  async function saveProfile() {
    if (!dirty) return;
    setSaving(true);
    try {
      const body: Record<string, string> = { name: name.trim() };
      if (isSuperAdmin) body.companyName = companyName.trim();
      const r = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? "Simpan gagal");
      }
      await qc.invalidateQueries({ queryKey: getGetMeQueryKey() });
      toast({ title: "Profil disimpan" });
    } catch (err) {
      toast({
        title: "Gagal menyimpan",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  const initial = (name.trim()[0] ?? user.email[0] ?? "?").toUpperCase();

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-6 h-14 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 flex-shrink-0">
        <div className="min-w-0">
          <h1 className="text-base font-semibold">Profil Saya</h1>
          <p className="text-xs text-muted-foreground truncate">
            Ubah nama, foto, dan informasi akun Anda
          </p>
        </div>
        <Button
          onClick={saveProfile}
          disabled={!dirty || saving}
          data-testid="button-save-profile"
        >
          {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
          Simpan
        </Button>
      </div>

      <div className="p-6 space-y-6 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Foto Profil</CardTitle>
            <CardDescription>
              Foto akan muncul di sidebar dan daftar percakapan.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <div className="relative w-20 h-20 rounded-full ring-2 ring-border overflow-hidden flex-shrink-0">
                {user.profilePhotoUrl ? (
                  <img
                    src={user.profilePhotoUrl}
                    alt={user.name ?? "Foto profil"}
                    className="w-full h-full object-cover"
                    data-testid="profile-photo"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center text-white text-2xl font-bold">
                    {initial}
                  </div>
                )}
                {photoBusy && (
                  <div className="absolute inset-0 bg-black/45 flex items-center justify-center text-white">
                    <Loader2 className="w-5 h-5 animate-spin" />
                  </div>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadPhoto(f);
                    e.target.value = "";
                  }}
                  data-testid="input-profile-photo"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={photoBusy}
                  onClick={() => fileRef.current?.click()}
                  data-testid="button-upload-photo"
                >
                  <Camera className="w-4 h-4 mr-2" />
                  {user.profilePhotoUrl ? "Ganti Foto" : "Upload Foto"}
                </Button>
                {user.profilePhotoUrl && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={photoBusy}
                    onClick={removePhoto}
                    data-testid="button-remove-photo"
                  >
                    <Trash2 className="w-4 h-4 mr-2" />
                    Hapus Foto
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Informasi Akun</CardTitle>
            <CardDescription>
              Email tidak bisa diubah. Hubungi admin jika perlu mengganti email.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Nama</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="Nama Anda"
                data-testid="input-profile-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                value={user.email}
                disabled
                data-testid="input-profile-email"
              />
            </div>
            {isSuperAdmin && (
              <div className="space-y-1.5">
                <Label htmlFor="profile-company">Nama Perusahaan</Label>
                <Input
                  id="profile-company"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  maxLength={120}
                  placeholder="PT Contoh Indonesia"
                  data-testid="input-profile-company"
                />
                <p className="text-xs text-muted-foreground">
                  Muncul di sidebar tim Anda dan di email notifikasi.
                </p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Peran</Label>
              <div className="text-sm text-muted-foreground">
                {user.teamRole === "super_admin"
                  ? "Super Admin"
                  : user.teamRole === "supervisor"
                    ? "Supervisor"
                    : "Agen"}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
