export type KnowledgeType = { id: number; value: string; label: string };
export type KnowledgeEntry = {
  id: number;
  type: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export const TYPES: KnowledgeType[] = [
  { id: 1, value: "product", label: "Product" },
  { id: 2, value: "faq", label: "FAQ" },
  { id: 3, value: "script", label: "Sales Script" },
  { id: 4, value: "testimonial", label: "Testimonial" },
  { id: 5, value: "website", label: "Website" },
  { id: 6, value: "promo", label: "Promo" },
];

export const ENTRIES: KnowledgeEntry[] = [
  {
    id: 1,
    type: "product",
    title: "Maxipro Hair Serum 30ml",
    content:
      "Serum rambut premium dengan kandungan biotin, argan oil, dan vitamin E. Membantu mengatasi rambut rontok, mempercepat pertumbuhan rambut baru, serta memberikan kilau alami. Harga retail Rp 189.000, harga reseller Rp 129.000 (min 3 botol).",
    createdAt: "2026-05-01",
    updatedAt: "2026-05-15",
  },
  {
    id: 2,
    type: "faq",
    title: "Berapa lama pengiriman sampai?",
    content:
      "Pengiriman dari Jakarta menggunakan JNE/J&T regular sampai dalam 2-4 hari kerja. Untuk wilayah Jabodetabek bisa same day delivery dengan biaya tambahan. Order sebelum jam 14:00 WIB akan dikirim hari yang sama.",
    createdAt: "2026-04-22",
    updatedAt: "2026-05-12",
  },
  {
    id: 3,
    type: "script",
    title: "Opening untuk customer baru",
    content:
      "Halo kak! Terima kasih sudah menghubungi Maxipro 🌿 Saya {agent_name}, ada yang bisa saya bantu? Kami spesialis perawatan rambut premium dengan ribuan testimoni nyata. Boleh tahu masalah rambut yang sedang kakak alami?",
    createdAt: "2026-04-10",
    updatedAt: "2026-05-02",
  },
  {
    id: 4,
    type: "testimonial",
    title: "Mba Sari — Bekasi",
    content:
      "\"Pakai serum Maxipro baru 3 minggu rambut yang tipis di pelipis udah mulai tumbuh halus-halus. Awalnya ragu, tapi sekarang aku reorder yang ke-4!\" — testimoni asli via WhatsApp 12 April 2026.",
    createdAt: "2026-04-12",
    updatedAt: "2026-04-12",
  },
  {
    id: 5,
    type: "promo",
    title: "Promo Bundle Mei 2026",
    content:
      "Beli 2 botol serum Maxipro GRATIS 1 sisir scalp massager + free ongkir seluruh Indonesia. Berlaku 1-31 Mei 2026. Kode promo: MAXIMEI. Maksimal 1 bundle per customer.",
    createdAt: "2026-05-01",
    updatedAt: "2026-05-01",
  },
  {
    id: 6,
    type: "faq",
    title: "Apakah aman untuk ibu hamil?",
    content:
      "Serum Maxipro berbahan alami (biotin, argan, vitamin E) tanpa pewangi keras. Aman untuk pemakaian luar, namun untuk ibu hamil/menyusui kami sarankan konsultasi dulu dengan dokter sebelum penggunaan rutin.",
    createdAt: "2026-03-28",
    updatedAt: "2026-05-08",
  },
  {
    id: 7,
    type: "product",
    title: "Maxipro Shampoo Anti-Hairfall 250ml",
    content:
      "Sampo lembut sulfate-free dengan ekstrak ginseng & saw palmetto. Cocok untuk rambut rontok parah, kulit kepala sensitif. Pemakaian 2-3x/minggu. Harga Rp 145.000.",
    createdAt: "2026-02-14",
    updatedAt: "2026-05-10",
  },
  {
    id: 8,
    type: "script",
    title: "Closing — handle objection harga",
    content:
      "Saya paham kak, harga 189rb memang terasa premium. Tapi 1 botol Maxipro cukup untuk 45 hari pemakaian — jadi per harinya cuma 4ribuan, lebih murah dari kopi 😊. Plus ada garansi uang kembali kalau tidak ada hasil dalam 30 hari. Mau saya bantu order yang bundle hemat?",
    createdAt: "2026-03-05",
    updatedAt: "2026-04-28",
  },
  {
    id: 9,
    type: "website",
    title: "Link katalog & order form",
    content:
      "Katalog lengkap: maxipro.id/katalog\nOrder form: maxipro.id/order\nInstagram: @maxipro.official\nTikTok: @maxipro.id",
    createdAt: "2026-01-20",
    updatedAt: "2026-05-15",
  },
  {
    id: 10,
    type: "testimonial",
    title: "Pak Budi — Surabaya",
    content:
      "\"Saya skeptis di awal karena udah coba banyak produk. Tapi Maxipro beda — kulit kepala terasa segar dan rambut yang biasanya jatuh banyak waktu keramas, sekarang minimal banget. Recommended!\"",
    createdAt: "2026-04-25",
    updatedAt: "2026-04-25",
  },
  {
    id: 11,
    type: "product",
    title: "Scalp Massager Silicone",
    content:
      "Sisir pemijat kulit kepala dari silikon food-grade. Membantu sirkulasi darah & penyerapan serum. Free pada bundle promo Mei 2026. Harga retail Rp 35.000.",
    createdAt: "2026-02-01",
    updatedAt: "2026-05-01",
  },
  {
    id: 12,
    type: "faq",
    title: "Bagaimana cara pemakaian serum?",
    content:
      "Bagi rambut menjadi 4 bagian, teteskan 4-6 tetes serum langsung ke kulit kepala. Pijat lembut 1-2 menit dengan scalp massager. Diamkan, tidak perlu dibilas. Pakai malam hari sebelum tidur untuk hasil optimal.",
    createdAt: "2026-03-15",
    updatedAt: "2026-05-09",
  },
];

export const TYPE_COLOR_PALETTE = [
  "bg-blue-500/10 text-blue-400 border-blue-500/20",
  "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  "bg-violet-500/10 text-violet-400 border-violet-500/20",
  "bg-orange-500/10 text-orange-400 border-orange-500/20",
  "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "bg-pink-500/10 text-pink-400 border-pink-500/20",
  "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
  "bg-teal-500/10 text-teal-400 border-teal-500/20",
];

export function colorForType(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return TYPE_COLOR_PALETTE[h % TYPE_COLOR_PALETTE.length];
}

export function labelForType(value: string): string {
  return TYPES.find((t) => t.value === value)?.label ?? value;
}
