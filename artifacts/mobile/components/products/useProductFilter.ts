import { useMemo, useState } from "react";

import type { Product } from "@workspace/api-client-react";

export type ProductSortKey = "price" | "code" | "name" | "stock";

/** Sentinel category value for products with no `category`. */
export const NO_CATEGORY = "__none__";

/** Effective stock used for the "jumlah > 1" filter and the Stok sort. */
export function productStock(p: Product): number {
  return p.stockOnHand ?? p.stock ?? 0;
}

/**
 * Shared product filter/sort state, used by both the standalone Produk tab and
 * the in-chat Produk sidebar so their behaviour stays identical.
 *
 * Filters: category combo (all / distinct / "Tanpa kategori"), free-text search
 * over name+code, and an optional "jumlah > 1" stock gate. Sorts by Harga /
 * Kode / Nama / Stok, ascending or descending.
 */
export function useProductFilter(products: Product[] | undefined) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [qtyOverOne, setQtyOverOne] = useState(false);
  const [sortKey, setSortKey] = useState<ProductSortKey>("price");
  const [asc, setAsc] = useState(true);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products ?? []) if (p.category) set.add(p.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b, "id-ID"));
  }, [products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (products ?? []).filter((p) => {
      if (category === NO_CATEGORY) {
        if (p.category) return false;
      } else if (category != null) {
        if (p.category !== category) return false;
      }
      if (qtyOverOne) {
        if ((p.stock ?? 0) <= 1 && (p.stockOnHand ?? 0) <= 1) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)
      );
    });

    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "price":
          cmp = (a.price ?? 0) - (b.price ?? 0);
          break;
        case "stock":
          cmp = productStock(a) - productStock(b);
          break;
        case "code":
          cmp = a.code.localeCompare(b.code, "id-ID");
          break;
        case "name":
          cmp = a.name.localeCompare(b.name, "id-ID");
          break;
      }
      return asc ? cmp : -cmp;
    });
    return sorted;
  }, [products, query, category, qtyOverOne, sortKey, asc]);

  return {
    query,
    setQuery,
    category,
    setCategory,
    qtyOverOne,
    setQtyOverOne,
    sortKey,
    setSortKey,
    asc,
    setAsc,
    categories,
    filtered,
  };
}

export type ProductFilterState = ReturnType<typeof useProductFilter>;
