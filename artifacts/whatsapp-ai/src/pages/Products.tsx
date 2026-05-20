import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProducts,
  useCreateProduct,
  useUpdateProduct,
  useDeleteProduct,
  getListProductsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Label } from "@/components/ui/label";
import {
  Plus,
  Pencil,
  Trash2,
  Package,
  Loader2,
  ImagePlus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Product = {
  id: number;
  code: string;
  name: string;
  price: number;
  imageUrl: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

const formatIDR = (n: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);

export default function Products() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState<string>("");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const imgInputRef = useRef<HTMLInputElement | null>(null);

  const { data: products, isLoading } = useListProducts();

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListProductsQueryKey() });

  const create = useCreateProduct({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDialogOpen(false);
        toast({ title: "Produk ditambahkan." });
      },
      onError: (e: any) =>
        toast({
          title: "Gagal menambah produk",
          description: e?.message ?? "",
          variant: "destructive",
        }),
    },
  });
  const update = useUpdateProduct({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDialogOpen(false);
        toast({ title: "Produk diperbarui." });
      },
      onError: (e: any) =>
        toast({
          title: "Gagal memperbarui produk",
          description: e?.message ?? "",
          variant: "destructive",
        }),
    },
  });
  const remove = useDeleteProduct({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDeleteId(null);
        toast({ title: "Produk dihapus." });
      },
    },
  });

  const resetForm = () => {
    setCode("");
    setName("");
    setPrice("");
    setDescription("");
    setImageUrl(null);
  };

  const openCreate = () => {
    setEditing(null);
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setCode(p.code);
    setName(p.name);
    setPrice(String(p.price));
    setDescription(p.description ?? "");
    setImageUrl(p.imageUrl);
    setDialogOpen(true);
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingImg(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/products/upload-image", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || "Upload gagal");
      }
      const data = (await res.json()) as { url: string };
      setImageUrl(data.url);
    } catch (err: any) {
      toast({
        title: "Gagal upload gambar",
        description: err?.message ?? "",
        variant: "destructive",
      });
    } finally {
      setUploadingImg(false);
    }
  };

  const handleSubmit = () => {
    const trimmedCode = code.trim();
    const trimmedName = name.trim();
    const priceNum = Number(price);
    if (!trimmedCode || !trimmedName) {
      toast({ title: "Kode dan nama wajib diisi", variant: "destructive" });
      return;
    }
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      toast({ title: "Harga tidak valid", variant: "destructive" });
      return;
    }
    const data = {
      code: trimmedCode,
      name: trimmedName,
      price: priceNum,
      imageUrl: imageUrl ?? null,
      description: description.trim() || null,
    };
    if (editing) {
      update.mutate({ id: editing.id, data });
    } else {
      create.mutate({ data });
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <div className="flex flex-col h-full overflow-auto">
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Katalog Produk</h1>
          <p className="text-xs text-muted-foreground">
            {products?.length ?? 0} produk — dapat dikirim ke chat customer
          </p>
        </div>
        <Button data-testid="button-add-product" size="sm" onClick={openCreate}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Tambah Produk
        </Button>
      </div>

      <div className="flex-1 p-6">
        {isLoading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array(8)
              .fill(0)
              .map((_, i) => (
                <Skeleton key={i} className="h-56 rounded-lg" />
              ))}
          </div>
        ) : !products || products.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Package className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">Belum ada produk</p>
            <p className="text-xs mt-1">Tambahkan produk untuk dikirim ke customer</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map((p) => (
              <Card
                key={p.id}
                data-testid={`product-card-${p.id}`}
                className="group relative overflow-hidden flex flex-col"
              >
                <div className="aspect-square bg-secondary flex items-center justify-center overflow-hidden">
                  {p.imageUrl ? (
                    <img
                      src={p.imageUrl}
                      alt={p.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Package className="w-10 h-10 opacity-30" />
                  )}
                </div>
                <div className="p-3 space-y-1 flex-1 flex flex-col">
                  <p className="text-[10px] text-muted-foreground font-mono">
                    {p.code}
                  </p>
                  <p className="text-sm font-medium line-clamp-2">{p.name}</p>
                  <p className="text-sm font-semibold text-primary mt-auto">
                    {formatIDR(p.price)}
                  </p>
                </div>
                <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button
                    data-testid={`button-edit-product-${p.id}`}
                    variant="secondary"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => openEdit(p as Product)}
                  >
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button
                    data-testid={`button-delete-product-${p.id}`}
                    variant="secondary"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => setDeleteId(p.id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Produk" : "Tambah Produk"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div
                onClick={() => imgInputRef.current?.click()}
                className="w-28 h-28 rounded-md border border-dashed border-border bg-secondary flex items-center justify-center overflow-hidden cursor-pointer hover:bg-accent/50 flex-shrink-0"
              >
                {uploadingImg ? (
                  <Loader2 className="w-5 h-5 animate-spin opacity-60" />
                ) : imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="preview"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center text-muted-foreground gap-1">
                    <ImagePlus className="w-5 h-5" />
                    <span className="text-[10px]">Gambar</span>
                  </div>
                )}
              </div>
              <input
                ref={imgInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleImageSelect}
                data-testid="input-product-image"
              />
              <div className="flex-1 space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="product-code" className="text-xs">
                    Kode Barang
                  </Label>
                  <Input
                    id="product-code"
                    data-testid="input-product-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="SKU-001"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="product-price" className="text-xs">
                    Harga (Rp)
                  </Label>
                  <Input
                    id="product-price"
                    data-testid="input-product-price"
                    type="number"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="150000"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1">
              <Label htmlFor="product-name" className="text-xs">
                Nama Barang
              </Label>
              <Input
                id="product-name"
                data-testid="input-product-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Serum Vitamin C Premium"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="product-desc" className="text-xs">
                Deskripsi (opsional)
              </Label>
              <Textarea
                id="product-desc"
                data-testid="textarea-product-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Penjelasan singkat produk..."
                rows={3}
                className="resize-none"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
            >
              Batal
            </Button>
            <Button
              data-testid="button-save-product"
              onClick={handleSubmit}
              disabled={isPending || uploadingImg}
            >
              {isPending && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              {editing ? "Simpan" : "Tambah"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus Produk</AlertDialogTitle>
            <AlertDialogDescription>
              Produk ini akan dihapus permanen.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-delete-product"
              onClick={() => deleteId && remove.mutate({ id: deleteId })}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
