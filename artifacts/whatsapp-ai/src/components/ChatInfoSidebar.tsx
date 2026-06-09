import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCustomerLabels,
  useSetChatLabels,
  useListShortcuts,
  useSendShortcutToChat,
  useListProducts,
  useSendProductToChat,
  useListSalesOrders,
  useCreateSalesOrder,
  useUpdateSalesOrder,
  useDeleteSalesOrder,
  useSendSalesOrder,
  useSyncSalesOrderToSheet,
  useGetGroupInfo,
  useGetChatAttachments,
  useGetStarredMessages,
  useGetCommonGroups,
  useAddGroupParticipants,
  useGetMe,
  useGetChatSalesInsight,
  useAnalyzeChatSalesInsight,
  useGetSalesAssistantSettings,
  useUpdateSalesAssistantSettings,
  useCreateOpportunity,
  useListPipelines,
  useListOpportunityFollowUps,
  useSendOpportunityFollowUp,
  useUpdateOpportunityFollowUp,
  getListShortcutsQueryKey,
  getListProductsQueryKey,
  getListSalesOrdersQueryKey,
  getGetChatQueryKey,
  getListChatsQueryKey,
  getGetGroupInfoQueryKey,
  getGetChatAttachmentsQueryKey,
  getGetStarredMessagesQueryKey,
  getGetCommonGroupsQueryKey,
  getGetChatSalesInsightQueryKey,
  getGetSalesAssistantSettingsQueryKey,
  getListOpportunityFollowUpsQueryKey,
  getListPipelinesQueryKey,
} from "@workspace/api-client-react";
import type {
  TextShortcut,
  Product,
  SalesOrder,
  SalesOrderItemInput,
  SalesInsight,
  Pipeline,
} from "@workspace/api-client-react";
import { usePermissions } from "@/hooks/use-permissions";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import {
  PanelRightClose,
  Maximize2,
  Minimize2,
  Tag as TagIcon,
  Check,
  Plus,
  Zap,
  Package,
  Receipt,
  Search,
  Send,
  ImageIcon,
  FileText,
  Loader2,
  Trash2,
  Pencil,
  X,
  FileSpreadsheet,
  Users,
  Star,
  LinkIcon,
  Copy,
  ShieldCheck,
  UserPlus,
  QrCode,
  ExternalLink,
  ArrowUp,
  ArrowDown,
  Sparkles,
  RefreshCw,
  TrendingUp,
  Clock,
  CheckCheck,
  ChevronRight,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { ChatAvatar } from "@/components/ChatAvatar";
import { ContactPicker } from "@/components/ContactPicker";
import { ProductImageLightbox } from "@/components/ProductImageLightbox";
import { resolveImageSrc } from "@/lib/utils";

export type ChatLabel = { id: number; name: string; color: string };

type AgentLike = {
  id: number;
  name?: string | null;
  email: string;
  teamRole?: string | null;
  status: string;
};

type ChatLike = {
  id: number;
  channelId: number;
  nickname?: string | null;
  contactName: string;
  phoneNumber: string;
  company?: string | null;
  customerCode?: string | null;
  labels: ChatLabel[];
  tag: string;
  status: string;
  isHumanTakeover: boolean;
  assignedUserId?: number | null;
};

interface Props {
  chatId: number;
  chat: ChatLike;
  canAssign: boolean;
  agents: AgentLike[];
  onClose: () => void;
  onUpdate: (data: {
    nickname?: string | null;
    company?: string | null;
    customerCode?: string | null;
    tag?: string;
    status?: string;
  }) => void;
  onTakeover: (checked: boolean) => void;
  onAssign: (userId: number | null) => void;
}

// Contrast helper: pick black/white text for a given hex background so label
// chips stay readable regardless of the chosen color.
function readableText(hex: string): string {
  const m = hex.replace("#", "");
  const full =
    m.length === 3
      ? m.split("").map((c) => c + c).join("")
      : m.slice(0, 6);
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#ffffff";
}

// Shortcut tab: searchable list of the owner's text shortcuts. Each row can be
// sent to the active chat. Shortcuts carrying a `link` are delivered as a photo
// (with the replacement text as caption); the rest are sent as plain text.
function ShortcutTab({
  chatId,
  channelId,
}: {
  chatId: number;
  channelId: number;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { data, isLoading } = useListShortcuts({
    query: { queryKey: getListShortcutsQueryKey() },
  });
  const shortcuts = (data ?? []) as TextShortcut[];

  const send = useSendShortcutToChat();

  // Mirror the server's channel-scope rule: a shortcut with no channel
  // assignments is global; one with assignments is only available on the listed
  // channels. Hide shortcuts not sendable on the active chat's channel.
  const inScope = shortcuts.filter(
    (s) => s.channelIds.length === 0 || s.channelIds.includes(channelId)
  );

  const q = search.trim().toLowerCase();
  const filtered = q
    ? inScope.filter(
        (s) =>
          s.shortcut.toLowerCase().includes(q) ||
          s.replacement.toLowerCase().includes(q)
      )
    : inScope;

  async function handleSend() {
    if (selectedId == null) return;
    try {
      await send.mutateAsync({ id: chatId, data: { shortcutId: selectedId } });
      setSelectedId(null);
    } catch (err) {
      toast({
        title: "Gagal mengirim shortcut",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col p-3 gap-3 min-h-0">
      <div className="relative flex-shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--wa-meta))]" />
        <Input
          data-testid="input-shortcut-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cari shortcut…"
          className="h-9 pl-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--wa-meta))] py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[hsl(var(--wa-meta))] text-center py-6">
          {shortcuts.length === 0
            ? "Belum ada shortcut. Tambahkan di Pengaturan."
            : "Tidak ada shortcut yang cocok."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0">
          {filtered.map((s) => {
            const isSelected = selectedId === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  data-testid={`shortcut-item-${s.id}`}
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelectedId((cur) => (cur === s.id ? null : s.id))
                  }
                  className={cn(
                    "w-full text-left rounded-lg border p-2.5 space-y-1.5 transition-colors",
                    isSelected
                      ? "border-[hsl(var(--wa-accent))] bg-[hsl(var(--wa-accent))]/10"
                      : "border-[hsl(var(--wa-divider))] hover:bg-white/5"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <code className="font-mono text-[11px] bg-white/5 px-1.5 py-0.5 rounded text-foreground">
                      {s.shortcut}
                    </code>
                    {s.link ? (
                      <span
                        data-testid={`shortcut-photo-badge-${s.id}`}
                        className="inline-flex items-center gap-1 text-[10px] text-[hsl(var(--wa-accent))]"
                        title="Dikirim sebagai foto"
                      >
                        <ImageIcon className="w-3 h-3" /> Foto
                      </span>
                    ) : null}
                    {isSelected ? (
                      <Check className="w-3.5 h-3.5 text-[hsl(var(--wa-accent))] ml-auto" />
                    ) : null}
                  </div>
                  <p className="text-xs text-[hsl(var(--wa-meta))] line-clamp-2 whitespace-pre-wrap break-words">
                    {s.replacement}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        data-testid="button-send-shortcut"
        onClick={handleSend}
        disabled={selectedId == null || send.isPending}
        className="h-9 w-full gap-1.5 text-xs flex-shrink-0"
      >
        {send.isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Send className="w-3.5 h-3.5" />
        )}
        Kirim
      </Button>
    </div>
  );
}

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

// Product categories come from the product's `category` column (synced from the
// Google Sheet "kategori" column), NOT from the product code. "__all__" shows
// everything; "__none__" is produk tanpa kategori.
const ALL_CATEGORIES = "__all__";
const UNCATEGORIZED = "__none__";

type CategoryOptions = { list: string[]; hasUncategorized: boolean };

// Sort keys for the Products-tab list. "stock" sorts by the effective quantity
// (stockOnHand falls back to stock — see the in-stock filter note above).
type ProductSortKey = "harga" | "kode" | "nama" | "stock";

const PRODUCT_SORT_OPTIONS: { value: ProductSortKey; label: string }[] = [
  { value: "harga", label: "Harga" },
  { value: "kode", label: "Kode" },
  { value: "nama", label: "Nama" },
  { value: "stock", label: "Stock" },
];

function productSortValue(
  p: Product,
  key: ProductSortKey
): string | number | null {
  switch (key) {
    case "harga":
      return p.price;
    case "kode":
      return p.code;
    case "nama":
      return p.name;
    case "stock":
      return p.stockOnHand ?? p.stock ?? null;
  }
}

// Returns a sorted COPY (never mutates the input). Nulls always sort last,
// regardless of direction, so empty stock/price never floats to the top.
function sortProducts(
  products: Product[],
  key: ProductSortKey,
  dir: "asc" | "desc"
): Product[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...products].sort((a, b) => {
    const av = productSortValue(a, key);
    const bv = productSortValue(b, key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return (av - bv) * sign;
    }
    return (
      String(av).localeCompare(String(bv), "id-ID", { sensitivity: "base" }) *
      sign
    );
  });
}

// Internal-only product detail lines for the picker. The send-product and
// quotation flows never include the stock figures or tier prices, so they stay
// visible to agents but never reach the customer. Layout (per request):
//   line 1: Nama Barang (rendered by the caller)
//   line 2: Kode Barang · Qty · Qty On Hand
//   line 3: Harga · Price Silver
function ProductMetaLines({ product }: { product: Product }) {
  const hasQty = product.stock != null;
  const hasSoh = product.stockOnHand != null;
  const hasSilver = product.priceSilver != null;
  return (
    <>
      <p className="text-[11px] text-[hsl(var(--wa-meta))] truncate">
        <span className="font-mono">{product.code}</span>
        {hasQty ? ` | ${product.stock}` : null}
        {hasSoh ? ` | ${product.stockOnHand}` : null}
      </p>
      <p className="text-[11px] text-[hsl(var(--wa-meta))] truncate">
        {formatRupiah(product.price)}
        {hasSilver ? ` | ${formatRupiah(product.priceSilver!)}` : null}
      </p>
    </>
  );
}

// Products are user-scoped on the server: both POST /chats/:id/product and
// POST /chats/:id/quotation accept any product owned by the chat's owner,
// regardless of the product's channelIds. So we deliberately do NOT channel-filter
// here — doing so would hide products the backend would happily send. We apply
// the search filter, the category filter (from the `category` column), and an
// optional in-stock filter (qty != 0). Shared by both the Products and Order tabs.
function useFilteredProducts(
  search: string,
  category: string,
  inStockOnly: boolean
): {
  products: Product[];
  filtered: Product[];
  categories: CategoryOptions;
  isLoading: boolean;
} {
  const { data, isLoading } = useListProducts({
    query: { queryKey: getListProductsQueryKey() },
  });
  const products = (data ?? []) as Product[];

  // Distinct categories from the catalog, sorted alfabetis (id-ID,
  // case-insensitive). hasUncategorized flags products tanpa kategori.
  const seen = new Set<string>();
  let hasUncategorized = false;
  for (const p of products) {
    const c = (p.category ?? "").trim();
    if (c) seen.add(c);
    else hasUncategorized = true;
  }
  const categories: CategoryOptions = {
    list: Array.from(seen).sort((a, b) =>
      a.localeCompare(b, "id-ID", { sensitivity: "base" })
    ),
    hasUncategorized,
  };

  const q = search.trim().toLowerCase();
  const filtered = products.filter((p) => {
    // "Jumlah" can live in either column — many catalogs leave `stock` empty and
    // only fill `stockOnHand` (qty on hand). Treat a product as in-stock when
    // either column is > 0.
    if (inStockOnly && !((p.stock ?? 0) > 0 || (p.stockOnHand ?? 0) > 0))
      return false;
    if (category !== ALL_CATEGORIES) {
      const c = (p.category ?? "").trim();
      if (category === UNCATEGORIZED) {
        if (c) return false;
      } else if (c !== category) {
        return false;
      }
    }
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      p.code.toLowerCase().includes(q) ||
      (p.category ?? "").toLowerCase().includes(q)
    );
  });
  return { products, filtered, categories, isLoading };
}

// Category combo box shared by both tabs. Options come from the catalog's
// `category` column; defaults to "Semua kategori".
function CategoryFilter({
  value,
  onChange,
  categories,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  categories: CategoryOptions;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        data-testid={testId}
        className="h-9 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
      >
        <SelectValue placeholder="Semua kategori" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_CATEGORIES} className="text-xs">
          Semua kategori
        </SelectItem>
        {categories.hasUncategorized && (
          <SelectItem value={UNCATEGORIZED} className="text-xs">
            <span className="italic text-[hsl(var(--wa-meta))]">
              Tanpa kategori
            </span>
          </SelectItem>
        )}
        {categories.list.map((c) => (
          <SelectItem key={c} value={c} className="text-xs">
            {c}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// "Tampilkan produk dengan stok ≠ 0" checkbox shared by both tabs.
function InStockToggle({
  checked,
  onChange,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-[hsl(var(--wa-meta))] cursor-pointer select-none">
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        data-testid={testId}
        className="h-4 w-4"
      />
      Tampilkan produk dengan jumlah &gt; 0
    </label>
  );
}

// Products tab: pick one product, then send it (image + caption) to the chat
// via the single bottom Kirim button — same selection pattern as ShortcutTab.
function ProductsTab({ chatId }: { chatId: number }) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [inStockOnly, setInStockOnly] = useState(false);
  const [sortBy, setSortBy] = useState<ProductSortKey>("harga");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const { products, filtered, categories, isLoading } = useFilteredProducts(
    search,
    category,
    inStockOnly
  );
  const sorted = sortProducts(filtered, sortBy, sortDir);

  // Reset the selection whenever the active chat changes so a product picked for
  // one conversation can't be sent to another after switching chats.
  useEffect(() => {
    setSelectedId(null);
  }, [chatId]);

  const send = useSendProductToChat();

  async function handleSend() {
    if (selectedId == null) return;
    try {
      await send.mutateAsync({ id: chatId, data: { productId: selectedId } });
      setSelectedId(null);
    } catch (err) {
      toast({
        title: "Gagal mengirim produk",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col p-3 gap-3 min-h-0">
      <div className="flex-shrink-0 flex flex-col gap-2">
        <CategoryFilter
          value={category}
          onChange={setCategory}
          categories={categories}
          testId="select-product-category"
        />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--wa-meta))]" />
          <Input
            data-testid="input-product-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari produk…"
            className="h-9 pl-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
          />
        </div>
        <InStockToggle
          checked={inStockOnly}
          onChange={setInStockOnly}
          testId="checkbox-product-instock"
        />
        <div className="flex items-center gap-2">
          <Select
            value={sortBy}
            onValueChange={(v) => setSortBy(v as ProductSortKey)}
          >
            <SelectTrigger
              data-testid="select-product-sort"
              className="h-9 flex-1 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
            >
              <span className="text-[hsl(var(--wa-meta))] mr-1">Urutkan:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRODUCT_SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            data-testid="button-product-sort-dir"
            onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            title={sortDir === "asc" ? "Naik (A→Z, kecil→besar)" : "Turun (Z→A, besar→kecil)"}
            className="h-9 w-9 flex-shrink-0 border-[hsl(var(--wa-divider))]"
          >
            {sortDir === "asc" ? (
              <ArrowUp className="w-3.5 h-3.5" />
            ) : (
              <ArrowDown className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-[hsl(var(--wa-meta))] py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat…
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[hsl(var(--wa-meta))] text-center py-6">
          {products.length === 0
            ? "Belum ada produk. Tambahkan di Pengaturan."
            : "Tidak ada produk yang cocok."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2 overflow-y-auto flex-1 min-h-0">
          {sorted.map((p) => {
            const isSelected = selectedId === p.id;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  data-testid={`product-item-${p.id}`}
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelectedId((cur) => (cur === p.id ? null : p.id))
                  }
                  className={cn(
                    "w-full text-left rounded-lg border p-2.5 flex items-center gap-2.5 transition-colors",
                    isSelected
                      ? "border-[hsl(var(--wa-accent))] bg-[hsl(var(--wa-accent))]/10"
                      : "border-[hsl(var(--wa-divider))] hover:bg-white/5"
                  )}
                >
                  <ProductImageLightbox
                    src={p.imageUrl}
                    alt={p.name}
                    triggerClassName="flex-shrink-0"
                  >
                    {p.imageUrl ? (
                      <img
                        src={resolveImageSrc(p.imageUrl) ?? p.imageUrl}
                        alt={p.name}
                        className="w-10 h-10 rounded object-cover flex-shrink-0 bg-white/5"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0 bg-white/5 text-[hsl(var(--wa-meta))]">
                        <Package className="w-4 h-4" />
                      </div>
                    )}
                  </ProductImageLightbox>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground truncate">
                      {p.name}
                    </p>
                    <ProductMetaLines product={p} />
                  </div>
                  {isSelected ? (
                    <Check className="w-3.5 h-3.5 text-[hsl(var(--wa-accent))] flex-shrink-0" />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <Button
        data-testid="button-send-product"
        onClick={handleSend}
        disabled={selectedId == null || send.isPending}
        className="h-9 w-full gap-1.5 text-xs flex-shrink-0"
      >
        {send.isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Send className="w-3.5 h-3.5" />
        )}
        Kirim
      </Button>
    </div>
  );
}

// A single editable line item in the POS draft. `key` is a client-only id so
// React can track rows before they're persisted; `productId` is null for
// custom free-text lines.
type DiscountType = "percent" | "amount";

type DraftLine = {
  key: string;
  productId: number | null;
  code: string | null;
  name: string;
  qty: number;
  price: number;
  discountType: DiscountType;
  discountValue: number;
};

const PPN_RATE = 11;

// Resolve a discount (percent or nominal Rupiah) to a clamped Rupiah amount.
// Mirrors the server's discountFor (see routes/sales-orders.ts).
function discountAmountFor(
  type: DiscountType,
  value: number,
  base: number
): number {
  if (!value || value <= 0 || base <= 0) return 0;
  const amount = type === "percent" ? Math.round((base * value) / 100) : value;
  return Math.min(Math.max(0, amount), base);
}

// Net line total after the per-line discount (qty * price - discount).
function lineNetTotal(l: DraftLine): number {
  const gross = l.qty * l.price;
  return Math.max(0, gross - discountAmountFor(l.discountType, l.discountValue, gross));
}

let draftLineSeq = 0;
function newLineKey(): string {
  draftLineSeq += 1;
  return `line-${Date.now()}-${draftLineSeq}`;
}

// Mirror of the server-authoritative PPN math (see salesOrdersTable comment):
// off → no tax; included → tax is carved out of the subtotal; excluded → tax
// is added on top. Kept in sync so the live preview matches what gets saved.
function computeTotals(
  lines: DraftLine[],
  ppnEnabled: boolean,
  ppnIncluded: boolean,
  globalDiscountType: DiscountType,
  globalDiscountValue: number
): {
  subtotal: number;
  discountAmount: number;
  ppnAmount: number;
  total: number;
} {
  const subtotal = lines.reduce((s, l) => s + lineNetTotal(l), 0);
  const discountAmount = discountAmountFor(
    globalDiscountType,
    globalDiscountValue,
    subtotal
  );
  const base = Math.max(0, subtotal - discountAmount);
  if (!ppnEnabled) return { subtotal, discountAmount, ppnAmount: 0, total: base };
  if (ppnIncluded) {
    const net = Math.round(base / (1 + PPN_RATE / 100));
    return { subtotal, discountAmount, ppnAmount: base - net, total: base };
  }
  const ppnAmount = Math.round((base * PPN_RATE) / 100);
  return { subtotal, discountAmount, ppnAmount, total: base + ppnAmount };
}

// Popover that lets the agent pick a catalog product to add as a line. Reuses
// the same category + search + in-stock filtering as the Products tab.
function ProductPicker({
  onPick,
}: {
  onPick: (p: Product) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [inStockOnly, setInStockOnly] = useState(false);
  const { products, filtered, categories, isLoading } = useFilteredProducts(
    search,
    category,
    inStockOnly
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          data-testid="button-add-catalog-item"
          className="h-9 flex-1 gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
        >
          <Package className="w-3.5 h-3.5" /> Dari katalog
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="flex flex-col gap-2">
          <CategoryFilter
            value={category}
            onChange={setCategory}
            categories={categories}
            testId="select-order-picker-category"
          />
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(var(--wa-meta))]" />
            <Input
              data-testid="input-order-picker-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari produk…"
              className="h-9 pl-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
            />
          </div>
          <InStockToggle
            checked={inStockOnly}
            onChange={setInStockOnly}
            testId="checkbox-order-picker-instock"
          />
          {isLoading ? (
            <div className="flex items-center gap-2 text-xs text-[hsl(var(--wa-meta))] py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat…
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-[hsl(var(--wa-meta))] text-center py-4">
              {products.length === 0
                ? "Belum ada produk."
                : "Tidak ada yang cocok."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 max-h-56 overflow-y-auto">
              {filtered.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    data-testid={`order-picker-item-${p.id}`}
                    onClick={() => {
                      onPick(p);
                      setOpen(false);
                    }}
                    className="w-full text-left rounded-md border border-[hsl(var(--wa-divider))] p-2 hover:bg-white/5 transition-colors"
                  >
                    <p className="text-xs font-medium text-foreground truncate">
                      {p.name}
                    </p>
                    <p className="text-[11px] text-[hsl(var(--wa-meta))] truncate">
                      {p.code} · {formatRupiah(p.price)}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Read-only summary card for an already-saved order, with actions to edit,
// delete, send to the customer, and append to the configured Google Sheet.
function SavedOrderCard({
  order,
  onEdit,
  chatId,
}: {
  order: SalesOrder;
  onEdit: (order: SalesOrder) => void;
  chatId: number;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const del = useDeleteSalesOrder();
  const send = useSendSalesOrder();
  const sync = useSyncSalesOrderToSheet();

  function invalidate() {
    qc.invalidateQueries({
      queryKey: getListSalesOrdersQueryKey({ chatId }),
    });
  }

  async function handleDelete() {
    try {
      await del.mutateAsync({ id: order.id });
      invalidate();
    } catch (err) {
      toast({
        title: "Gagal menghapus",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  async function handleSend() {
    try {
      await send.mutateAsync({ id: order.id });
      invalidate();
      toast({ title: "Ringkasan terkirim ke customer" });
    } catch (err) {
      toast({
        title: "Gagal mengirim",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  async function handleSync() {
    try {
      await sync.mutateAsync({ id: order.id });
      invalidate();
      toast({ title: "Tersimpan ke Google Sheet" });
    } catch (err) {
      toast({
        title: "Gagal simpan ke Sheet",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  return (
    <div
      data-testid={`saved-order-${order.id}`}
      className="rounded-lg border border-[hsl(var(--wa-divider))] p-2.5 flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">
            #{order.id} · {formatRupiah(order.total)}
          </p>
          <p className="text-[11px] text-[hsl(var(--wa-meta))]">
            {order.items.length} item ·{" "}
            {order.status === "sent" ? "Terkirim" : "Draft"}
            {order.syncedToSheetAt ? " · di Sheet" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid={`button-edit-order-${order.id}`}
            onClick={() => onEdit(order)}
            className="h-7 w-7"
          >
            <Pencil className="w-3.5 h-3.5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            data-testid={`button-delete-order-${order.id}`}
            onClick={handleDelete}
            disabled={del.isPending}
            className="h-7 w-7 text-red-400 hover:text-red-400"
          >
            {del.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          data-testid={`button-send-order-${order.id}`}
          onClick={handleSend}
          disabled={send.isPending}
          className="h-8 w-full justify-center gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
        >
          {send.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Send className="w-3.5 h-3.5" />
          )}
          Kirim ke customer
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid={`button-sync-order-${order.id}`}
          onClick={handleSync}
          disabled={sync.isPending}
          className="h-8 w-full justify-center gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
        >
          {sync.isPending ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <FileSpreadsheet className="w-3.5 h-3.5" />
          )}
          Simpan ke Sheet
        </Button>
      </div>
    </div>
  );
}

// Order tab (POS-style): build a sales order from catalog + custom line items
// with per-order PPN, save it as a draft, then send/sync it from the list below.
function OrderTab({ chatId }: { chatId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [editingId, setEditingId] = useState<number | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [ppnEnabled, setPpnEnabled] = useState(false);
  const [ppnIncluded, setPpnIncluded] = useState(true);
  const [discountType, setDiscountType] = useState<DiscountType>("amount");
  const [discountValue, setDiscountValue] = useState(0);
  const [note, setNote] = useState("");

  // Drop any in-progress draft when the active chat changes so line items can't
  // bleed from one conversation's order into another.
  useEffect(() => {
    setEditingId(null);
    setLines([]);
    setPpnEnabled(false);
    setPpnIncluded(true);
    setDiscountType("amount");
    setDiscountValue(0);
    setNote("");
  }, [chatId]);

  const { data: ordersData, isLoading: ordersLoading } = useListSalesOrders(
    { chatId },
    { query: { queryKey: getListSalesOrdersQueryKey({ chatId }) } }
  );
  const orders = (ordersData ?? []) as SalesOrder[];

  const create = useCreateSalesOrder();
  const update = useUpdateSalesOrder();
  const saving = create.isPending || update.isPending;

  const { subtotal, discountAmount, ppnAmount, total } = computeTotals(
    lines,
    ppnEnabled,
    ppnIncluded,
    discountType,
    discountValue
  );

  function resetForm() {
    setEditingId(null);
    setLines([]);
    setPpnEnabled(false);
    setPpnIncluded(true);
    setDiscountType("amount");
    setDiscountValue(0);
    setNote("");
  }

  function addCatalogLine(p: Product) {
    setLines((cur) => [
      ...cur,
      {
        key: newLineKey(),
        productId: p.id,
        code: p.code,
        name: p.name,
        qty: 1,
        price: p.price,
        discountType: "amount",
        discountValue: 0,
      },
    ]);
  }

  function addCustomLine() {
    setLines((cur) => [
      ...cur,
      {
        key: newLineKey(),
        productId: null,
        code: null,
        name: "",
        qty: 1,
        price: 0,
        discountType: "amount",
        discountValue: 0,
      },
    ]);
  }

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((cur) =>
      cur.map((l) => (l.key === key ? { ...l, ...patch } : l))
    );
  }

  function removeLine(key: string) {
    setLines((cur) => cur.filter((l) => l.key !== key));
  }

  function startEdit(order: SalesOrder) {
    setEditingId(order.id);
    setLines(
      order.items.map((it) => ({
        key: newLineKey(),
        productId: it.productId ?? null,
        code: it.code ?? null,
        name: it.name,
        qty: it.qty,
        price: it.price,
        discountType: it.discountType,
        discountValue: it.discountValue,
      }))
    );
    setPpnEnabled(order.ppnEnabled);
    setPpnIncluded(order.ppnIncluded);
    setDiscountType(order.discountType);
    setDiscountValue(order.discountValue);
    setNote(order.note ?? "");
  }

  async function handleSave() {
    const cleaned = lines
      .map((l) => ({ ...l, name: l.name.trim() }))
      .filter((l) => l.name.length > 0 && l.qty > 0);
    if (cleaned.length === 0) {
      toast({
        title: "Tambahkan minimal satu item",
        description: "Setiap item butuh nama dan jumlah.",
        variant: "destructive",
      });
      return;
    }
    const items: SalesOrderItemInput[] = cleaned.map((l) => ({
      productId: l.productId,
      code: l.code,
      name: l.name,
      qty: l.qty,
      price: l.price,
      discountType: l.discountType,
      discountValue: l.discountValue,
    }));
    const data = {
      chatId,
      ppnEnabled,
      ppnIncluded,
      ppnRate: PPN_RATE,
      discountType,
      discountValue,
      note: note.trim() || null,
      items,
    };
    try {
      if (editingId != null) {
        await update.mutateAsync({ id: editingId, data });
      } else {
        await create.mutateAsync({ data });
      }
      qc.invalidateQueries({
        queryKey: getListSalesOrdersQueryKey({ chatId }),
      });
      resetForm();
      toast({ title: "Sales order tersimpan" });
    } catch (err) {
      toast({
        title: "Gagal menyimpan order",
        description: err instanceof Error ? err.message : "Coba lagi.",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        {/* Draft editor */}
        <div className="flex items-center gap-2">
          <ProductPicker onPick={addCatalogLine} />
          <Button
            type="button"
            variant="outline"
            data-testid="button-add-custom-item"
            onClick={addCustomLine}
            className="h-9 flex-1 gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
          >
            <Plus className="w-3.5 h-3.5" /> Item manual
          </Button>
        </div>

        {lines.length === 0 ? (
          <p className="text-xs text-[hsl(var(--wa-meta))] text-center py-4">
            Belum ada item. Tambahkan dari katalog atau manual.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {lines.map((l) => (
              <li
                key={l.key}
                data-testid={`draft-line-${l.key}`}
                className="rounded-lg border border-[hsl(var(--wa-divider))] p-2 flex flex-col gap-2"
              >
                <div className="flex items-start gap-2">
                  <Input
                    data-testid={`input-line-name-${l.key}`}
                    value={l.name}
                    onChange={(e) => updateLine(l.key, { name: e.target.value })}
                    placeholder="Nama item"
                    className="h-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    data-testid={`button-remove-line-${l.key}`}
                    onClick={() => removeLine(l.key)}
                    className="h-8 w-8 flex-shrink-0 text-red-400 hover:text-red-400"
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex flex-col gap-0.5 w-14 flex-shrink-0">
                    <Label className="text-[10px] text-[hsl(var(--wa-meta))]">
                      Qty
                    </Label>
                    <Input
                      type="number"
                      min={1}
                      data-testid={`input-line-qty-${l.key}`}
                      value={l.qty}
                      onChange={(e) =>
                        updateLine(l.key, {
                          qty: Math.max(1, Math.floor(Number(e.target.value) || 0)),
                        })
                      }
                      className="h-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                    />
                  </div>
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <Label className="text-[10px] text-[hsl(var(--wa-meta))]">
                      Harga satuan
                    </Label>
                    <Input
                      type="number"
                      min={0}
                      data-testid={`input-line-price-${l.key}`}
                      value={l.price}
                      onChange={(e) =>
                        updateLine(l.key, {
                          price: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                        })
                      }
                      className="h-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                    />
                  </div>
                </div>
                <div className="flex items-end gap-2">
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <Label className="text-[10px] text-[hsl(var(--wa-meta))]">
                      Diskon item
                    </Label>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid={`toggle-line-discount-type-${l.key}`}
                        onClick={() =>
                          updateLine(l.key, {
                            discountType:
                              l.discountType === "percent" ? "amount" : "percent",
                            discountValue:
                              l.discountType === "percent"
                                ? l.discountValue
                                : Math.min(100, l.discountValue),
                          })
                        }
                        className="h-8 w-10 flex-shrink-0 rounded-md border border-[hsl(var(--wa-divider))] text-xs font-medium text-foreground hover:bg-white/5 transition-colors"
                      >
                        {l.discountType === "percent" ? "%" : "Rp"}
                      </button>
                      <Input
                        type="number"
                        min={0}
                        max={l.discountType === "percent" ? 100 : undefined}
                        data-testid={`input-line-discount-${l.key}`}
                        value={l.discountValue}
                        onChange={(e) => {
                          const raw = Math.max(
                            0,
                            Math.floor(Number(e.target.value) || 0)
                          );
                          updateLine(l.key, {
                            discountValue:
                              l.discountType === "percent"
                                ? Math.min(100, raw)
                                : raw,
                          });
                        }}
                        className="h-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-0.5 items-end w-24 flex-shrink-0">
                    <Label className="text-[10px] text-[hsl(var(--wa-meta))]">
                      Subtotal
                    </Label>
                    <span className="text-xs font-medium text-foreground h-8 flex items-center">
                      {formatRupiah(lineNetTotal(l))}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* PPN controls */}
        <div className="rounded-lg border border-[hsl(var(--wa-divider))] p-2.5 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <Label
              htmlFor="ppn-toggle"
              className="text-xs font-medium text-foreground"
            >
              PPN {PPN_RATE}%
            </Label>
            <Switch
              id="ppn-toggle"
              data-testid="switch-ppn"
              checked={ppnEnabled}
              onCheckedChange={setPpnEnabled}
            />
          </div>
          {ppnEnabled ? (
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                data-testid="radio-ppn-included"
                onClick={() => setPpnIncluded(true)}
                className="flex items-center gap-2 text-left"
              >
                <span
                  className={cn(
                    "w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0",
                    ppnIncluded
                      ? "border-[hsl(var(--wa-accent))]"
                      : "border-[hsl(var(--wa-divider))]"
                  )}
                >
                  {ppnIncluded ? (
                    <span className="w-2 h-2 rounded-full bg-[hsl(var(--wa-accent))]" />
                  ) : null}
                </span>
                <span className="text-xs text-foreground">
                  Harga sudah termasuk PPN
                </span>
              </button>
              <button
                type="button"
                data-testid="radio-ppn-excluded"
                onClick={() => setPpnIncluded(false)}
                className="flex items-center gap-2 text-left"
              >
                <span
                  className={cn(
                    "w-3.5 h-3.5 rounded-full border flex items-center justify-center flex-shrink-0",
                    !ppnIncluded
                      ? "border-[hsl(var(--wa-accent))]"
                      : "border-[hsl(var(--wa-divider))]"
                  )}
                >
                  {!ppnIncluded ? (
                    <span className="w-2 h-2 rounded-full bg-[hsl(var(--wa-accent))]" />
                  ) : null}
                </span>
                <span className="text-xs text-foreground">
                  Harga belum termasuk PPN
                </span>
              </button>
            </div>
          ) : null}
        </div>

        {/* Global discount */}
        <div className="rounded-lg border border-[hsl(var(--wa-divider))] p-2.5 flex flex-col gap-1.5">
          <Label className="text-xs font-medium text-foreground">
            Diskon keseluruhan
          </Label>
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="toggle-global-discount-type"
              onClick={() =>
                setDiscountType((prev) => {
                  const next = prev === "percent" ? "amount" : "percent";
                  if (next === "percent")
                    setDiscountValue((v) => Math.min(100, v));
                  return next;
                })
              }
              className="h-8 w-10 flex-shrink-0 rounded-md border border-[hsl(var(--wa-divider))] text-xs font-medium text-foreground hover:bg-white/5 transition-colors"
            >
              {discountType === "percent" ? "%" : "Rp"}
            </button>
            <Input
              type="number"
              min={0}
              max={discountType === "percent" ? 100 : undefined}
              data-testid="input-global-discount"
              value={discountValue}
              onChange={(e) => {
                const raw = Math.max(0, Math.floor(Number(e.target.value) || 0));
                setDiscountValue(
                  discountType === "percent" ? Math.min(100, raw) : raw
                );
              }}
              placeholder="0"
              className="h-8 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
            />
          </div>
        </div>

        <Textarea
          data-testid="input-order-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Catatan (opsional)…"
          className="text-xs bg-transparent border-[hsl(var(--wa-divider))] min-h-[60px]"
        />

        {/* Totals */}
        <div className="flex flex-col gap-1 text-xs">
          <div className="flex items-center justify-between text-[hsl(var(--wa-meta))]">
            <span>Subtotal</span>
            <span data-testid="text-subtotal">{formatRupiah(subtotal)}</span>
          </div>
          {discountAmount > 0 ? (
            <div className="flex items-center justify-between text-[hsl(var(--wa-meta))]">
              <span>
                Diskon{discountType === "percent" ? ` ${discountValue}%` : ""}
              </span>
              <span data-testid="text-discount">
                -{formatRupiah(discountAmount)}
              </span>
            </div>
          ) : null}
          {ppnEnabled ? (
            <div className="flex items-center justify-between text-[hsl(var(--wa-meta))]">
              <span>
                PPN {PPN_RATE}%{ppnIncluded ? " (termasuk)" : ""}
              </span>
              <span data-testid="text-ppn">{formatRupiah(ppnAmount)}</span>
            </div>
          ) : null}
          <div className="flex items-center justify-between font-semibold text-foreground text-sm">
            <span>Total</span>
            <span data-testid="text-total">{formatRupiah(total)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {editingId != null ? (
            <Button
              type="button"
              variant="outline"
              data-testid="button-cancel-edit"
              onClick={resetForm}
              className="h-9 gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
            >
              Batal
            </Button>
          ) : null}
          <Button
            type="button"
            data-testid="button-save-order"
            onClick={handleSave}
            disabled={saving}
            className="h-9 flex-1 gap-1.5 text-xs"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Receipt className="w-3.5 h-3.5" />
            )}
            {editingId != null ? "Perbarui order" : "Simpan order"}
          </Button>
        </div>

        <Separator className="bg-[hsl(var(--wa-divider))]" />

        {/* Saved orders */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-[hsl(var(--wa-meta))]">
            Order tersimpan
          </p>
          {ordersLoading ? (
            <div className="flex items-center gap-2 text-xs text-[hsl(var(--wa-meta))] py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat…
            </div>
          ) : orders.length === 0 ? (
            <p className="text-xs text-[hsl(var(--wa-meta))] text-center py-3">
              Belum ada order tersimpan.
            </p>
          ) : (
            orders.map((o) => (
              <SavedOrderCard
                key={o.id}
                order={o}
                onEdit={startEdit}
                chatId={chatId}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// Group info, members, invite link/QR + add-member (group chats only).
function GroupTab({
  chatId,
  contactName,
}: {
  chatId: number;
  contactName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError } = useGetGroupInfo(chatId, {
    query: { queryKey: getGetGroupInfoQueryKey(chatId) },
  });
  const [showQr, setShowQr] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [selectedPhones, setSelectedPhones] = useState<string[]>([]);

  const addMut = useAddGroupParticipants({
    mutation: {
      onSuccess: (res) => {
        const results = res?.results ?? [];
        const ok = results.filter((r) => r.status === "200").length;
        const failed = results.length - ok;
        toast({
          title: "Tambah anggota selesai",
          description: `${ok} berhasil${failed > 0 ? `, ${failed} gagal (mungkin perlu undangan)` : ""}.`,
          variant: failed > 0 ? "destructive" : undefined,
        });
        setSelectedPhones([]);
        setAddOpen(false);
        qc.invalidateQueries({ queryKey: getGetGroupInfoQueryKey(chatId) });
      },
      onError: (err: any) =>
        toast({
          title: "Gagal menambah anggota",
          description: err?.message ?? "",
          variant: "destructive",
        }),
    },
  });

  function handleAdd() {
    if (selectedPhones.length === 0) {
      toast({ title: "Pilih minimal satu kontak.", variant: "destructive" });
      return;
    }
    addMut.mutate({ id: chatId, data: { phones: selectedPhones } });
  }

  function copyLink(link: string) {
    navigator.clipboard.writeText(link).then(
      () => toast({ title: "Link undangan disalin." }),
      () => toast({ title: "Gagal menyalin.", variant: "destructive" })
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--wa-meta))]" />
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="p-4 text-xs text-[hsl(var(--wa-meta))]">
        Tidak bisa memuat info grup. Pastikan WhatsApp terhubung.
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold break-words">
          {data.subject || contactName}
        </p>
        {data.description && (
          <p className="text-xs text-[hsl(var(--wa-meta))] whitespace-pre-wrap break-words">
            {data.description}
          </p>
        )}
        <p className="text-[11px] text-[hsl(var(--wa-meta))]">
          {data.size} anggota
        </p>
      </div>

      {data.inviteLink && (
        <div className="space-y-2">
          <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide flex items-center gap-1">
            <LinkIcon className="w-3 h-3" /> Link undangan
          </Label>
          <div className="flex items-center gap-1.5">
            <Input
              readOnly
              value={data.inviteLink}
              data-testid="input-group-invite-link"
              className="h-8 text-[11px] bg-transparent border-[hsl(var(--wa-divider))]"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              data-testid="button-copy-invite-link"
              onClick={() => copyLink(data.inviteLink!)}
              className="h-8 w-8 flex-shrink-0"
              title="Salin link"
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              data-testid="button-toggle-invite-qr"
              onClick={() => setShowQr((s) => !s)}
              className="h-8 w-8 flex-shrink-0"
              title="Tampilkan QR"
            >
              <QrCode className="w-3.5 h-3.5" />
            </Button>
          </div>
          {showQr && (
            <div className="flex justify-center rounded-md bg-white p-3">
              <QRCodeSVG value={data.inviteLink} size={160} />
            </div>
          )}
        </div>
      )}

      <Separator className="bg-[hsl(var(--wa-divider))]" />

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide flex items-center gap-1">
            <Users className="w-3 h-3" /> Anggota
          </Label>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="button-toggle-add-member"
            onClick={() => setAddOpen((s) => !s)}
            className="h-7 px-2 text-[11px] gap-1"
          >
            <UserPlus className="w-3.5 h-3.5" /> Tambah
          </Button>
        </div>

        {addOpen && (
          <div className="space-y-2 rounded-md border border-[hsl(var(--wa-divider))] p-2.5">
            <p className="text-[11px] text-amber-500">
              ⚠️ Anggota akan ditambahkan langsung ke grup WhatsApp asli.
            </p>
            <ContactPicker
              selected={selectedPhones}
              onChange={setSelectedPhones}
              excludePhones={(data.participants ?? [])
                .map((p) => p.phone ?? "")
                .filter(Boolean)}
              height="h-44"
              emptyHint="Tidak ada kontak untuk ditambahkan."
            />
            <Button
              type="button"
              size="sm"
              data-testid="button-confirm-add-member"
              onClick={handleAdd}
              disabled={addMut.isPending || selectedPhones.length === 0}
              className="w-full h-8 text-xs"
            >
              {addMut.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                "Tambahkan ke grup"
              )}
            </Button>
          </div>
        )}

        <div className="space-y-0.5">
          {data.participants.map((p) => (
            <div
              key={p.jid}
              data-testid={`group-member-${p.jid}`}
              className="flex items-center gap-2 py-1"
            >
              <ChatAvatar
                name={p.name ?? (p.phone ? `+${p.phone}` : "?")}
                profilePicUrl={null}
                size={28}
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs truncate">
                  {p.name ?? (p.phone ? `+${p.phone}` : "Anggota grup")}
                </p>
              </div>
              {(p.isAdmin || p.isSuperAdmin) && (
                <span className="flex items-center gap-0.5 text-[10px] text-[hsl(var(--wa-accent))] flex-shrink-0">
                  <ShieldCheck className="w-3 h-3" />
                  {p.isSuperAdmin ? "Pemilik" : "Admin"}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Shared media / documents / links + MaxiChat starred messages for any chat.
function MediaTab({ chatId }: { chatId: number }) {
  const [sub, setSub] = useState<"media" | "docs" | "links" | "starred">(
    "media"
  );
  const { data, isLoading } = useGetChatAttachments(chatId, {
    query: { queryKey: getGetChatAttachmentsQueryKey(chatId) },
  });
  const { data: starred } = useGetStarredMessages(chatId, {
    query: { queryKey: getGetStarredMessagesQueryKey(chatId) },
  });

  const media = data?.media ?? [];
  const docs = data?.docs ?? [];
  const links = data?.links ?? [];
  const starredMsgs = starred?.messages ?? [];

  return (
    <div className="flex flex-1 flex-col min-h-0">
      <div className="flex border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
        {([
          { key: "media", label: "Media" },
          { key: "docs", label: "Dokumen" },
          { key: "links", label: "Link" },
          { key: "starred", label: "Berbintang" },
        ] as const).map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`tab-media-${s.key}`}
            onClick={() => setSub(s.key)}
            className={cn(
              "flex-1 py-2 text-[11px] font-medium border-b-2 transition-colors",
              sub === s.key
                ? "border-[hsl(var(--wa-accent))] text-foreground"
                : "border-transparent text-[hsl(var(--wa-meta))] hover:text-foreground"
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {isLoading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="w-5 h-5 animate-spin text-[hsl(var(--wa-meta))]" />
          </div>
        ) : sub === "media" ? (
          media.length === 0 ? (
            <EmptyHint text="Belum ada media." />
          ) : (
            <div className="grid grid-cols-3 gap-1">
              {media.map((m) => (
                <a
                  key={m.id}
                  href={m.mediaUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`attachment-media-${m.id}`}
                  className="block aspect-square overflow-hidden rounded bg-black/20"
                >
                  {m.mediaType === "video" ? (
                    <video
                      src={m.mediaUrl ?? undefined}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <img
                      src={m.mediaUrl ?? undefined}
                      alt={m.mediaFilename ?? "media"}
                      className="h-full w-full object-cover"
                    />
                  )}
                </a>
              ))}
            </div>
          )
        ) : sub === "docs" ? (
          docs.length === 0 ? (
            <EmptyHint text="Belum ada dokumen." />
          ) : (
            <div className="space-y-1">
              {docs.map((d) => (
                <a
                  key={d.id}
                  href={d.mediaUrl ?? "#"}
                  target="_blank"
                  rel="noreferrer"
                  download={d.mediaFilename ?? undefined}
                  data-testid={`attachment-doc-${d.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-white/5"
                >
                  <FileText className="w-4 h-4 flex-shrink-0 opacity-70" />
                  <span className="truncate text-xs">
                    {d.mediaFilename ?? "Dokumen"}
                  </span>
                </a>
              ))}
            </div>
          )
        ) : sub === "links" ? (
          links.length === 0 ? (
            <EmptyHint text="Belum ada link." />
          ) : (
            <div className="space-y-1">
              {links.map((l, i) => (
                <a
                  key={`${l.messageId}-${i}`}
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid={`attachment-link-${l.messageId}-${i}`}
                  className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-white/5"
                >
                  <ExternalLink className="w-4 h-4 flex-shrink-0 opacity-70" />
                  <span className="truncate text-xs text-[hsl(var(--wa-accent))]">
                    {l.url}
                  </span>
                </a>
              ))}
            </div>
          )
        ) : starredMsgs.length === 0 ? (
          <EmptyHint text="Belum ada pesan berbintang." />
        ) : (
          <div className="space-y-2">
            {starredMsgs.map((m) => (
              <div
                key={m.id}
                data-testid={`starred-message-${m.id}`}
                className="rounded-md border border-[hsl(var(--wa-divider))] p-2"
              >
                <div className="mb-1 flex items-center gap-1 text-[10px] text-[hsl(var(--wa-meta))]">
                  <Star className="w-3 h-3 text-amber-400" fill="currentColor" />
                  {m.senderName ?? (m.direction === "outbound" ? "Anda" : "Kontak")}
                </div>
                <p className="whitespace-pre-wrap break-words text-xs">
                  {m.content || "[media]"}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Groups a 1:1 contact shares with the connected account.
function CommonGroupsSection({ chatId }: { chatId: number }) {
  const [enabled, setEnabled] = useState(false);
  const { data, isLoading, isError } = useGetCommonGroups(chatId, {
    query: {
      queryKey: getGetCommonGroupsQueryKey(chatId),
      enabled,
      staleTime: 60_000,
    },
  });
  const groups = data?.groups ?? [];

  return (
    <div className="space-y-1.5">
      <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide flex items-center gap-1">
        <Users className="w-3 h-3" /> Grup bersama
      </Label>
      {!enabled ? (
        <button
          type="button"
          data-testid="button-load-common-groups"
          onClick={() => setEnabled(true)}
          className="text-[11px] text-[hsl(var(--wa-accent))] hover:underline"
        >
          Lihat grup bersama
        </button>
      ) : isLoading ? (
        <Loader2 className="w-4 h-4 animate-spin text-[hsl(var(--wa-meta))]" />
      ) : isError ? (
        <p className="text-[11px] text-[hsl(var(--wa-meta))]">
          Tidak bisa memuat (WhatsApp tidak terhubung).
        </p>
      ) : groups.length === 0 ? (
        <p className="text-[11px] text-[hsl(var(--wa-meta))]">
          Tidak ada grup bersama.
        </p>
      ) : (
        <div className="space-y-0.5">
          {groups.map((g) => (
            <div
              key={g.groupJid}
              data-testid={`common-group-${g.groupJid}`}
              className="flex items-center gap-2 py-1"
            >
              <Users className="w-3.5 h-3.5 flex-shrink-0 text-[hsl(var(--wa-meta))]" />
              {g.chatId != null ? (
                <a
                  href={`/chats/${g.chatId}`}
                  className="truncate text-xs text-[hsl(var(--wa-accent))] hover:underline"
                >
                  {g.subject || "Grup"}
                </a>
              ) : (
                <span className="truncate text-xs">{g.subject || "Grup"}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <p className="py-8 text-center text-xs text-[hsl(var(--wa-meta))]">{text}</p>
  );
}

// Lead-score → band (mirrors the server's scoreCategory: 0–39 Low, 40–69
// Medium, 70–100 High). Used only for the badge color/label in the sidebar.
function scoreBand(score: number): {
  label: string;
  className: string;
} {
  if (score >= 70)
    return {
      label: "Tinggi",
      className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    };
  if (score >= 40)
    return {
      label: "Sedang",
      className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    };
  return {
    label: "Rendah",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  };
}

const WAITING_STATUS_LABEL: Record<string, string> = {
  waiting_customer: "Menunggu balasan customer",
  waiting_company: "Menunggu balasan Anda",
};

function InsightRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
        {label}
      </p>
      <div className="text-xs text-foreground">{children}</div>
    </div>
  );
}

// AI Sales Insight tab. Surfaces the latest per-chat analysis (lead score,
// intent, product interest, estimated value, waiting status, recommendation,
// AI notes) plus the tenant-level Auto-Create Opportunity toggle. Gated by the
// caller on Enterprise entitlement + the "opportunities" view permission.
function SalesInsightTab({
  chatId,
  canEditSettings,
  canCreateOpportunity,
}: {
  chatId: number;
  canEditSettings: boolean;
  canCreateOpportunity: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const {
    data: insight,
    isLoading,
    error,
  } = useGetChatSalesInsight(chatId, {
    query: { queryKey: getGetChatSalesInsightQueryKey(chatId), retry: false },
  });

  const createOpportunity = useCreateOpportunity({
    mutation: {
      onSuccess: () => {
        // The created opportunity's stage + last activity now live alongside the
        // insight; re-fetch so the body swaps "Buat Opportunity" for the stage.
        qc.invalidateQueries({
          queryKey: getGetChatSalesInsightQueryKey(chatId),
        });
        toast({ description: "Opportunity dibuat." });
      },
      onError: () => {
        toast({
          variant: "destructive",
          description: "Gagal membuat opportunity.",
        });
      },
    },
  });
  // A 404 means "not analyzed yet" — that is an expected empty state, not an
  // error to surface.
  const notAnalyzed =
    !!error &&
    typeof error === "object" &&
    "status" in (error as unknown as Record<string, unknown>) &&
    (error as unknown as { status?: number }).status === 404;

  const analyze = useAnalyzeChatSalesInsight({
    mutation: {
      onSuccess: (data) => {
        qc.setQueryData(getGetChatSalesInsightQueryKey(chatId), data);
        toast({ description: "Analisa AI diperbarui." });
      },
      onError: () => {
        toast({
          variant: "destructive",
          description: "Analisa AI gagal. Coba lagi.",
        });
      },
    },
  });

  const { data: pipelines } = useListPipelines({
    query: {
      queryKey: getListPipelinesQueryKey(),
      enabled: canCreateOpportunity,
    },
  });

  const { data: settings } = useGetSalesAssistantSettings({
    query: {
      queryKey: getGetSalesAssistantSettingsQueryKey(),
      enabled: canEditSettings,
    },
  });
  const updateSettings = useUpdateSalesAssistantSettings({
    mutation: {
      onSuccess: (data) => {
        qc.setQueryData(getGetSalesAssistantSettingsQueryKey(), data);
      },
      onError: () => {
        toast({
          variant: "destructive",
          description: "Gagal menyimpan setelan.",
        });
      },
    },
  });

  const [thresholdDraft, setThresholdDraft] = useState<string>("");
  useEffect(() => {
    if (settings) setThresholdDraft(String(settings.autoCreateThreshold));
  }, [settings?.autoCreateThreshold]);

  function commitThreshold() {
    if (!settings) return;
    const n = Number(thresholdDraft);
    if (!Number.isInteger(n) || n < 0 || n > 100) {
      setThresholdDraft(String(settings.autoCreateThreshold));
      toast({
        variant: "destructive",
        description: "Threshold harus bilangan bulat 0–100.",
      });
      return;
    }
    if (n === settings.autoCreateThreshold) return;
    updateSettings.mutate({ data: { autoCreateThreshold: n } });
  }

  // Auto Follow-Up timing. Presets cover the common silence windows; "Custom"
  // reveals a free-form hours input (1–8760). The committed value is in hours.
  const FOLLOW_UP_PRESETS = [24, 48, 72, 168] as const;
  const [followUpCustom, setFollowUpCustom] = useState(false);
  const [followUpDraft, setFollowUpDraft] = useState<string>("");
  useEffect(() => {
    if (!settings) return;
    const hrs = settings.followUpIntervalHours;
    setFollowUpCustom(
      !FOLLOW_UP_PRESETS.includes(hrs as (typeof FOLLOW_UP_PRESETS)[number])
    );
    setFollowUpDraft(String(hrs));
  }, [settings?.followUpIntervalHours]);

  function commitFollowUpInterval(raw: string) {
    if (!settings) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 8760) {
      setFollowUpDraft(String(settings.followUpIntervalHours));
      toast({
        variant: "destructive",
        description: "Interval follow-up harus bilangan bulat 1–8760 jam.",
      });
      return;
    }
    if (n === settings.followUpIntervalHours) return;
    updateSettings.mutate({ data: { followUpIntervalHours: n } });
  }

  const running = analyze.isPending;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="w-4 h-4 text-[hsl(var(--wa-accent))]" />
          AI Sales Assistant
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="button-analyze-sales-insight"
          disabled={running}
          onClick={() => analyze.mutate({ chatId })}
          className="h-7 gap-1 text-xs"
        >
          {running ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          {insight || notAnalyzed ? "Analisa ulang" : "Analisa"}
        </Button>
      </div>

      {isLoading ? (
        <p className="flex items-center justify-center gap-2 py-8 text-xs text-[hsl(var(--wa-meta))]">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Memuat…
        </p>
      ) : insight ? (
        <SalesInsightBody
          insight={insight}
          chatId={chatId}
          canCreateOpportunity={canCreateOpportunity}
          canEditOpportunity={canEditSettings}
          creating={createOpportunity.isPending}
          pipelines={pipelines ?? []}
          onCreateOpportunity={(payload) =>
            createOpportunity.mutate({
              data: {
                chatId,
                ...payload,
              },
            })
          }
        />
      ) : (
        <EmptyHint
          text={
            notAnalyzed
              ? "Belum ada analisa. Klik “Analisa” untuk menilai percakapan ini."
              : "Analisa belum tersedia untuk chat ini."
          }
        />
      )}

      {canEditSettings && settings ? (
        <div className="pt-2 border-t border-[hsl(var(--wa-divider))] space-y-3">
          <p className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
            Auto-Create Opportunity
          </p>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground">
              Buat opportunity otomatis saat skor tinggi
            </span>
            <Switch
              data-testid="switch-auto-create-opportunity"
              checked={settings.autoCreateEnabled}
              disabled={updateSettings.isPending}
              onCheckedChange={(checked) =>
                updateSettings.mutate({
                  data: { autoCreateEnabled: checked },
                })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-foreground">Ambang skor (0–100)</span>
            <Input
              data-testid="input-auto-create-threshold"
              type="number"
              min={0}
              max={100}
              value={thresholdDraft}
              disabled={!settings.autoCreateEnabled || updateSettings.isPending}
              onChange={(e) => setThresholdDraft(e.target.value)}
              onBlur={commitThreshold}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              className="h-8 w-20 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
            />
          </div>

          <div className="pt-3 border-t border-[hsl(var(--wa-divider))] space-y-3">
            <p className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
              Auto Follow-Up
            </p>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-foreground">
                Kirim follow-up otomatis (maks. 3×)
              </span>
              <Switch
                data-testid="switch-auto-follow-up"
                checked={settings.autoFollowUpEnabled}
                disabled={updateSettings.isPending}
                onCheckedChange={(checked) =>
                  updateSettings.mutate({
                    data: { autoFollowUpEnabled: checked },
                  })
                }
              />
            </div>
            <p className="text-[11px] leading-relaxed text-[hsl(var(--wa-meta))]">
              {settings.autoFollowUpEnabled
                ? "AI menyusun & mengirim pesan follow-up ke customer yang belum membalas, dengan jeda alami. Berhenti otomatis bila customer membalas atau minta berhenti."
                : "Nonaktif: AI hanya merekomendasikan follow-up (tidak mengirim). Aktifkan agar dikirim otomatis."}
            </p>
            <div className="space-y-1.5">
              <span className="text-xs text-foreground">
                Kirim setelah hening
              </span>
              <div className="flex flex-wrap gap-1.5">
                {FOLLOW_UP_PRESETS.map((h) => {
                  const active =
                    !followUpCustom && settings.followUpIntervalHours === h;
                  return (
                    <button
                      key={h}
                      type="button"
                      data-testid={`button-follow-up-preset-${h}`}
                      disabled={updateSettings.isPending}
                      onClick={() => {
                        setFollowUpCustom(false);
                        commitFollowUpInterval(String(h));
                      }}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        active
                          ? "border-[hsl(var(--wa-accent))] bg-[hsl(var(--wa-accent))]/10 text-foreground"
                          : "border-[hsl(var(--wa-divider))] text-[hsl(var(--wa-meta))] hover:text-foreground"
                      )}
                    >
                      {h === 168 ? "7 hari" : `${h} jam`}
                    </button>
                  );
                })}
                <button
                  type="button"
                  data-testid="button-follow-up-preset-custom"
                  disabled={updateSettings.isPending}
                  onClick={() => setFollowUpCustom(true)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px] transition-colors",
                    followUpCustom
                      ? "border-[hsl(var(--wa-accent))] bg-[hsl(var(--wa-accent))]/10 text-foreground"
                      : "border-[hsl(var(--wa-divider))] text-[hsl(var(--wa-meta))] hover:text-foreground"
                  )}
                >
                  Custom
                </button>
              </div>
              {followUpCustom ? (
                <div className="flex items-center gap-2 pt-1">
                  <Input
                    data-testid="input-follow-up-custom-hours"
                    type="number"
                    min={1}
                    max={8760}
                    value={followUpDraft}
                    disabled={updateSettings.isPending}
                    onChange={(e) => setFollowUpDraft(e.target.value)}
                    onBlur={(e) => commitFollowUpInterval(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="h-8 w-24 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                  />
                  <span className="text-[11px] text-[hsl(var(--wa-meta))]">
                    jam (1–8760)
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const FOLLOW_UP_STATUS_LABEL: Record<string, string> = {
  sent: "Terkirim",
  pending: "Terjadwal",
  cancelled: "Dibatalkan",
  skipped: "Dilewati",
};

// Surfaces the per-opportunity follow-up plan in the chat sidebar: queued
// touches (status `pending`) and already-sent ones. When the tenant's Auto
// Follow-Up toggle is OFF, the engine writes a recommendation row (status
// `pending`, no drafted message) — we show those as "Disarankan" so the user
// sees what AI WOULD send. Cancelled/skipped rows are hidden to keep it focused.
function FollowUpSection({
  opportunityId,
  chatId,
  canEdit,
}: {
  opportunityId: number;
  chatId: number;
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError } = useListOpportunityFollowUps(
    opportunityId,
    {
      query: {
        queryKey: getListOpportunityFollowUpsQueryKey(opportunityId),
        retry: false,
      },
    }
  );

  // Which pending row is currently being edited inline, plus its draft text.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  function refresh() {
    qc.invalidateQueries({
      queryKey: getListOpportunityFollowUpsQueryKey(opportunityId),
    });
    // The sidebar's "last activity" / recommendation can shift after a send.
    qc.invalidateQueries({ queryKey: getGetChatSalesInsightQueryKey(chatId) });
  }

  const sendFollowUp = useSendOpportunityFollowUp({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ description: "Follow-up terkirim." });
      },
      onError: () => {
        toast({
          variant: "destructive",
          description: "Gagal mengirim follow-up. Coba lagi.",
        });
        refresh();
      },
    },
  });
  const updateFollowUp = useUpdateOpportunityFollowUp({
    mutation: {
      onSuccess: () => {
        setEditingId(null);
        refresh();
      },
      onError: () => {
        toast({
          variant: "destructive",
          description: "Gagal menyimpan perubahan follow-up.",
        });
      },
    },
  });

  const pending = sendFollowUp.isPending || updateFollowUp.isPending;

  const items = (data ?? []).filter(
    (f) => f.status === "pending" || f.status === "sent"
  );
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
        Follow-up
      </p>
      {isLoading ? (
        <p className="text-[11px] text-[hsl(var(--wa-meta))]">Memuat…</p>
      ) : isError ? (
        <p className="text-[11px] text-red-400">Gagal memuat follow-up.</p>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-[hsl(var(--wa-meta))]">
          Belum ada follow-up terjadwal.
        </p>
      ) : (
        <ul className="space-y-2" data-testid="follow-up-list">
          {items.map((f) => {
            const sent = f.status === "sent";
            const recommendationOnly =
              f.status === "pending" && !f.generatedMessage;
            const when = sent ? f.sentAt : f.scheduledAt;
            const isEditing = editingId === f.id;
            // Manual controls only on still-pending touches, and only when the
            // caller can edit opportunities. A recommendation-only row (no
            // drafted message) can still be sent — the server drafts on send.
            const showActions = canEdit && f.status === "pending";
            return (
              <li
                key={f.id}
                data-testid={`follow-up-${f.id}`}
                className="rounded-md border border-[hsl(var(--wa-divider))] bg-white/[0.02] p-2 space-y-1"
              >
                <div className="flex items-center gap-1.5 text-[11px]">
                  {sent ? (
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-400" />
                  ) : (
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                  )}
                  <span className="font-medium text-foreground">
                    Follow-up ke-{f.sequence}
                  </span>
                  <span
                    className={cn(
                      "ml-auto",
                      sent ? "text-emerald-400" : "text-amber-400"
                    )}
                  >
                    {recommendationOnly
                      ? "Disarankan"
                      : FOLLOW_UP_STATUS_LABEL[f.status] ?? f.status}
                  </span>
                </div>
                <p className="text-[10px] text-[hsl(var(--wa-meta))]">
                  {sent ? "Terkirim" : "Jatuh tempo"}{" "}
                  {when ? new Date(when).toLocaleString("id-ID") : "—"}
                </p>
                {isEditing ? (
                  <div className="space-y-1.5">
                    <Textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={3}
                      placeholder="Tulis pesan follow-up…"
                      className="text-xs"
                      data-testid={`textarea-follow-up-${f.id}`}
                    />
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        disabled={pending || draft.trim().length === 0}
                        data-testid={`button-save-follow-up-${f.id}`}
                        onClick={() =>
                          updateFollowUp.mutate({
                            id: opportunityId,
                            followUpId: f.id,
                            data: { generatedMessage: draft.trim() },
                          })
                        }
                      >
                        Simpan
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={pending}
                        data-testid={`button-cancel-edit-follow-up-${f.id}`}
                        onClick={() => setEditingId(null)}
                      >
                        Batal
                      </Button>
                    </div>
                  </div>
                ) : f.generatedMessage ? (
                  <p className="text-xs text-foreground whitespace-pre-wrap">
                    {f.generatedMessage}
                  </p>
                ) : recommendationOnly ? (
                  <p className="text-[10px] italic text-[hsl(var(--wa-meta))]">
                    Pesan akan dibuat otomatis saat dikirim.
                  </p>
                ) : null}
                {showActions && !isEditing ? (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    <Button
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      disabled={pending}
                      data-testid={`button-send-follow-up-${f.id}`}
                      onClick={() =>
                        sendFollowUp.mutate({
                          id: opportunityId,
                          followUpId: f.id,
                        })
                      }
                    >
                      <Send className="w-3 h-3 mr-1" />
                      Kirim sekarang
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[11px]"
                      disabled={pending}
                      data-testid={`button-edit-follow-up-${f.id}`}
                      onClick={() => {
                        setEditingId(f.id);
                        setDraft(f.generatedMessage ?? "");
                      }}
                    >
                      <Pencil className="w-3 h-3 mr-1" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-red-400 hover:text-red-300"
                      disabled={pending}
                      data-testid={`button-cancel-follow-up-${f.id}`}
                      onClick={() =>
                        updateFollowUp.mutate({
                          id: opportunityId,
                          followUpId: f.id,
                          data: { status: "cancelled" },
                        })
                      }
                    >
                      <X className="w-3 h-3 mr-1" />
                      Batalkan
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function timeAgoInsight(iso: string | null | undefined): string {
  if (!iso) return "Belum ada aktivitas";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "Hari ini";
  if (days === 1) return "1 hari lalu";
  if (days < 30) return `${days} hari lalu`;
  const m = Math.floor(days / 30);
  return m === 1 ? "1 bulan lalu" : `${m} bulan lalu`;
}

function ManualAddMenu({
  pipelines,
  creating,
  showLabel,
  onSelect,
}: {
  pipelines: Array<{ id: number; name: string; color: string }>;
  creating: boolean;
  showLabel: boolean;
  onSelect: (pipelineId: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={showLabel ? "outline" : "ghost"}
          disabled={creating}
          className="h-8 w-full gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
        >
          {creating ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Plus className="w-3.5 h-3.5" />
          )}
          {showLabel ? "Buat Opportunity" : "Tambah Opportunity Manual"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-1.5 space-y-0.5">
        <p className="text-[10px] text-[hsl(var(--wa-meta))] px-1.5 pb-1">
          Pilih pipeline:
        </p>
        {pipelines.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => { onSelect(p.id); setOpen(false); }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-white/5"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ background: p.color }}
            />
            {p.name}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

type DetectedCandidate = {
  intentKey: string;
  intentType: string;
  pipelineType: string;
  products: string[];
  intentCategory: string;
  leadScore: number;
  estimatedValueIdr: number;
  scoreReason: string | null;
  aiNotes: string | null;
  recommendation: string | null;
};

type CreateOpportunityPayload = {
  pipelineId?: number | null;
  intentKey?: string | null;
  leadScore?: number;
  intentCategory?: string | null;
  estimatedValueIdr?: number;
  productInterest?: string[];
  aiNotes?: string | null;
  waitingStatus?: string | null;
};

function SalesInsightBody({
  insight,
  chatId,
  canCreateOpportunity,
  canEditOpportunity,
  creating,
  onCreateOpportunity,
  pipelines,
}: {
  insight: SalesInsight;
  chatId: number;
  canCreateOpportunity: boolean;
  canEditOpportunity: boolean;
  creating: boolean;
  onCreateOpportunity: (payload: CreateOpportunityPayload) => void;
  pipelines: Pipeline[];
}) {
  const band = scoreBand(insight.leadScore);
  const opportunities = ((insight as any).opportunities as Array<{
    id: number;
    pipelineId?: number;
    pipelineName?: string;
    stageId?: number;
    stageName?: string;
    intentKey?: string;
    intentType?: string;
    leadScore: number;
    lastActivityAt?: string | null;
  }>) ?? [];
  const detectedCandidates = ((insight as any).detectedCandidates as DetectedCandidate[]) ?? [];
  const visiblePipelines = pipelines.filter((p) => !p.isArchived);

  // Candidates not yet persisted as opportunities (by intentKey).
  const createdIntentKeys = new Set(opportunities.map((o) => o.intentKey).filter(Boolean));
  const pendingCandidates = detectedCandidates.filter(
    (c) => !createdIntentKeys.has(c.intentKey)
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-md border px-2.5 py-1.5",
            band.className
          )}
        >
          <TrendingUp className="w-4 h-4" />
          <span className="text-lg font-semibold leading-none">
            {insight.leadScore}
          </span>
          <span className="text-[11px] font-medium uppercase tracking-wide">
            {band.label}
          </span>
        </div>
        {insight.intentCategory ? (
          <span className="rounded-full bg-white/5 px-2 py-1 text-[11px] text-foreground">
            {insight.intentCategory}
          </span>
        ) : null}
      </div>

      {insight.waitingStatus ? (
        <InsightRow label="Status">
          {WAITING_STATUS_LABEL[insight.waitingStatus] ?? insight.waitingStatus}
        </InsightRow>
      ) : null}

      <InsightRow label="Estimasi nilai">
        {formatRupiah(insight.estimatedValueIdr)}
      </InsightRow>

      {insight.productInterest.length > 0 ? (
        <InsightRow label="Minat produk">
          <div className="flex flex-wrap gap-1">
            {insight.productInterest.map((p, i) => (
              <span
                key={`${p}-${i}`}
                className="rounded-full bg-white/5 px-2 py-0.5 text-[11px]"
              >
                {p}
              </span>
            ))}
          </div>
        </InsightRow>
      ) : null}

      {insight.recommendation ? (
        <InsightRow label="Rekomendasi">{insight.recommendation}</InsightRow>
      ) : null}

      {insight.scoreReason ? (
        <InsightRow label="Alasan skor">{insight.scoreReason}</InsightRow>
      ) : null}

      {insight.aiNotes ? (
        <InsightRow label="Catatan AI">{insight.aiNotes}</InsightRow>
      ) : null}

      {/* Multi-opportunity list */}
      <div className="pt-2 border-t border-[hsl(var(--wa-divider))] space-y-3">
        <p className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
          Peluang ({opportunities.length})
        </p>

        {opportunities.length === 0 ? (
          <p className="text-[11px] text-[hsl(var(--wa-meta))]">
            Belum ada peluang terdeteksi untuk chat ini.
          </p>
        ) : (
          <div className="space-y-2">
            {opportunities.map((opp) => {
              const oppBand = scoreBand(opp.leadScore);
              return (
                <div
                  key={opp.id}
                  data-testid={`insight-opportunity-${opp.id}`}
                  className="rounded-lg border border-[hsl(var(--wa-divider))] bg-white/[0.02] p-2.5 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium",
                        oppBand.className
                      )}
                    >
                      <TrendingUp className="w-3 h-3" />
                      {opp.leadScore}
                    </span>
                    <span className="text-xs font-medium truncate">
                      {opp.intentKey ?? opp.intentType ?? "Peluang"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 text-[11px] text-[hsl(var(--wa-meta))]">
                    <span className="truncate">{opp.pipelineName ?? "Pipeline"}</span>
                    <ChevronRight className="w-3 h-3 shrink-0" />
                    <span className="truncate">{opp.stageName ?? "Tanpa Stage"}</span>
                  </div>
                  <p className="text-[10px] text-[hsl(var(--wa-meta))]">
                    {timeAgoInsight(opp.lastActivityAt)}
                  </p>
                  <FollowUpSection
                    opportunityId={opp.id}
                    chatId={chatId}
                    canEdit={canEditOpportunity}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Per-candidate create buttons (from AI analysis) */}
        {canCreateOpportunity ? (
          <div className="pt-1 space-y-1.5">
            {pendingCandidates.length > 0 && (
              <>
                <p className="text-[10px] text-[hsl(var(--wa-meta))]">
                  Kandidat AI belum dibuat:
                </p>
                {pendingCandidates.map((c) => {
                  const targetPipeline = visiblePipelines.find(
                    (p) => p.pipelineType === c.pipelineType
                  ) ?? visiblePipelines[0];
                  return (
                    <Button
                      key={c.intentKey}
                      type="button"
                      size="sm"
                      variant="outline"
                      data-testid={`button-create-candidate-${c.intentKey}`}
                      disabled={creating}
                      onClick={() =>
                        onCreateOpportunity({
                          pipelineId: targetPipeline?.id,
                          intentKey: c.intentKey,
                          leadScore: c.leadScore,
                          intentCategory: c.intentCategory,
                          estimatedValueIdr: c.estimatedValueIdr,
                          productInterest: c.products,
                          aiNotes: c.aiNotes,
                          waitingStatus: insight.waitingStatus ?? null,
                        })
                      }
                      className="h-auto min-h-[2rem] w-full gap-1.5 text-xs justify-start border-[hsl(var(--wa-divider))] py-1.5 px-2"
                    >
                      {creating ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                      ) : targetPipeline ? (
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: targetPipeline.color }}
                        />
                      ) : (
                        <Plus className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span className="flex-1 min-w-0 text-left leading-snug">
                        <span className="font-medium truncate block">
                          {c.intentKey.replace(/-/g, " ")}
                        </span>
                        <span className="text-[hsl(var(--wa-meta))] font-normal">
                          {formatRupiah(c.estimatedValueIdr)} · skor {c.leadScore}
                          {targetPipeline ? ` · ${targetPipeline.name}` : ""}
                        </span>
                      </span>
                    </Button>
                  );
                })}
              </>
            )}

            {/* Manual add — always visible so user can add opportunities not detected by AI */}
            {visiblePipelines.length === 0 ? null : visiblePipelines.length === 1 ? (
              <Button
                type="button"
                size="sm"
                variant={opportunities.length === 0 && pendingCandidates.length === 0 ? "outline" : "ghost"}
                data-testid="button-create-opportunity"
                disabled={creating}
                onClick={() =>
                  onCreateOpportunity({
                    pipelineId: visiblePipelines[0]?.id,
                    leadScore: insight.leadScore,
                    intentCategory: insight.intentCategory,
                    estimatedValueIdr: insight.estimatedValueIdr,
                    productInterest: insight.productInterest,
                    aiNotes: insight.aiNotes,
                    waitingStatus: insight.waitingStatus ?? null,
                  })
                }
                className="h-8 w-full gap-1.5 text-xs border-[hsl(var(--wa-divider))]"
              >
                {creating ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5" />
                )}
                {opportunities.length === 0 && pendingCandidates.length === 0
                  ? "Buat Opportunity"
                  : "Tambah Opportunity Manual"}
              </Button>
            ) : (
              <ManualAddMenu
                pipelines={visiblePipelines}
                creating={creating}
                showLabel={opportunities.length === 0 && pendingCandidates.length === 0}
                onSelect={(pipelineId) =>
                  onCreateOpportunity({
                    pipelineId,
                    leadScore: insight.leadScore,
                    intentCategory: insight.intentCategory,
                    estimatedValueIdr: insight.estimatedValueIdr,
                    productInterest: insight.productInterest,
                    aiNotes: insight.aiNotes,
                    waitingStatus: insight.waitingStatus ?? null,
                  })
                }
              />
            )}
          </div>
        ) : null}
      </div>

      <p className="pt-1 text-[10px] text-[hsl(var(--wa-meta))]">
        Dianalisa {new Date(insight.analyzedAt).toLocaleString("id-ID")}
      </p>
    </div>
  );
}

export function ChatInfoSidebar({
  chatId,
  chat,
  canAssign,
  agents,
  onClose,
  onUpdate,
  onTakeover,
  onAssign,
}: Props) {
  const qc = useQueryClient();
  const [maximized, setMaximized] = useState(false);
  const isGroup = chat.phoneNumber.endsWith("@g.us");
  const [tab, setTab] = useState<
    "info" | "grup" | "media" | "shortcut" | "products" | "order" | "insight"
  >("info");

  // AI Sales Assistant (Enterprise-only). The tab shows only when the tenant
  // has the entitlement AND the caller can view opportunities. Editing the
  // tenant-level Auto-Create settings additionally needs the "edit" permission.
  const { data: me } = useGetMe({ query: { queryKey: ["/api/auth/me"] } });
  const { menus } = usePermissions();
  const showInsightTab =
    me?.user?.hasAiSalesAssistant === true &&
    menus.opportunities.canView &&
    !isGroup;
  const canEditInsightSettings = menus.opportunities.canEdit;
  const canCreateOpportunity = menus.opportunities.canCreate;

  // Local, debounced-on-blur editing for free-text fields so each keystroke
  // doesn't fire a PATCH. Re-sync whenever the chat row changes underneath.
  const [name, setName] = useState(chat.nickname ?? "");
  const [company, setCompany] = useState(chat.company ?? "");
  const [customerCode, setCustomerCode] = useState(chat.customerCode ?? "");
  useEffect(() => {
    setName(chat.nickname ?? "");
  }, [chat.id, chat.nickname]);
  useEffect(() => {
    setCompany(chat.company ?? "");
  }, [chat.id, chat.company]);
  useEffect(() => {
    setCustomerCode(chat.customerCode ?? "");
  }, [chat.id, chat.customerCode]);

  const { data: allLabels } = useListCustomerLabels({
    query: { queryKey: ["/api/customer-labels"] },
  });
  const setLabels = useSetChatLabels({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetChatQueryKey(chatId) });
        qc.invalidateQueries({ queryKey: getListChatsQueryKey() });
      },
    },
  });

  const selectedIds = new Set(chat.labels.map((l) => l.id));

  function toggleLabel(id: number) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setLabels.mutate({ id: chatId, data: { labelIds: Array.from(next) } });
  }

  function commitName() {
    const trimmed = name.trim();
    const normalized = trimmed.length === 0 ? null : trimmed;
    if (normalized !== (chat.nickname ?? null)) {
      onUpdate({ nickname: normalized });
    }
  }

  function commitCompany() {
    const trimmed = company.trim();
    const normalized = trimmed.length === 0 ? null : trimmed;
    if (normalized !== (chat.company ?? null)) {
      onUpdate({ company: normalized });
    }
  }

  function commitCustomerCode() {
    const trimmed = customerCode.trim();
    const normalized = trimmed.length === 0 ? null : trimmed;
    if (normalized !== (chat.customerCode ?? null)) {
      onUpdate({ customerCode: normalized });
    }
  }

  return (
    <aside
      className={cn(
        "flex-shrink-0 border-l border-[hsl(var(--wa-divider))] bg-[hsl(var(--wa-panel-header))] flex flex-col transition-[width] duration-200",
        maximized ? "w-[420px]" : "w-72"
      )}
      data-testid="chat-info-panel"
    >
      <div className="h-[60px] flex items-center justify-between px-3 border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
        <p className="text-sm font-medium">Info Chat</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            data-testid="button-toggle-maximize-info-panel"
            onClick={() => setMaximized((m) => !m)}
            className="p-1.5 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5 transition-colors"
            title={maximized ? "Perkecil panel" : "Perbesar panel"}
          >
            {maximized ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
          <button
            type="button"
            data-testid="button-close-info-panel"
            onClick={onClose}
            className="p-1.5 rounded-full text-[hsl(var(--wa-meta))] hover:text-foreground hover:bg-white/5 transition-colors"
            title="Sembunyikan panel"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[hsl(var(--wa-divider))] flex-shrink-0">
        {([
          { key: "info", label: "Info", icon: TagIcon },
          ...(isGroup
            ? [{ key: "grup", label: "Grup", icon: Users } as const]
            : []),
          { key: "media", label: "Media", icon: ImageIcon },
          { key: "shortcut", label: "Shortcut", icon: Zap },
          { key: "products", label: "Produk", icon: Package },
          { key: "order", label: "Order", icon: Receipt },
          ...(showInsightTab
            ? [{ key: "insight", label: "AI Sales", icon: Sparkles } as const]
            : []),
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            data-testid={`tab-info-${t.key}`}
            onClick={() => setTab(t.key)}
            className={cn(
              "flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium border-b-2 transition-colors",
              tab === t.key
                ? "border-[hsl(var(--wa-accent))] text-foreground"
                : "border-transparent text-[hsl(var(--wa-meta))] hover:text-foreground"
            )}
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col">
        {tab === "info" ? (
          <div className="p-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Kode Customer
              </Label>
              <Input
                data-testid="input-chat-customer-code"
                value={customerCode}
                onChange={(e) => setCustomerCode(e.target.value)}
                onBlur={commitCustomerCode}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="Kode customer…"
                className="h-9 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Nama
              </Label>
              <Input
                data-testid="input-chat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder={chat.contactName || chat.phoneNumber}
                className="h-9 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Perusahaan
              </Label>
              <Input
                data-testid="input-chat-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onBlur={commitCompany}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                placeholder="Nama perusahaan…"
                className="h-9 text-xs bg-transparent border-[hsl(var(--wa-divider))]"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Label Customer
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {chat.labels.map((l) => (
                  <span
                    key={l.id}
                    data-testid={`chip-label-${l.id}`}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{ backgroundColor: l.color, color: readableText(l.color) }}
                  >
                    {l.name}
                  </span>
                ))}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      data-testid="button-add-label"
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-[hsl(var(--wa-divider))] px-2 py-0.5 text-[11px] text-[hsl(var(--wa-meta))] hover:text-foreground hover:border-[hsl(var(--wa-meta))] transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      Label
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-56 p-1">
                    {!allLabels || allLabels.length === 0 ? (
                      <p className="px-2 py-3 text-xs text-center text-[hsl(var(--wa-meta))]">
                        Belum ada label. Buat di Pengaturan.
                      </p>
                    ) : (
                      <div className="max-h-64 overflow-y-auto">
                        {allLabels.map((l) => {
                          const active = selectedIds.has(l.id);
                          return (
                            <button
                              key={l.id}
                              type="button"
                              data-testid={`option-label-${l.id}`}
                              onClick={() => toggleLabel(l.id)}
                              disabled={setLabels.isPending}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                            >
                              <span
                                className="h-3 w-3 rounded-full flex-shrink-0"
                                style={{ backgroundColor: l.color }}
                              />
                              <span className="flex-1 text-left truncate">
                                {l.name}
                              </span>
                              {active && <Check className="w-3.5 h-3.5" />}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Tag
              </Label>
              <Select
                value={chat.tag}
                onValueChange={(val) => onUpdate({ tag: val })}
              >
                <SelectTrigger
                  data-testid="select-chat-tag"
                  className="h-9 w-full text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No tag</SelectItem>
                  <SelectItem value="hot_lead">Hot Lead</SelectItem>
                  <SelectItem value="cold">Cold</SelectItem>
                  <SelectItem value="closing">Closing</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Status
              </Label>
              <Select
                value={chat.status}
                onValueChange={(val) => onUpdate({ status: val })}
              >
                <SelectTrigger
                  data-testid="select-chat-status"
                  className="h-9 w-full text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ai_handled">AI Handled</SelectItem>
                  <SelectItem value="needs_human">Needs Human</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                Mode Balas
              </Label>
              <div className="flex items-center justify-between gap-2 px-3 h-9 rounded-md border border-[hsl(var(--wa-divider))]">
                <Label
                  htmlFor="takeover"
                  className="text-xs text-foreground cursor-pointer"
                >
                  Manual
                </Label>
                <Switch
                  data-testid="switch-human-takeover"
                  id="takeover"
                  checked={chat.isHumanTakeover}
                  onCheckedChange={(checked) => onTakeover(checked)}
                />
              </div>
              <p className="text-[10px] text-[hsl(var(--wa-meta))]">
                Aktifkan untuk menonaktifkan balasan AI di chat ini.
              </p>
            </div>

            {canAssign && (
              <div className="space-y-1.5">
                <Label className="text-[11px] text-[hsl(var(--wa-meta))] uppercase tracking-wide">
                  Ditugaskan ke
                </Label>
                <Select
                  value={
                    chat.assignedUserId == null
                      ? "__unassigned"
                      : String(chat.assignedUserId)
                  }
                  onValueChange={(v) =>
                    onAssign(v === "__unassigned" ? null : Number(v))
                  }
                >
                  <SelectTrigger
                    data-testid="select-chat-assign"
                    className="h-9 w-full text-xs bg-transparent border-[hsl(var(--wa-divider))]"
                  >
                    <SelectValue placeholder="Assign…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__unassigned">Belum di-assign</SelectItem>
                    {agents
                      .filter((a) => a.status === "active")
                      .map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.name ?? a.email}
                          {a.teamRole === "supervisor" ? " (Supv)" : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {!isGroup && (
              <>
                <Separator className="bg-[hsl(var(--wa-divider))]" />
                <CommonGroupsSection chatId={chatId} />
              </>
            )}
          </div>
        ) : tab === "grup" ? (
          <GroupTab chatId={chatId} contactName={chat.contactName} />
        ) : tab === "media" ? (
          <MediaTab chatId={chatId} />
        ) : tab === "shortcut" ? (
          <ShortcutTab chatId={chatId} channelId={chat.channelId} />
        ) : tab === "products" ? (
          <ProductsTab chatId={chatId} />
        ) : tab === "insight" ? (
          <SalesInsightTab
            chatId={chatId}
            canEditSettings={canEditInsightSettings}
            canCreateOpportunity={canCreateOpportunity}
          />
        ) : (
          <OrderTab chatId={chatId} />
        )}
      </div>
    </aside>
  );
}
