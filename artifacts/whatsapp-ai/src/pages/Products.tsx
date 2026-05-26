import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListProducts,
  useCreateProduct,
  useUpdateProduct,
  useDeleteProduct,
  useSyncProductsToKnowledge,
  getListProductsQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import {
  Plus,
  Pencil,
  Trash2,
  Package,
  Loader2,
  ImagePlus,
  Upload,
  Download,
  BookOpen,
  ExternalLink,
  Video,
  Search,
  X,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
  ChevronsUpDown,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { resolveImageSrc } from "@/lib/utils";
import ProductSyncCard from "@/components/ProductSyncCard";

type Product = {
  id: number;
  code: string;
  name: string;
  category: string | null;
  price: number;
  priceSilver: number | null;
  priceGold: number | null;
  pricePlatinum: number | null;
  priceReseller: number | null;
  priceDistributor: number | null;
  imageUrl: string | null;
  flyerUrl: string | null;
  productUrl: string | null;
  videoUrls: string[];
  createdAt: string;
  updatedAt: string;
};

const formatIDR = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
};

const numOrNull = (s: string): number | null => {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && Number.isInteger(n) && n >= 0 ? n : null;
};

const strOrNull = (s: string): string | null => {
  const t = s.trim();
  return t.length > 0 ? t : null;
};

type SortKey =
  | "id"
  | "code"
  | "category"
  | "name"
  | "price"
  | "priceSilver"
  | "priceGold"
  | "pricePlatinum"
  | "priceReseller"
  | "priceDistributor";

function getSortValue(p: Product, key: SortKey): string | number | null {
  switch (key) {
    case "id":
      return p.id;
    case "code":
      return p.code ?? "";
    case "category":
      return p.category ?? "";
    case "name":
      return p.name ?? "";
    case "price":
      return p.price;
    case "priceSilver":
      return p.priceSilver;
    case "priceGold":
      return p.priceGold;
    case "pricePlatinum":
      return p.pricePlatinum;
    case "priceReseller":
      return p.priceReseller;
    case "priceDistributor":
      return p.priceDistributor;
  }
}

