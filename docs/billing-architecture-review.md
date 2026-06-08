# MaxiChat — Enterprise Billing & Subscription Architecture Review

> **Mode dokumen ini: ANALISIS & DESAIN SAJA.** Tidak ada kode, tidak ada migration, tidak ada perubahan database/logic. Tujuannya: mendesain sistem billing yang sanggup dipakai 5–10 tahun tanpa redesign besar — fokus pada *profitability, scalability, auditability, tax compliance, revenue recognition, customer experience.*
>
> Disusun dengan membaca arsitektur MaxiChat yang **sebenarnya** (skema DB, katalog, engine billing, FASE A–B yang sudah jalan), bukan asumsi generik.

---

## 0. Potret Sistem Saat Ini (baseline faktual)

Sebelum rekomendasi, ini kondisi nyata yang menjadi titik berangkat:

| Area | Status sekarang | Implikasi |
|---|---|---|
| **Katalog plan** | `plans` = baris DB admin-configurable (`key`, `priceIdr`, `durationDays`, `quotaUsers/Channels/Tokens`, `quotaStorageBytes`, `retentionLimitDays`, `isActive`). **Bukan** hardcode Basic/Growth/Business/Enterprise. | Model bisnis bisa diubah tanpa deploy. Fondasi bagus. |
| **Add-on / top-up** | `addons` tipe `token`/`channel`/`user_seat`/`storage` (`unitAmount`, `priceIdr`). | Hybrid (prepaid + top-up) sudah ada. |
| **Plafon tenant** | `tenant_quota` (limit = plan base + add-on) — `tokenLimit/channelLimit/userLimit/storageLimit` + periode. Usage dihitung **live** (bukan disimpan ganda). | Single source of truth untuk *limit*; bagus. |
| **Langganan** | `subscriptions` status `trial/active/expired/suspended` + `currentPeriodEnd`. Periksaan akses (`enforceSubscription`) **sebagian** (mengecualikan `/billing`). | Enforcement belum tuntas. |
| **Invoice** | FASE A: `invoices` + `invoice_line_items` **immutable**, harga di-*snapshot*, `source = payment | monthly_close`, `tax_idr` ada tapi **selalu 0**. | Fondasi revenue/MRR siap; pajak belum. |
| **Tutup bulanan** | FASE B: scheduler menerbitkan invoice `monthly_close` status **`open`** per tenant aktif, idempotent. | **Belum ada jalur penagihan** untuk invoice `open` ini (celah). |
| **Pembayaran** | `payments` model keranjang (`line_items` jsonb), provider `xendit` (otomatis) / `manual` (verifikasi via Sheet/poller), `externalId` idempoten. | Gateway ganda solid. |
| **Periode billing** | **Anchor pada tanggal bergabung** (anniversary), bukan tanggal 1. | Penting untuk BAGIAN 7. |
| **Retensi** | `retention_settings` per kelas data (`chatDays/mediaDays/logDays/analyticsDays`), di-*clamp* oleh `plans.retentionLimitDays`. | Skema retensi sudah ada (purger perlu dipastikan aktif). |
| **Storage** | `mediaStorageBytes` = SUM(`media_objects.size_bytes`) per owner (real-time, owner-keyed). | Pengukuran storage sudah benar. |
| **Model metered lama** | `pricing.ts` singleton (`dbPricePer500Mb`, `userPricePerUser`, `channelPricePer2`, `aiPricePer100Tokens`, semua default Rp50.000) + "Rincian Tagihan" estimasi + `usage_snapshots`. | ⚠️ **Berdampingan** dengan model prepaid → dualisme (lihat Temuan #1). |
| **Mata uang** | Rupiah bulat (tanpa sen), integer. | Konsisten; pertahankan. |

### Temuan struktural paling kritis (sebelum masuk ke 15 bagian)

1. **Dualisme model billing.** Ada DUA filosofi yang hidup bersamaan:
   - **Prepaid committed** (uang nyata): plan + add-on → `payments` → entitlement di `tenant_quota`.
   - **Metered/estimasi** (tidak menagih uang): `pricing.ts` + "Rincian Tagihan" + tren pengeluaran.
   Ini membingungkan pelanggan ("kenapa ada estimasi tapi saya bayar paket?") dan berisiko untuk akuntansi. **Keputusan arsitektur #1 yang harus diambil**: pilih satu model utama. Rekomendasi: **prepaid committed sebagai tulang punggung**, metered hanya untuk *overage* yang eksplisit (lihat BAGIAN 1 & 2).
2. **Invoice `monthly_close` terbit tapi tak tertagih.** FASE B membuat invoice `open`, tapi tidak ada dunning/pembayaran yang menautkannya. Tanpa FASE F, pendapatan berulang tidak benar-benar masuk.
3. **Pajak nol.** `tax_idr` selalu 0; tidak ada faktur pajak. Untuk pasar Indonesia B2B ini penghambat (BAGIAN 8).
4. **Belum ada deferred revenue.** Pembayaran tahunan akan diakui saat kas masuk — salah secara SaaS accounting (BAGIAN 9).
5. **Belum ada credit/wallet.** Proration-credit & refund tidak punya "tempat mendarat" (BAGIAN 11).

---

# 1. Executive Summary

MaxiChat sudah memiliki **fondasi billing kelas menengah-atas yang langka** untuk produk seusianya: katalog dinamis, hybrid prepaid+add-on, invoice immutable dengan snapshot harga, tutup bulanan idempoten, dua gateway pembayaran, periode anniversary, serta skema storage & retensi. Yang memisahkannya dari "enterprise-grade" bukan fondasi, melainkan **lima lubang**: (1) dualisme model metered vs prepaid, (2) penagihan invoice bulanan, (3) pajak/faktur, (4) revenue recognition (deferred revenue), (5) proration + credit/wallet.

Strategi yang direkomendasikan: **konsolidasi ke "Committed Prepaid + Metered Overage + Credit Wallet"** dengan **anniversary billing**, **PPN 11% inklusif/eksklusif yang dapat dikonfigurasi**, dan **revenue recognition harian (deferred)**. Semua dibangun *additive* di atas FASE A/B yang sudah ada — tidak ada redesign destruktif.

Prioritas eksekusi (ringkas): **F (dunning) → G (pajak) → revenue recognition (H+) → C (storage enforcement) → E (retensi otomatis) → D (proration) → credit/wallet → booster economics.**

---

# 2. Business Recommendation

## 2.1 Audit model plan (BAGIAN 1)

Tier Basic/Growth/Business/Enterprise dengan kuota Token/User/Channel/Storage adalah **kerangka yang tepat** dan cocok dengan tabel `plans` yang sudah dinamis.

**Kelebihan:** mudah dipahami, predictable revenue (prepaid), upsell jelas (naik tier / beli add-on), enforcement sederhana (limit di `tenant_quota`).

**Kekurangan / risiko:**
- **Token adalah biaya variabel (COGS) yang tidak terbatas.** Kuota token dalam plan flat → margin bisa negatif jika tenant memakai model AI mahal. **Wajib** ada batas keras + overage berbayar, bukan "fair usage" longgar.
- **Storage tumbuh monoton** (media WA menumpuk) → biaya naik diam-diam tanpa retensi.
- **User seat & channel** relatif aman (biaya marginal kecil), boleh longgar.

**Revenue leakage yang teridentifikasi:**
- Tenant melewati `currentPeriodEnd` tapi enforcement belum tuntas → memakai layanan gratis (status `expired` belum benar-benar memblok).
- Invoice `monthly_close` `open` tak tertagih.
- Tidak ada overage token nyata → konsumsi di atas kuota = COGS tak terbayar.
- Add-on storage habis periode tapi data tetap tersimpan (storage dipakai tanpa dibayar bila tidak ada enforcement+retensi).

**Skenario abuse:**
- Trial farming (buat akun trial berulang untuk token gratis) → butuh pembatasan trial per identitas/nomor.
- "Token burn" sebelum downgrade.
- Upload media masif mendekati akhir periode (kalau billing storage berbasis end-of-month, lihat BAGIAN 3).
- Share satu akun owner ke banyak bisnis (mitigasi: seat & channel berbayar — sudah ada).

**Rekomendasi:** pertahankan 4 tier, tetapi **definisikan setiap tier sebagai "committed base + overage policy"**, bukan kuota mati. Tambah **batas keras token** dengan overage opsional. Kunci pemenang harga adalah *token economics* (BAGIAN 2) — itulah pusat profit & risiko.

## 2.2 AI Token Economics (BAGIAN 2)

| Model | Profit | Simplicity | Pemahaman pelanggan | Scalability |
|---|---|---|---|---|
| A. Per token | Tinggi (presisi) | Rendah | Rendah ("token itu apa?") | Tinggi |
| B. Per **credit** | Tinggi | Sedang | **Tinggi** (1 kredit = 1 satuan jelas) | Tinggi |
| C. Per paket | Sedang | Tinggi | Tinggi | Sedang |
| D. Unlimited fair-usage | **Rendah/berisiko** | Tinggi | Tinggi | **Rendah** (COGS meledak) |
| E. Hybrid | Tinggi | Sedang | Sedang | Tinggi |

**Rekomendasi: Hybrid berbasis Credit (E+B).**
- Jual **"MaxiCredit"** sebagai abstraksi di atas token. Internal: 1 kredit = N token tertimbang per model (mis. model mahal mengonsumsi lebih banyak kredit per token). Ini menyembunyikan kompleksitas token dari pelanggan **dan** melindungi margin saat harga model AI berubah.
- Plan menyertakan **alokasi kredit bulanan**; habis → beli **booster** (add-on `token` yang sudah ada, ganti label jadi kredit) atau aktifkan **overage** otomatis (opt-in).
- **Jangan** pernah "unlimited" tanpa batas keras — itu jaminan kebangkrutan untuk SaaS AI.
- Lapisi **markup minimum** di atas biaya provider (BYOK menurunkan COGS; untuk default Replit-managed, jaga markup ≥ target margin).

**Mengapa credit:** memutus ketergantungan harga jual pada satuan teknis (token) yang fluktuatif, memudahkan bundling lintas layanan AI masa depan (BAGIAN business model #6/#7), dan mempermudah komunikasi ("Anda punya 10.000 kredit").

---

# 3. Billing Recommendation

## 3.1 Arsitektur target (konsolidasi)

**"Committed Prepaid + Metered Overage + Credit Wallet"**

```
Plan (committed, prepaid)  ──> entitlement (tenant_quota)
        │                         │
        │                         ├─ usage live (token/seat/channel/storage)
Add-on / Booster (prepaid) ──>    │
        │                         ▼
        │                  Overage detector (per periode)
        ▼                         │
   payments ──> settlePaymentPaid ──> invoices (immutable, FASE A)
                                         ▲
   monthly_close scheduler (FASE B) ─────┘  (recurring + overage line)
                                         │
                                  dunning (FASE F) ──> collection
```

Prinsip:
- **Satu chokepoint settlement** sudah ada (`settlePaymentPaid`) — pertahankan; semua jalur uang lewat sini.
- **Invoice = sumber kebenaran finansial tunggal** (sudah benar di FASE A). Matikan peran "estimasi metered" sebagai angka pendapatan; jadikan ia hanya *forecast UI* (lihat BAGIAN 13) atau dasar *overage line* yang masuk ke invoice nyata.
- **Overage** dihitung per akhir periode dan masuk sebagai *line item* (`usage`) di invoice `monthly_close`, bukan estimasi yang tak pernah ditagih.

## 3.2 Resolusi dualisme (Temuan #1)

Pilih **prepaid committed sebagai angka pendapatan resmi**. `pricing.ts` (per-500MB, per-user, dst.) **direpurpose** menjadi **tarif overage** yang hanya berlaku di atas plafon `tenant_quota`, dan hasilnya menjadi *line item* invoice — bukan "tagihan estimasi" yang berdiri sendiri. Dengan begitu "Rincian Tagihan" lama berubah makna: dari *estimasi yang membingungkan* menjadi *proyeksi overage yang benar-benar akan ditagih*.

---

# 4. Tax Recommendation (BAGIAN 8)

Asumsi: pelanggan Indonesia, ke depan ada B2B (butuh faktur pajak) & B2C, kemungkinan cross-border.

**Desain pajak yang siap berkembang:**

1. **Konfigurasi pajak sebagai data, bukan konstanta.** Tabel `tax_rates` (rate, jenis: `PPN`, berlaku-dari/sampai, inclusive/exclusive) + flag per-tenant `tax_exempt` & `tax_id` (NPWP). PPN saat ini 11% — **jangan hardcode**, karena tarif berubah (rencana 12%).
2. **Kapan pajak dihitung:** pada **saat invoice diterbitkan** (`issuedAt`), pakai tarif yang berlaku saat itu, lalu **snapshot** ke `invoices.tax_idr` (kolom sudah ada). Immutable — perubahan tarif tidak menulis ulang sejarah (konsisten dengan filosofi FASE A).
3. **Inclusive vs exclusive:** dukung keduanya via flag. B2C umumnya *tax-inclusive* (harga tampil sudah termasuk PPN); B2B sering *exclusive* + faktur pajak. Simpan `subtotal`, `tax`, `total` terpisah (skema sudah mendukung).
4. **Faktur Pajak (e-Faktur):** untuk B2B, simpan field yang dibutuhkan: NPWP pembeli, nama & alamat legal, nomor seri faktur, DPP (dasar pengenaan pajak), kode transaksi. Siapkan **nomor faktur terpisah** dari nomor invoice komersial.
5. **B2B vs B2C:** tandai tenant. B2B → wajib NPWP & faktur; B2C → cukup invoice + PPN inklusif.
6. **Cross-border:** untuk pelanggan luar negeri, PPN bisa 0% (ekspor jasa) ATAU mekanisme PMSE — **jangan terapkan sekarang**, cukup *desain extensible*: `tax_rates` per yurisdiksi + `customer.country`.

**Yang harus disimpan (audit):** untuk tiap invoice — tarif yang dipakai, DPP, nominal pajak, status pelanggan (kena/exempt), NPWP, dan tautan ke faktur pajak (jika ada). Semua immutable.

**Rekomendasi minimum viable (FASE G):** PPN 11% configurable, inclusive/exclusive flag, snapshot ke `tax_idr`, pemisahan net vs pajak di laporan pendapatan. Faktur e-Faktur penuh = fase lanjutan (B2B-ready).

---

# 5. Storage Recommendation (BAGIAN 3)

Storage akan menampung: riwayat chat, media WA (image/PDF/voice note/video), AI knowledge base, attachment masa depan.

**Cara menghitung — analisis metode:**

| Metode | Adil? | Mudah dipahami? | Risiko abuse | Cocok untuk |
|---|---|---|---|---|
| Real-time (current) | Sedang | Tinggi (lihat angka "sekarang") | Rendah | **Enforcement/limit** |
| Peak storage | Kurang adil (1 lonjakan = tagihan tinggi) | Rendah | Rendah | — |
| Average | Adil | Sedang (sulit dijelaskan) | Sedang | Billing usage |
| End-of-month | Adil-ish | Tinggi | **Tinggi** (hapus sebelum cut-off) | — (rawan) |

**Rekomendasi:**
- **Untuk enforcement (limit/blokir):** pakai **real-time** `mediaStorageBytes` vs `tenant_quota.storageLimit` — ini sudah ada dan benar.
- **Untuk billing overage storage:** pakai **rata-rata harian** (average dari `usage_snapshots` yang sudah ada) — paling adil dan **kebal abuse end-of-month**. Snapshot harian sudah tersedia; tinggal dirata-ratakan per periode menjadi *line item* overage.
- **Hindari** peak (tidak adil) dan end-of-month murni (mudah dimanipulasi).
- **Definisi storage:** jumlahkan media (`media_objects`) + footprint chat (`pg_column_size`) — keduanya sudah dihitung. Knowledge base & attachment masa depan masuk ke `media_objects` agar otomatis terhitung.

**Model komersial storage:** base kuota per plan (sudah ada `quotaStorageBytes`) + add-on storage (sudah ada) + overage average-daily berbayar. Storage murah per-GB tapi **tak terbatas tanpa retensi = bom waktu** → wajib dipadukan dengan BAGIAN 4/5.

---

# 6. Retention Recommendation (BAGIAN 4)

Skema sudah mendukung (`retention_settings` per kelas + cap `plans.retentionLimitDays`). Yang perlu diputuskan: **kebijakan default**.

**Analisis "boleh simpan selamanya?":**
- **Biaya storage & backup** naik linear → unlimited gratis = margin tergerus.
- **Risiko hukum / GDPR / UU PDP (Indonesia):** menyimpan data pribadi pelanggan-dari-pelanggan (chat customer) selamanya = liabilitas. **Data minimization** adalah prinsip kepatuhan.
- **Scalability:** index & query melambat seiring data menumpuk.

**Rekomendasi kebijakan default per tier:**

| Tier | Retensi chat | Retensi media | Catatan |
|---|---|---|---|
| Basic | 3 bulan | 1 bulan | murah, dorong upgrade |
| Growth | 6 bulan | 3 bulan | |
| Business | 12 bulan | 6 bulan | |
| Enterprise | 24 bulan / custom | 12 bulan / custom | "unlimited" hanya via kontrak + harga storage |

- **Unlimited** hanya untuk Enterprise berbayar (cap `retentionLimitDays = NULL`), karena biayanya nyata.
- Tenant boleh memilih **lebih pendek** dari cap (hemat = bisa jadi insentif), tidak pernah lebih panjang.
- **GDPR/UU PDP readiness:** sediakan "right to erasure" (hapus atas permintaan) — sebagian sudah ada lewat "Reset Database Tenant".

---

# 7. Revenue Recognition Recommendation (BAGIAN 9)

**Contoh:** pelanggan bayar tahunan Rp12.000.000.

**Best practice SaaS (ASC 606 / PSAK 72): diakui BULANAN (deferred), bukan sekaligus.**
- Saat kas masuk: catat **Deferred Revenue (liabilitas)** Rp12.000.000.
- Tiap bulan: akui **Rp1.000.000** sebagai *recognized revenue*, kurangi deferred.
- Untuk akrual harian yang lebih halus: Rp12.000.000 ÷ jumlah hari periode × hari berjalan.

**Mengapa penting:** MRR/ARR jadi benar (tidak melonjak palsu di bulan pembayaran), laporan keuangan kredibel untuk investor/audit, dan churn/expansion terukur akurat.

**Implikasi desain:**
- Tambah konsep **revenue schedule**: tiap invoice berbayar (atau line item) menurunkan jadwal pengakuan harian sepanjang `coversFrom..coversTo` (kolom `covers_from/covers_to` **sudah ada** di `invoice_line_items` — dirancang untuk ini).
- **Booster/overage (konsumsi)** umumnya diakui **saat dikonsumsi** (point-in-time), bukan disebar — bedakan dari langganan (over-time).
- FASE H ("revenue dari invoice") harus mengakui ini: pisahkan *billings* (uang ditagih) dari *recognized revenue* (diakui).

---

# 8. Proration Recommendation (BAGIAN 6)

Skenario: upgrade/downgrade plan, tambah/kurang user, channel, storage.

**Benchmark:**
- **Stripe:** proration otomatis berbasis detik, membuat invoice item kredit + charge.
- **Chargebee/Recurly:** proration berbasis hari, opsi "charge now" vs "next cycle".
- **Paddle:** cenderung menyederhanakan (sering tagih di siklus berikutnya).

**Rekomendasi MaxiChat: proration berbasis HARI, anniversary-aligned.**

Formula umum:
```
faktor = sisa_hari_periode / total_hari_periode
kredit_lama  = harga_komponen_lama  × faktor   (line: proration_credit)
biaya_baru   = harga_komponen_baru  × faktor   (line: proration_charge)
selisih ditagih sekarang ATAU dikreditkan ke wallet
```
Kolom pendukung **sudah ada**: `proration_factor`, `calculation_source`, `covers_from/to`, dan line type `proration_credit`/`proration_charge`. Skema FASE A memang dirancang untuk ini.

**Aturan per skenario:**
| Aksi | Perlakuan |
|---|---|
| Upgrade plan | Charge prorata selisih **sekarang** (akses naik seketika) |
| Downgrade plan | **Kredit prorata** ke wallet, berlaku **periode berikutnya** (hindari refund tunai) |
| Add user/channel | Charge prorata sisa periode |
| Remove user/channel | Kredit prorata ke wallet (bukan refund tunai) |
| Add storage | Charge prorata |
| Remove storage | Kredit prorata ke wallet |

**Prinsip emas:** **downgrade/remove → CREDIT (wallet), bukan refund kas.** Ini melindungi cash flow & menyederhanakan akuntansi. Karena itu **wallet (BAGIAN 11) adalah prasyarat proration yang benar.**

**Cut-off & cycle (BAGIAN 7):** MaxiChat sudah **anniversary billing** (anchor tanggal join). **Pertahankan** — lebih adil bagi pelanggan (bayar penuh periode mereka) dan menyebarkan beban operasional/penagihan sepanjang bulan (bukan lonjakan tanggal 1). Trade-off: revenue reporting per kalender butuh agregasi (terselesaikan oleh deferred revenue harian di BAGIAN 7). Fixed-date (tgl 1) hanya unggul untuk kesederhanaan akuntansi manual — tidak relevan karena kita pakai pengakuan harian.

---

# 9. Dashboard Recommendation (BAGIAN 13 & 14)

## 9.1 Dashboard Pelanggan (BAGIAN 13)
Tampilkan, per komponen, **pemakaian vs plafon + proyeksi**:
- **Token/Credit:** terpakai / sisa, **forecast** akhir periode (ekstrapolasi laju), estimasi overage Rp.
- **Storage:** terpakai / batas (real-time), tren, estimasi overage (average-daily).
- **User seat & Channel:** terpakai / batas.
- **Status langganan & tanggal perpanjangan** (anniversary).
- **Invoice:** riwayat (sudah dibangun di Task #22) + status `open` yang perlu dibayar (setelah FASE F).
- **Wallet balance** (setelah BAGIAN 11).
Prinsip UX: **"berapa sisa & kapan habis"**, plus peringatan dini di 80%/100%.

## 9.2 Dashboard Internal / FinOps (BAGIAN 14)
Metrik & cara hitung (semua dari **invoices**, sumber kebenaran):
- **MRR** = Σ pendapatan langganan **ter-normalisasi bulanan** (tahunan ÷ 12). Pakai *recognized*, bukan billings.
- **ARR** = MRR × 12.
- **ARPA** (per account) = MRR ÷ jumlah tenant berbayar. **ARPU** (per user) = MRR ÷ total user aktif.
- **Churn** = (MRR hilang dari cancel/expired) ÷ MRR awal periode. Pisahkan *logo churn* vs *revenue churn*.
- **Expansion revenue** = tambahan MRR dari upgrade/add-on tenant existing.
- **Contraction revenue** = penurunan MRR dari downgrade tenant existing.
- **Net Revenue Retention** = (MRR awal + expansion − contraction − churn) ÷ MRR awal.
- **LTV** = ARPA × gross margin % ÷ churn rate. **CAC Payback** = CAC ÷ (ARPA × gross margin) bulan.
- **Gross margin** wajib memperhitungkan **COGS token AI** (pusat biaya variabel).
FASE H adalah pintu masuk: begitu revenue dibaca dari invoice, semua metrik ini turunannya.

---

# 10. Risk Analysis (BAGIAN 15)

| Risiko | Penyebab di MaxiChat | Mitigasi |
|---|---|---|
| **Revenue leakage** | Enforcement `expired/suspended` belum tuntas; invoice `open` tak tertagih; overage token tak ditagih | Selesaikan enforcement; FASE F dunning; overage line di monthly_close |
| **Double billing** | Retry webhook/poller, monthly-close re-run | Sudah dimitigasi: `externalId` idempoten, `invoice_number` unik + `onConflictDoNothing`, settlement transaksional. **Pertahankan invariannya** |
| **Missing invoice** | Grant entitlement tanpa invoice | Sudah: invoice dibuat **di dalam** transaksi `settlePaymentPaid` (all-or-nothing) |
| **Incorrect proration** | Belum ada engine | FASE D + uji unit faktor hari; semua prorata jadi line auditable |
| **Tax issues** | `tax=0`, tak ada faktur | FASE G: tarif configurable, snapshot, faktur B2B |
| **Data loss** | Purger retensi salah hapus | Purger idempoten + dry-run + hormati cap plan live; **jangan** hapus data finansial (invoice immutable) |
| **Storage explosion** | Media WA menumpuk, tanpa retensi | BAGIAN 3+4+5: enforcement real-time + retensi default + lifecycle cold storage |
| **AI cost explosion** | Kuota token flat tanpa batas keras | Credit model + batas keras + overage + markup; monitor COGS per tenant |
| **Trial abuse** | Trial farming | Batas trial per identitas/nomor + verifikasi |
| **Cash flow (refund)** | Downgrade → refund tunai | Kebijakan **credit wallet**, bukan refund |

---

# 11. Credit / Wallet System (BAGIAN 11) & Booster (BAGIAN 12)

## 11.1 Wallet (prasyarat proration & refund)
**Rekomendasi: bangun Credit Balance / Wallet.** Tanpa ini, proration-credit & "refund" tidak punya tempat mendarat.
- **Saldo kredit (Rp)** per tenant: diisi dari proration-credit, kompensasi, atau promo.
- **Promotional credit** & **referral credit**: kredit dengan **masa berlaku** & flag sumber (untuk akuntansi terpisah dari kas riil).
- Saat checkout/perpanjangan: wallet dipakai lebih dulu, sisanya ke gateway.
- **Akuntansi:** kredit promo ≠ pendapatan; kredit dari uang pelanggan = liabilitas. Pisahkan jenisnya.

## 11.2 Booster Token / Credit (BAGIAN 12)

| Kebijakan | Profit | Fairness | Accounting | Kepuasan |
|---|---|---|---|---|
| A. Hangus tiap bulan | Tinggi | Rendah | Mudah | Rendah |
| B. Carry-forward selamanya | Rendah | Tinggi | **Sulit** (liabilitas abadi) | Tinggi |
| C. **Expiry 90 hari** | **Seimbang** | **Tinggi** | Sedang | **Tinggi** |
| D. Expiry 1 tahun | Sedang | Tinggi | Sedang | Tinggi |

**Rekomendasi: pisahkan dua "ember".**
- **Alokasi plan** (bulanan) → **hangus tiap periode** (use-it-or-lose-it) — mendorong pemakaian & upgrade, akuntansi bersih.
- **Booster berbayar** → **carry-forward dengan expiry 90 hari** — adil (mereka membayar) tapi tidak jadi liabilitas abadi.
- **Urutan konsumsi:** pakai **alokasi plan dulu** (yang akan hangus), baru booster (FIFO, yang paling dekat expiry dulu). Ini memaksimalkan nilai bagi pelanggan & meminimalkan liabilitas perusahaan.

---

# 12. Enterprise Architecture Recommendation

**Komponen target (additive di atas yang ada):**
1. **Tax engine** (`tax_rates`, per-tenant tax profile, snapshot ke invoice) — BAGIAN 8/G.
2. **Dunning engine** (state machine invoice `open`: reminder → grace → suspend → terminate) — BAGIAN 10/F.
3. **Overage engine** (hitung pemakaian > plafon per periode → line `usage` di invoice) — resolusi dualisme.
4. **Proration engine** (faktor hari → credit/charge lines) — BAGIAN 6/D.
5. **Credit wallet** (saldo, sumber, expiry; dipakai di checkout) — BAGIAN 11.
6. **Revenue recognition ledger** (deferred → recognized harian via `covers_from/to`) — BAGIAN 9.
7. **Retention purger + lifecycle** (hot→warm→cold/archive→delete) — BAGIAN 4/5/E.
8. **FinOps reporting** (MRR/ARR/churn/NRR/LTV dari invoice + recognized revenue) — BAGIAN 14/H.

**Invarian arsitektur yang harus dijaga (sudah benar, jangan dilanggar):**
- Invoice **immutable** + harga **snapshot**.
- **Satu chokepoint settlement** transaksional, idempoten.
- **Limit terpusat** di `tenant_quota`; **usage live** (jangan duplikasi sumber kebenaran).
- **Rupiah bulat** integer di seluruh boundary.
- Migration via `psql` (konvensi repo), invoice & data finansial **tak pernah dihapus** purger.

## Payment Failure (BAGIAN 10) — state machine dunning (F)
```
open ──(jatuh tempo)──> past_due
past_due ──(grace 3–7 hr, reminder H+0/H+3/H+7)──> suspended (akses dibatasi, /billing tetap buka)
suspended ──(grace lanjutan 14–30 hr)──> terminated (data masuk retensi/cold, langganan ditutup)
*) pembayaran berhasil di tahap mana pun → kembali ke active, invoice paid
```
Kegagalan VA expired / transfer tidak masuk: invoice tetap `open`, reminder berjalan; manual-poller sudah menyediakan jalur verifikasi.

## Archive Strategy (BAGIAN 5) — lifecycle data
| Tier data | Lokasi | Performa | Biaya | UX |
|---|---|---|---|---|
| **Hot** (0–N bln, sesuai plan) | DB + Object Storage standar | cepat | tinggi | penuh |
| **Warm** (lewat hot, masih dalam retensi) | Object Storage infrequent-access | sedang | sedang | akses sedikit lambat |
| **Cold** (mendekati batas retensi) | Cold/archive storage | lambat (restore) | murah | "restore on demand" |
| **Deleted** (lewat retensi) | dihapus permanen | — | — | hilang (sesuai kebijakan) |
Data **finansial (invoice)** selalu hot & permanen — di luar lifecycle ini.

---

# 13. Roadmap Implementasi (Prioritas Tinggi → Rendah)

> Semua *additive*, tanpa mengubah fitur existing. Pemetaan ke FASE C–H + komponen baru.

### Prioritas 1 — Menutup kebocoran uang (lakukan dulu)
- **F. Dunning + penagihan invoice `monthly_close`** — invoice `open` jadi benar-benar tertagih; state machine grace/suspend/terminate; selesaikan enforcement `expired/suspended`. *Tanpa ini, FASE B tidak menghasilkan uang.*
- **Overage token & storage → line item invoice** — resolusi dualisme; `pricing.ts` jadi tarif overage, bukan estimasi liar.

### Prioritas 2 — Kepatuhan & kebenaran finansial
- **G. Pajak/PPN** — tarif configurable, inclusive/exclusive, snapshot `tax_idr`, pisahkan net vs pajak. (Faktur e-Faktur B2B menyusul.)
- **Revenue Recognition (lanjutan H)** — deferred → recognized harian via `covers_from/to`; MRR/ARR/churn/NRR akurat. (FASE H "revenue dari invoice" sedang berjalan = pintu masuknya.)

### Prioritas 3 — Mengendalikan biaya (COGS & storage)
- **C. Storage enforcement + monitoring** — real-time vs `storageLimit`, peringatan 80/100%, billing overage average-daily.
- **E. Retensi otomatis + lifecycle** — purger hormati cap plan, default retensi per tier, hot→warm→cold.
- **Credit model (Token Economics)** — abstraksi MaxiCredit di atas token, batas keras, markup margin.

### Prioritas 4 — Pengalaman & keadilan
- **D. Proration engine** — faktor hari, credit/charge lines (butuh wallet).
- **Credit Wallet** — saldo, promo/referral, expiry; dipakai checkout. (Prasyarat proration yang benar — bisa dimajukan jika proration didahulukan.)
- **Booster economics** — alokasi plan hangus + booster carry-forward 90 hari, konsumsi FIFO.

### Prioritas 5 — Dashboard & laporan
- **Dashboard pelanggan** — forecast, sisa, estimasi overage, wallet.
- **FinOps dashboard** — MRR/ARR/ARPA/ARPU/churn/expansion/contraction/NRR/LTV/CAC payback.

---

## Catatan penutup
Tidak ada satu pun rekomendasi di atas yang menuntut membongkar FASE A/B. Semua menumpuk di atas invarian yang sudah benar (invoice immutable, settlement idempoten, limit terpusat, anniversary billing). Urutan roadmap sengaja menempatkan **penutupan kebocoran uang (F + overage)** lebih dulu karena itu memberi ROI tercepat, lalu **kepatuhan (pajak) & kebenaran (revenue recognition)**, baru **efisiensi biaya (storage/retensi/credit)**, **keadilan (proration/wallet/booster)**, dan terakhir **visibilitas (dashboard)**.
