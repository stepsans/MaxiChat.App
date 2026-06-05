import { productsTable } from "@workspace/db";

function formatIdr(n: number | null | undefined): string {
  if (n === null || n === undefined) return "-";
  return "Rp " + n.toLocaleString("id-ID");
}

// Build a customer-safe product catalog text, grouped by category, for feeding
// the AI auto-reply. Only the public pricelist price is included; internal tier
// prices (silver/gold/platinum/reseller/distributor) and stock are intentionally
// excluded — they must never reach customers.
export function buildProductCatalogText(
  rows: (typeof productsTable.$inferSelect)[],
): string {
  if (rows.length === 0) return "";
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const cat = (r.category ?? "").trim() || "Tanpa Kategori";
    const list = groups.get(cat);
    if (list) list.push(r);
    else groups.set(cat, [r]);
  }
  const sortedCats = Array.from(groups.keys()).sort((a, b) =>
    a.localeCompare(b, "id-ID", { sensitivity: "base" }),
  );
  const lines: string[] = [];
  lines.push(
    `Daftar produk toko (total ${rows.length} item, ${sortedCats.length} kategori). Gunakan data ini saat menjawab pertanyaan customer tentang nama produk, kategori, kode, atau harga pricelist.`,
  );
  for (const cat of sortedCats) {
    const items = groups
      .get(cat)!
      .slice()
      .sort((a, b) =>
        a.name.localeCompare(b.name, "id-ID", { sensitivity: "base" }),
      );
    lines.push("");
    lines.push(`== Kategori: ${cat} (${items.length} produk) ==`);
    for (const p of items) {
      lines.push(
        `- ${p.name} | kode: ${p.code} | harga: ${formatIdr(p.price)}`,
      );
    }
  }
  return lines.join("\n");
}