function SortableTh({
  sortKey,
  label,
  sortBy,
  sortDir,
  onToggle,
  align = "left",
  className = "",
}: {
  sortKey: SortKey;
  label: string;
  sortBy: SortKey | null;
  sortDir: "asc" | "desc";
  onToggle: (k: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sortBy === sortKey;
  const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={`px-3 py-2 font-medium ${align === "right" ? "text-right" : ""} ${className}`}>
      <button
        type="button"
        onClick={() => onToggle(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${
          active ? "text-foreground" : "text-muted-foreground"
        } ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        <span>{label}</span>
        <Icon className={`w-3 h-3 ${active ? "opacity-100" : "opacity-50"}`} />
      </button>
    </th>
  );
}

export default function Products() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("__all__");
  // Internal tier prices (silver/gold/platinum/reseller/distributor) are
  // sensitive — only shown in-app, never to customers. Default to hidden
  // so casual screen-sharing doesn't leak them; user can toggle on demand.
  const [showInternalPrices, setShowInternalPrices] = useState(false);
  const [sortBy, setSortBy] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  function toggleSort(key: SortKey) {
    if (sortBy !== key) {
      setSortBy(key);
      setSortDir("asc");
    } else if (sortDir === "asc") {
      setSortDir("desc");
    } else {
      setSortBy(null);
      setSortDir("asc");
    }
  }

  const emptyForm = {
    code: "",
    name: "",
    category: "",
    price: "",
    priceSilver: "",
    priceGold: "",
    pricePlatinum: "",
    priceReseller: "",
    priceDistributor: "",
    productUrl: "",
    flyerUrl: "",
  };
  const [form, setForm] = useState({ ...emptyForm });
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploadingImg, setUploadingImg] = useState(false);
  const imgInputRef = useRef<HTMLInputElement | null>(null);

  const { data: products, isLoading } = useListProducts();
  const invalidate = () => qc.invalidateQueries({ queryKey: getListProductsQueryKey() });

  const create = useCreateProduct({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDialogOpen(false);
        toast({ title: "Produk ditambahkan." });
      },
      onError: (e: unknown) =>
        toast({
          title: "Gagal menambah produk",
          description: e instanceof Error ? e.message : "",
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
      onError: (e: unknown) =>
        toast({
          title: "Gagal memperbarui produk",
          description: e instanceof Error ? e.message : "",
          variant: "destructive",
        }),
    },
  });
  const syncKb = useSyncProductsToKnowledge({
    mutation: {
      onSuccess: (data: unknown) => {
        const d = data as { synced?: number; contentChars?: number };
        const kb = d?.contentChars ? Math.round(d.contentChars / 1024) : 0;
        const sizeWarn =
          kb > 100
            ? ` ⚠️ Ukuran ~${kb} KB — biaya token AI per pesan masuk akan naik. Pertimbangkan menjaga katalog tetap ringkas.`
            : kb > 0
              ? ` Ukuran ~${kb} KB.`
              : "";
        toast({
          title: "Sync ke Knowledge Base berhasil",
          description: `${d?.synced ?? 0} produk dimasukkan.${sizeWarn}`,
        });
      },
      onError: (e: unknown) =>
        toast({
          title: "Gagal sync ke Knowledge Base",
          description: e instanceof Error ? e.message : "",
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

  const openCreate = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setImageUrl(null);
    setVideoUrls([]);
    setDialogOpen(true);
  };

  const openEdit = (p: Product) => {
    setEditing(p);
    setForm({
      code: p.code,
      name: p.name,
      category: p.category ?? "",
      price: String(p.price),
      priceSilver: p.priceSilver !== null ? String(p.priceSilver) : "",
      priceGold: p.priceGold !== null ? String(p.priceGold) : "",
      pricePlatinum: p.pricePlatinum !== null ? String(p.pricePlatinum) : "",
      priceReseller: p.priceReseller !== null ? String(p.priceReseller) : "",
      priceDistributor: p.priceDistributor !== null ? String(p.priceDistributor) : "",
      productUrl: p.productUrl ?? "",
      flyerUrl: p.flyerUrl ?? "",
    });
    setImageUrl(p.imageUrl);
    setVideoUrls(p.videoUrls ?? []);
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
    } catch (err: unknown) {
      toast({
        title: "Gagal upload gambar",
        description: err instanceof Error ? err.message : "",
        variant: "destructive",
      });
    } finally {
      setUploadingImg(false);
    }
  };

  const handleSubmit = () => {
    const code = form.code.trim();
    const name = form.name.trim();
    const price = numOrNull(form.price);
    if (!code || !name) {
      toast({ title: "Kode dan nama wajib diisi", variant: "destructive" });
      return;
    }
    if (price === null) {
      toast({ title: "Harga Pricelist tidak valid", variant: "destructive" });
      return;
    }
    const data = {
      code,
      name,
      category: strOrNull(form.category),
      price,
      priceSilver: numOrNull(form.priceSilver),
      priceGold: numOrNull(form.priceGold),
      pricePlatinum: numOrNull(form.pricePlatinum),
      priceReseller: numOrNull(form.priceReseller),
      priceDistributor: numOrNull(form.priceDistributor),
      imageUrl: imageUrl ?? null,
      flyerUrl: form.flyerUrl.trim() ? form.flyerUrl.trim() : null,
      productUrl: strOrNull(form.productUrl),
      videoUrls: videoUrls.map((s) => s.trim()).filter((s) => s.length > 0).slice(0, 10),
    };
    if (editing) {
      update.mutate({ id: editing.id, data });
    } else {
      create.mutate({ data });
    }
  };

  const handleImportClick = () => importInputRef.current?.click();

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/products/import", { method: "POST", body: fd });
      const json = (await res.json().catch(() => ({}))) as {
        imported?: number;
        skipped?: number;
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Import gagal");
      invalidate();
      toast({
        title: `Import sukses: ${json.imported ?? 0} produk`,
        description:
          json.skipped && json.skipped > 0
            ? `${json.skipped} baris dilewati`
            : "Semua data lama telah diganti.",
      });
    } catch (err: unknown) {
      toast({
        title: "Gagal import",
        description: err instanceof Error ? err.message : "",
        variant: "destructive",
      });
    } finally {
      setImporting(false);
    }
  };

  const handleExport = (format: "csv" | "xlsx") => {
    window.location.href = `/api/products/export.${format}`;
  };

  const isPending = create.isPending || update.isPending;

  const q = search.trim().toLowerCase();
  const allProducts = (products as Product[] | undefined) ?? [];

  // Distinct categories from the current catalog, sorted alpabetis (id-ID,
  // case-insensitive). "__none__" represents produk tanpa kategori.
  const categoryOptions = (() => {
    const seen = new Set<string>();
    let hasUncategorized = false;
    for (const p of allProducts) {
      const c = (p.category ?? "").trim();
      if (c) seen.add(c);
      else hasUncategorized = true;
    }
    const list = Array.from(seen).sort((a, b) =>
      a.localeCompare(b, "id-ID", { sensitivity: "base" })
    );
    return { list, hasUncategorized };
  })();

  const filteredProducts = allProducts.filter((p) => {
    if (categoryFilter !== "__all__") {
      const c = (p.category ?? "").trim();
      if (categoryFilter === "__none__") {
        if (c) return false;
      } else if (c !== categoryFilter) {
        return false;
      }
    }
    if (q) {
      return [p.code, p.name, p.category ?? ""].some((f) =>
        f.toLowerCase().includes(q)
      );
    }
    return true;
  });
  if (sortBy) {
    const dir = sortDir === "asc" ? 1 : -1;
    filteredProducts.sort((a, b) => {
      const av = getSortValue(a, sortBy);
      const bv = getSortValue(b, sortBy);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv), "id-ID", { sensitivity: "base" }) * dir;
    });
  }
  const isFiltered = q.length > 0 || categoryFilter !== "__all__";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between px-6 h-14 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold">Katalog Produk</h1>
          <p className="text-xs text-muted-foreground">
            {isFiltered
              ? `${filteredProducts.length} dari ${allProducts.length} produk`
              : `${allProducts.length} produk`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={categoryFilter}
            onValueChange={setCategoryFilter}
          >
            <SelectTrigger
              data-testid="select-category-filter"
              className="h-8 w-44 text-xs"
            >
              <SelectValue placeholder="Semua kategori" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Semua kategori</SelectItem>
              {categoryOptions.hasUncategorized && (
                <SelectItem value="__none__">
                  <span className="italic text-muted-foreground">
                    Tanpa kategori
                  </span>
                </SelectItem>
              )}
              {categoryOptions.list.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => setShowInternalPrices((v) => !v)}
            data-testid="button-toggle-internal-prices"
            title={
              showInternalPrices
                ? "Sembunyikan harga Silver/Gold/Platinum/Reseller/Distributor"
                : "Tampilkan harga Silver/Gold/Platinum/Reseller/Distributor"
            }
          >
            {showInternalPrices ? (
              <EyeOff className="w-3.5 h-3.5 mr-1.5" />
            ) : (
              <Eye className="w-3.5 h-3.5 mr-1.5" />
            )}
            {showInternalPrices ? "Sembunyikan harga internal" : "Tampilkan harga internal"}
          </Button>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari kode, nama, kategori…"
              className="h-8 w-56 pl-7 pr-7 text-xs"
              data-testid="input-search-products"
            />
            {search && (
              <button
                type="button"
                aria-label="Bersihkan pencarian"
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent text-muted-foreground"
                data-testid="button-clear-search"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,.xlsx"
            className="hidden"
            onChange={handleImport}
            data-testid="input-import-products"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={handleImportClick}
            disabled={importing}
            data-testid="button-import-products"
          >
            {importing ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Upload className="w-3.5 h-3.5 mr-1.5" />
            )}
            Import
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="button-export-products">
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport("csv")}>CSV (.csv)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport("xlsx")}>
                Excel (.xlsx)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncKb.mutate()}
            disabled={syncKb.isPending || allProducts.length === 0}
            data-testid="button-sync-products-knowledge"
            title="Snapshot katalog ke Knowledge Base agar bisa dipakai AI"
          >
            {syncKb.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <BookOpen className="w-3.5 h-3.5 mr-1.5" />
            )}
            Sync ke AI
          </Button>
          <Button data-testid="button-add-product" size="sm" onClick={openCreate}>
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Tambah Produk
          </Button>
        </div>
      </div>

      <ProductSyncCard />

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="p-6 space-y-2">
            {Array(8)
              .fill(0)
              .map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
          </div>
        ) : !products || products.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Package className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">Belum ada produk</p>
            <p className="text-xs mt-1">
              Tambahkan manual atau gunakan Import (CSV/XLSX)
            </p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
            <Search className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">Tidak ada produk yang cocok</p>
            <p className="text-xs mt-1">Coba kata kunci lain.</p>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="bg-secondary sticky top-0 z-10 shadow-[0_1px_0_0_hsl(var(--border))]">
                <tr className="text-left">
                  <SortableTh sortKey="id" label="ID" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <th className="px-3 py-2 font-medium">Foto</th>
                  <SortableTh sortKey="code" label="Kode Produk" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} />
                  <SortableTh sortKey="name" label="Nama Barang" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} className="w-[300px]" />
                  <SortableTh sortKey="category" label="Kategori" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} className="w-[180px]" />
                  <SortableTh sortKey="price" label="Harga Pricelist" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} align="right" />
                  {showInternalPrices && (
                    <>
                      <SortableTh sortKey="priceSilver" label="Harga Silver" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} align="right" />
                      <SortableTh sortKey="priceGold" label="Harga Gold" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} align="right" />
                      <SortableTh sortKey="pricePlatinum" label="Harga Platinum" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} align="right" />
                      <SortableTh sortKey="priceReseller" label="Harga Reseller" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} align="right" />
                      <SortableTh sortKey="priceDistributor" label="Harga Distributor" sortBy={sortBy} sortDir={sortDir} onToggle={toggleSort} align="right" />
                    </>
                  )}
                  <th className="px-3 py-2 font-medium">Link Website</th>
                  <th className="px-3 py-2 font-medium">Link Video</th>
                  <th className="px-3 py-2 font-medium w-20"></th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => (
                  <tr
                    key={p.id}
                    data-testid={`product-row-${p.id}`}
                    className="border-t border-border hover:bg-accent/30"
                  >
                    <td className="px-3 py-2 text-muted-foreground">{p.id}</td>
                    <td className="px-3 py-2">
                      <div className="w-10 h-10 rounded bg-secondary overflow-hidden flex items-center justify-center">
                        {p.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={resolveImageSrc(p.imageUrl) ?? p.imageUrl}
                            alt={p.name}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          <Package className="w-4 h-4 opacity-30" />
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-mono">{p.code}</td>
                    <td
                      className="px-3 py-2 font-medium w-[300px] max-w-[300px] truncate"
                      title={p.name}
                    >
                      {p.name}
                    </td>
                    <td
                      className="px-3 py-2 w-[180px] max-w-[180px] truncate text-muted-foreground"
                      title={p.category ?? undefined}
                    >
                      {p.category ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-primary">
                      {formatIDR(p.price)}
                    </td>
                    {showInternalPrices && (
                      <>
                        <td className="px-3 py-2 text-right">{formatIDR(p.priceSilver)}</td>
                        <td className="px-3 py-2 text-right">{formatIDR(p.priceGold)}</td>
                        <td className="px-3 py-2 text-right">{formatIDR(p.pricePlatinum)}</td>
                        <td className="px-3 py-2 text-right">{formatIDR(p.priceReseller)}</td>
                        <td className="px-3 py-2 text-right">{formatIDR(p.priceDistributor)}</td>
                      </>
                    )}
                    <td className="px-3 py-2">
                      {p.productUrl ? (
                        <a
                          href={p.productUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Buka
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.videoUrls && p.videoUrls.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                          {p.videoUrls.slice(0, 3).map((url, i) => (
                            <a
                              key={i}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary hover:underline"
                            >
                              <Video className="w-3 h-3" />
                              Video {i + 1}
                            </a>
                          ))}
                          {p.videoUrls.length > 3 ? (
                            <span className="text-[10px] text-muted-foreground">
                              +{p.videoUrls.length - 3} lagi
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1">
                        <Button
                          data-testid={`button-edit-product-${p.id}`}
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEdit(p)}
                        >
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button
                          data-testid={`button-delete-product-${p.id}`}
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => setDeleteId(p.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Produk" : "Tambah Produk"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex flex-col gap-1.5 flex-shrink-0 w-28">
                <div
                  onClick={() => imgInputRef.current?.click()}
                  className="w-28 h-28 rounded-md border border-dashed border-border bg-secondary flex items-center justify-center overflow-hidden cursor-pointer hover:bg-accent/50"
                  data-testid="thumbnail-product-image"
                >
                  {uploadingImg ? (
                    <Loader2 className="w-5 h-5 animate-spin opacity-60" />
                  ) : imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={resolveImageSrc(imageUrl) ?? imageUrl}
                      alt="preview"
                      className="w-full h-full object-cover"
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="flex flex-col items-center text-muted-foreground gap-1">
                      <ImagePlus className="w-5 h-5" />
                      <span className="text-[10px]">Foto</span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => imgInputRef.current?.click()}
                  className="text-[10px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  data-testid="button-upload-image"
                >
                  Upload file
                </button>
                {imageUrl && (
                  <button
                    type="button"
                    onClick={() => setImageUrl(null)}
                    className="text-[10px] text-destructive hover:underline underline-offset-2"
                    data-testid="button-clear-image"
                  >
                    Hapus foto
                  </button>
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
              <div className="flex-1 grid grid-cols-2 gap-2">
                <Field
                  label="Kode Product *"
                  value={form.code}
                  onChange={(v) => setForm({ ...form, code: v })}
                  placeholder="SKU-001"
                  testid="input-product-code"
                />
                <Field
                  label="Category"
                  value={form.category}
                  onChange={(v) => setForm({ ...form, category: v })}
                  placeholder="Skincare"
                  testid="input-product-category"
                />
                <div className="col-span-2">
                  <Field
                    label="Nama Barang *"
                    value={form.name}
                    onChange={(v) => setForm({ ...form, name: v })}
                    placeholder="Serum Vitamin C Premium"
                    testid="input-product-name"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">
                Harga (Rupiah, angka saja)
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  label="Harga Pricelist * (publik)"
                  value={form.price}
                  onChange={(v) => setForm({ ...form, price: v })}
                  placeholder="150000"
                  testid="input-product-price"
                />
                <Field
                  label="Harga Silver"
                  value={form.priceSilver}
                  onChange={(v) => setForm({ ...form, priceSilver: v })}
                  placeholder="kosong = N/A"
                  testid="input-product-silver"
                />
                <Field
                  label="Harga Gold"
                  value={form.priceGold}
                  onChange={(v) => setForm({ ...form, priceGold: v })}
                  placeholder="kosong = N/A"
                  testid="input-product-gold"
                />
                <Field
                  label="Harga Platinum"
                  value={form.pricePlatinum}
                  onChange={(v) => setForm({ ...form, pricePlatinum: v })}
                  placeholder="kosong = N/A"
                  testid="input-product-platinum"
                />
                <Field
                  label="Harga Reseller"
                  value={form.priceReseller}
                  onChange={(v) => setForm({ ...form, priceReseller: v })}
                  placeholder="kosong = N/A"
                  testid="input-product-reseller"
                />
                <Field
                  label="Harga Distributor"
                  value={form.priceDistributor}
                  onChange={(v) => setForm({ ...form, priceDistributor: v })}
                  placeholder="kosong = N/A"
                  testid="input-product-distributor"
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Hanya <b>Harga Pricelist</b> yang dikirim ke customer. Silver/Gold/Platinum/Reseller/
                Distributor adalah info internal di app.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Link Foto{" "}
                  <span className="text-[10px] font-normal">
                    (URL gambar, link Google Drive, atau /api/media/… — otomatis jadi thumbnail)
                  </span>
                </label>
                <Input
                  value={imageUrl ?? ""}
                  onChange={(e) => setImageUrl(e.target.value || null)}
                  placeholder="https://drive.google.com/open?id=… atau https://contoh.com/foto.jpg"
                  className="h-8 text-xs mt-1"
                  data-testid="input-product-image-url"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">
                  Link Flyer{" "}
                  <span className="text-[10px] font-normal">
                    (tempel iframe Google Drive atau URL gambar — dikirim sebagai foto ke-2)
                  </span>
                </label>
                <textarea
                  value={form.flyerUrl}
                  onChange={(e) => setForm({ ...form, flyerUrl: e.target.value })}
                  placeholder={`<iframe src="https://drive.google.com/file/d/.../preview" width="640" height="480"></iframe>`}
                  className="mt-1 w-full text-xs rounded-md border border-input bg-background px-3 py-2 font-mono leading-tight resize-y min-h-[60px]"
                  rows={3}
                  data-testid="input-product-flyer-url"
                />
              </div>
              <Field
                label="Link Website"
                value={form.productUrl}
                onChange={(v) => setForm({ ...form, productUrl: v })}
                placeholder="https://..."
                testid="input-product-link"
              />
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Link Video{" "}
                    <span className="text-[10px] font-normal">
                      ({videoUrls.length}/10 — bisa lebih dari satu)
                    </span>
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={videoUrls.length >= 10}
                    onClick={() => setVideoUrls([...videoUrls, ""])}
                    data-testid="button-add-video"
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Tambah video
                  </Button>
                </div>
                {videoUrls.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground italic">
                    Belum ada link video. Klik "Tambah video" untuk menambahkan.
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {videoUrls.map((url, idx) => (
                      <div key={idx} className="flex items-center gap-1.5">
                        <span className="text-[10px] text-muted-foreground w-4 shrink-0">
                          {idx + 1}.
                        </span>
                        <Input
                          value={url}
                          onChange={(e) => {
                            const next = [...videoUrls];
                            next[idx] = e.target.value;
                            setVideoUrls(next);
                          }}
                          placeholder="https://youtu.be/..."
                          className="h-8 text-xs"
                          data-testid={`input-product-video-${idx}`}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0"
                          onClick={() =>
                            setVideoUrls(videoUrls.filter((_, i) => i !== idx))
                          }
                          data-testid={`button-remove-video-${idx}`}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
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
            <AlertDialogDescription>Produk ini akan dihapus permanen.</AlertDialogDescription>
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

function Field({
  label,
  value,
  onChange,
  placeholder,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  testid?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        data-testid={testid}
        className="h-9 text-sm"
      />
    </div>
  );
}
