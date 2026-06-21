// Industry starter templates for the AI Pipeline custom prompt. Shared by the
// create wizard (AIPipelineNew) and the edit screen (AIPipelineDetail) so the
// list stays in one place. Each value is kept under the 1500-char textarea cap.
// Clicking a template fills the custom-prompt textarea; the tenant then edits
// the bracketed placeholders to their own business.

export interface PromptTemplate {
  label: string;
  value: string;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    label: "Konsultasi & Training",
    value: `KONTEKS BISNIS: Kami menyediakan jasa pelatihan SDM, konsultasi manajemen, dan coaching bisnis untuk UKM hingga korporasi.

LEAD bila kontak: menanyakan program training/workshop untuk karyawannya, membahas kebutuhan pengembangan SDM, tanya kurikulum/jadwal/biaya, atau minta proposal.

BUKAN LEAD bila: mencari kerja / kirim CV (job seeker), trainer lain yang menawarkan programnya, vendor yang menawarkan jasa ke kami, atau mahasiswa minta wawancara skripsi.

SINYAL KUAT (skor tinggi): sebut jumlah peserta ("untuk 50 karyawan"), ada timeline jelas, tanya budget/harga paket korporat, minta proposal resmi.

ESTIMASI NILAI: private coaching Rp2jt–10jt/sesi; workshop <20 peserta Rp5jt–25jt/hari; training korporat >20 peserta Rp25jt–200jt/program.`,
  },
  {
    label: "Distributor / Grosir",
    value: `KONTEKS BISNIS: Kami distributor grosir kebutuhan sehari-hari untuk toko retail, warung, minimarket, dan reseller.

LEAD bila kontak: pemilik toko/warung/reseller yang tanya harga grosir/per karton, membahas stok rutin, atau tanya syarat jadi agen/reseller.

BUKAN LEAD bila: end-user beli satuan ("2 kg", "1 botol"), supplier yang menawarkan produk ke kami, atau kompetitor survei harga.

CARA BEDAKAN: "100 karton/1 ton/per palet" atau "harga reseller/syarat agen" → lead kuat. "2 kg/1 botol" → end-user, bukan lead.

SINYAL KUAT: volume besar, order rutin, tanya jadwal kirim/coverage, minta price list lengkap, tanya tempo pembayaran.

ESTIMASI NILAI: reseller perdana Rp500rb–5jt; order reguler Rp5jt–50jt; distributor besar Rp50jt ke atas.`,
  },
  {
    label: "Properti & Agen",
    value: `KONTEKS BISNIS: Kami agen properti (jual, beli, sewa rumah/apartemen/ruko/kavling) di [wilayah Anda].

LEAD bila kontak: cari properti untuk beli/sewa, ingin jual/sewakan propertinya lewat kami, tanya harga/lokasi/spesifikasi, atau ingin survei.

BUKAN LEAD bila: agen lain menawarkan kerjasama listing, developer menawarkan proyek, tukang/supplier material menawarkan jasa, atau tanya umum tanpa niat beli/sewa.

SINYAL KUAT: sebut budget spesifik, kebutuhan jelas (jumlah kamar/lokasi/tipe), tanya KPR/DP/cicilan, ingin survei, ada deadline ("butuh pindah bulan depan").

CATATAN: "mau jual rumah" = lead (komisi). "cari kontrakan 2jt/bln" = lead (penyewa).

ESTIMASI KOMISI: jual-beli 1–2,5% nilai transaksi; sewa 1 bulan harga sewa.`,
  },
  {
    label: "Klinik & Kesehatan",
    value: `KONTEKS BISNIS: Kami klinik [kecantikan/gigi/umum] yang melayani [layanan utama Anda].

LEAD bila kontak: tanya layanan/treatment kami, ingin buat janji/konsultasi/reservasi, tanya harga paket/biaya dokter, atau menyebut keluhan yang relevan.

BUKAN LEAD bila: sales alat kesehatan/kosmetik menawarkan produk ke klinik, pencari kerja (dokter/perawat), atau hanya tanya lokasi tanpa minat treatment.

SINYAL KUAT: tanya jadwal/slot dokter, sebut keluhan spesifik yang butuh penanganan, tanya harga prosedur detail, ingin reservasi langsung.

SENSITIF: percakapan pasien bersifat pribadi — jangan asumsikan niat beli dari pertanyaan medis murni; utamakan empati di rekomendasi.

ESTIMASI NILAI: konsultasi Rp100rb–300rb; treatment Rp500rb–5jt; paket Rp1jt–20jt.`,
  },
  {
    label: "Toko Online / Retail",
    value: `KONTEKS BISNIS: Kami toko online menjual [kategori produk Anda] via WhatsApp/marketplace, untuk konsumen dan reseller.

LEAD (dua tipe): (1) pembeli retail untuk dipakai sendiri; (2) reseller yang mau kulakan/dropship. Keduanya lead, skor & rekomendasi beda.

BUKAN LEAD bila: supplier menawarkan produk ke kami, jasa endorse/iklan menawarkan jasanya, atau komplain transaksi yang sudah selesai.

SINYAL KUAT RETAIL: tanya stok/warna/ukuran, tanya ongkir, minta rekening, sudah pilih produk.
SINYAL KUAT RESELLER: tanya "harga reseller/grosir/bisa dropship", minta katalog reseller, sudah punya toko.

ESTIMASI NILAI: retail satuan Rp50rb–500rb; retail multi-item Rp200rb–2jt; reseller Rp500rb–10jt/order.`,
  },
  {
    label: "Kontraktor & Renovasi",
    value: `KONTEKS BISNIS: Kami kontraktor renovasi, pembangunan, interior, dan pekerjaan sipil di [wilayah Anda].

LEAD bila kontak: ingin renovasi/bangun/percantik propertinya, tanya estimasi biaya/RAB/harga per meter, membahas proyek yang butuh kontraktor, atau ingin survei/konsultasi desain.

BUKAN LEAD bila: supplier material menawarkan produk ke kami, tukang cari kerja, atau komplain kerusakan kecil tanpa niat renovasi. (Arsitek/desainer = potensi partner, bukan lead jual.)

SINYAL KUAT: sebut lokasi & luas, tanya timeline pengerjaan, ingin survei segera, sebut budget, ada deadline, tanya garansi.

ESTIMASI NILAI: renovasi ringan Rp5jt–50jt; sedang Rp30jt–200jt; bangun/renovasi total Rp150jt ke atas.`,
  },
  {
    label: "Travel & Wisata",
    value: `KONTEKS BISNIS: Kami agen travel: paket wisata domestik/internasional, umrah, haji plus, tiket, hotel, visa.

LEAD bila kontak: tanya paket ke destinasi/tanggal tertentu, ingin umrah/haji dan tanya paket/jadwal/biaya, tanya tiket/hotel/visa, atau membahas rencana perjalanan grup/keluarga.

BUKAN LEAD bila: supplier hotel/maskapai menawarkan kerjasama, peserta tour yang sudah terdaftar hanya tanya info, atau tanya destinasi umum tanpa niat beli.

SINYAL KUAT: sebut destinasi & tanggal spesifik, jumlah orang ("kami berlima"), tanya DP/cicilan, sebut budget, minta itinerary/penawaran resmi. Umrah/haji = prioritas tinggi.

ESTIMASI NILAI: domestik Rp500rb–5jt/org; internasional Rp5jt–30jt/org; umrah Rp25jt–45jt/org; haji plus Rp150jt–250jt/org (kali jumlah peserta).`,
  },
  {
    label: "Software & IT Services",
    value: `KONTEKS BISNIS: Kami menyediakan jasa pengembangan software custom, aplikasi mobile, website, dan solusi IT untuk bisnis (B2B).

LEAD bila kontak: perusahaan/pemilik bisnis yang ingin buat/kembangkan aplikasi/website/sistem, membahas masalah operasional yang bisa diselesaikan teknologi, tanya biaya/timeline, atau ingin konsultasi/demo.

BUKAN LEAD bila: developer/freelancer cari kerja atau menawarkan diri, vendor software lain menawarkan produk/reseller, atau mahasiswa untuk tugas/riset.

SINYAL KUAT: sebut sistem/fitur spesifik yang dibutuhkan, ada deadline ("sebelum launching"), sudah ada budget, ingin meeting/demo/proposal, sebut skala pengguna.

ESTIMASI NILAI: website Rp3jt–20jt; aplikasi mobile Rp20jt–100jt; sistem/ERP custom Rp50jt–500jt; enterprise Rp200jt ke atas.`,
  },
];
