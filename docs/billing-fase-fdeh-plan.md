# MaxiChat — Rencana Detail Implementasi: FASE F, D, E, H + Overage / Wallet / Credit

> **Mode dokumen: PERENCANAAN & DESAIN SAJA.** Tidak ada kode, migration, atau perubahan DB di dokumen ini. Tujuannya: rencana implementasi yang siap dieksekusi, **nyambung ke kode MaxiChat yang sebenarnya** (skema `invoices`/`subscriptions`/`tenant_quota`, chokepoint `settlePaymentPaid`, scheduler `monthly-close`, middleware `enforceSubscription`), dan **additive** — tidak membongkar FASE A/B/C/G yang sudah jalan.

---

## 0. Titik berangkat (apa yang SUDAH ada — jangan dibangun ulang)

| Komponen | Status | Lokasi |
|---|---|---|
| Invoice immutable + snapshot harga | ✅ FASE A | `schema/invoices.ts`, `lib/invoices.ts`, `lib/invoice-build.ts` |
| Tutup bulanan → invoice `open` | ✅ FASE B | `lib/monthly-close.ts`, `lib/monthly-close-build.ts` |
| Storage enforcement real-time | ✅ FASE C | `lib/storage-enforce.ts`, `lib/storage-config.ts` |
| PPN configurable + snapshot | ✅ FASE G | `lib/tax-config.ts`, `schema/tax-settings.ts` |
| Chokepoint settlement transaksional | ✅ | `settlePaymentPaid` di `lib/subscription-purchase.ts` |
| Read-only enforcement (expired/suspended) | ✅ sebagian | `lib/enforce-subscription.ts` |
| Usage live (token/seat/channel/storage) | ✅ | `lib/billing-engine.ts`, `aiUsageEventsTable`, `media_objects` |

**Aset skema yang sudah disiapkan untuk fase ini (sudah ada, belum dipakai):**
- `invoiceLineTypes` sudah memuat `proration_credit`, `proration_charge`, `usage`, `token_booster` → **FASE D & overage tidak butuh ubah enum line type.**
- `invoice_line_items` sudah punya `prorationFactor`, `calculationSource`, `coversFrom`, `coversTo` → **FASE D & H (revenue recognition) tidak butuh ubah skema line item.**
- `invoices.status` sudah punya `open` / `paid` / `void` + `paidAt`/`voidedAt` → **FASE F bisa pakai status ini.**
- `usage_snapshots` (snapshot harian) → basis **average-daily** untuk overage storage & **akrual harian** revenue recognition.

**Konvensi yang WAJIB dijaga di semua fase:**
- Migration via **raw `psql`**, bukan `drizzle-kit push`.
- **Rupiah bulat integer** di semua boundary; route re-check `Number.isInteger` (OpenAPI `integer` → zod `number()` menerima desimal).
- Semua jalur uang lewat **satu chokepoint** `settlePaymentPaid` (idempoten, transaksional).
- Invoice **immutable** — purger/retensi tak pernah menyentuhnya.
- `requireAdmin` = operator platform; `super_admin` = owner tenant. Jangan tertukar.
- Logika murni → modul **db-free** agar bisa di-unit-test (`node:test` via tsx).
- Infinity owner di-bypass via `isInfinityOwner()` di setiap fase yang menagih/membatasi.

---

# FASE F — Dunning & Penagihan Invoice `monthly_close`

### Masalah yang ditutup
FASE B menerbitkan invoice `monthly_close` berstatus `open`, **tapi tidak ada jalur pembayaran yang menautkannya** → pendapatan berulang tidak pernah masuk. Selain itu enforcement `expired/suspended` belum lengkap (status di `subscriptions` tidak pernah benar-benar di-flip oleh proses otomatis).

### Desain
**State machine penagihan** di atas `invoices.status` + `subscriptions.status`:

```
invoice.open ──(lewat jatuh tempo)──> dunning aktif
  reminder H+0 ──> H+3 ──> H+7   (subscription tetap active)
  H+7..H+14: subscription → past_due/grace (akses penuh, banner peringatan)
  H+14: subscription → suspended (read-only via enforceSubscription, /billing tetap buka)
  H+30: subscription → expired/terminated (data masuk jalur retensi FASE E)
*) pembayaran sukses di tahap mana pun → invoice.paid + subscription.active
```

### Perubahan skema (via psql)
1. **`subscriptions.status`** — tambah nilai `past_due` ke set status (saat ini: `trial/active/expired/suspended`). Atau pakai `suspended` yang sudah ada + kolom `grace_until`. **Rekomendasi:** tambah kolom `grace_until timestamptz` + `dunning_started_at timestamptz`, hindari menambah status baru agar `computeEffectiveStatus` minim perubahan.
2. **`invoice_dunning_log`** (tabel baru) — audit tiap aksi dunning: `invoice_id`, `step` (`reminder_0|reminder_3|reminder_7|suspended|terminated`), `channel` (`email|whatsapp|in_app`), `sent_at`. Idempotensi: UNIQUE `(invoice_id, step)` → satu step terkirim sekali.
3. **`invoices`** — tambah `due_at timestamptz` (jatuh tempo = `issuedAt` + N hari, configurable). Disnapshot saat terbit, immutable.

### Modul baru
- `lib/dunning-build.ts` (**db-free, unit-tested**): fungsi murni `nextDunningStep(invoice, now, config)` → step berikutnya + apakah subscription harus turun status. Semua aturan hari (grace 3/7/14/30) di sini.
- `lib/dunning.ts` (DB): `runDunningSweep(now)` — ambil semua invoice `open` yang lewat `due_at`, untuk tiap invoice panggil `nextDunningStep`, kirim notifikasi (in-app dulu; email/WA menyusul), tulis `invoice_dunning_log` (skip kalau step sudah ada), update `subscriptions.status/grace_until`. Per-owner independen, satu gagal tidak abort yang lain (pola `runMonthlyClose`).
- **Scheduler** harian di `index.ts` meniru pola `startMonthlyCloseScheduler` (tick 1 jam, dedup `lastRunDate` per UTC day).

### Jalur pembayaran invoice `open`
- Endpoint tenant `POST /billing/invoices/:id/pay` → buat `payments` row (`kind="invoice"`, `refId=invoice.id`) lalu jalur Xendit/manual yang **sudah ada**.
- Tambah branch `kind="invoice"` di `applyPaidPayment`: settle = set `invoices.status='paid'` + `paidAt` + perpanjang `subscriptions.currentPeriodEnd` (renew periode). Tetap di dalam transaksi `settlePaymentPaid`.
- `createInvoiceForPayment` di-skip untuk `kind="invoice"` (invoice-nya sudah ada — jangan buat ganda); cukup tautkan `payments.refId → invoice.id` & flip status invoice.

### Penyempurnaan enforcement
- `computeEffectiveStatus` (di `billing-engine.ts`) sudah menurunkan status dari `currentPeriodEnd`. FASE F membuat status **benar-benar ditulis** ke `subscriptions` oleh sweep (bukan hanya dihitung saat dibaca), sehingga laporan & dashboard konsisten.
- `enforceSubscription` tetap apa adanya (sudah block write saat read-only); FASE F hanya memastikan status mengalir ke read-only pada step `suspended`.

### Edge cases
- Invoice `open` yang dibayar manual lewat jalur lama → poller settle harus juga menutup dunning (cek di sweep: skip invoice yang sudah `paid`).
- Infinity owner: tidak punya invoice `monthly_close` (sudah di-skip di FASE B) → otomatis lolos dunning.
- Pembayaran sebagian: **tidak didukung** (satu invoice = satu pelunasan), konsisten dengan model cart "satu order satu pelunasan".

### Risiko
- Jangan kirim reminder duplikat → UNIQUE `(invoice_id, step)` + cek sebelum kirim.
- Jangan suspend tenant yang sudah bayar tapi webhook telat → sweep selalu cek status invoice **terkini** di awal iterasi.

---

# OVERAGE ENGINE — resolusi dualisme metered vs prepaid

> Dikerjakan **berbarengan / sebelum** FASE F memungutkan, karena overage menjadi *line item* di invoice `monthly_close`.

### Masalah yang ditutup
Ada dua filosofi hidup bersama: prepaid committed (uang nyata) vs metered estimasi (`pricing.ts` + "Rincian Tagihan" yang tak pernah menagih). Token/storage di atas plafon = **COGS tak terbayar**.

### Desain
- Pemakaian **di atas plafon `tenant_quota`** dihitung per periode → masuk sebagai line `usage` di invoice `monthly_close` (enum line type `usage` sudah ada).
- `pricing.ts` (saat ini kosong/legacy) **di-repurpose** menjadi **tarif overage**, bukan tagihan berdiri sendiri. Lebih baik: tarif overage = **admin-configurable DB row** (`overage_rates`: `tokenPerUnitIdr`, `storagePerGbDayIdr`, `seatIdr`, `channelIdr`), bukan konstanta hardcode (konsisten dengan filosofi katalog dinamis).

### Perhitungan per komponen
| Komponen | Cara hitung overage | Sumber data |
|---|---|---|
| Token | `max(0, used − tokenLimit)` × tarif | `aiUsageEventsTable` (live, sudah owner-keyed) |
| Storage | **rata-rata harian** `max(0, dailyUsed − storageLimit)` × tarif/GB-hari | `usage_snapshots` (snapshot harian) |
| Seat/Channel | umumnya tak overage (di-cap saat add) — opsional | live count |

Storage pakai **average-daily** (bukan peak/end-of-month) → adil + kebal abuse hapus-sebelum-cutoff.

### Modul baru
- `lib/overage-build.ts` (**db-free, unit-tested**): `computeOverageLines(usage, limits, rates, periodDays)` → array line `usage` siap dimasukkan ke invoice. Whole-rupiah, clamp ≥ 0.
- Integrasi di `runMonthlyCloseForOwner`: setelah `buildMonthlyCloseLines`, append hasil `computeOverageLines`. Total invoice termasuk overage → langsung tertagih lewat FASE F.

### Edge cases
- Periode berjalan (belum tutup) → overage hanya **proyeksi** di dashboard (BAGIAN H/dashboard), ditagih hanya saat close.
- Tarif overage berubah → ambil tarif **saat close** lalu snapshot ke line (immutable, konsisten FASE A).

---

# FASE D — Proration Engine

### Masalah yang ditutup
Upgrade/downgrade plan atau tambah/kurang seat/channel/storage di tengah periode saat ini tidak diprorata — tenant bayar penuh atau dapat gratis.

### Desain — **tidak butuh ubah skema** (kolom sudah disiapkan FASE A)
`invoice_line_items` sudah punya `prorationFactor`, `calculationSource`, `coversFrom`, `coversTo`, dan line type `proration_credit`/`proration_charge`.

Formula (berbasis HARI, anniversary-aligned — periode sudah anchor tanggal join):
```
faktor      = sisa_hari_periode / total_hari_periode
kredit_lama = harga_komponen_lama × faktor   → line proration_credit
biaya_baru  = harga_komponen_baru × faktor   → line proration_charge
selisih = biaya_baru − kredit_lama
  selisih > 0 → ditagih sekarang (charge)
  selisih < 0 → masuk Credit Wallet (BUKAN refund kas)
```

### Aturan per skenario
| Aksi | Perlakuan |
|---|---|
| Upgrade plan | Charge prorata selisih **sekarang**; akses naik seketika |
| Downgrade plan | **Kredit** prorata → wallet; berlaku **periode berikutnya** |
| Add seat/channel/storage | Charge prorata sisa periode |
| Remove seat/channel/storage | Kredit prorata → wallet |

**Prinsip emas: downgrade/remove → CREDIT wallet, bukan refund kas.** → **Wallet adalah prasyarat FASE D.**

### Modul baru
- `lib/proration-build.ts` (**db-free, unit-tested**): `computeProrationFactor(now, periodStart, periodEnd)` + `buildProrationLines(oldComponent, newComponent, factor)`. Semua edge tanggal (DST, periode <1 hari, faktor clamp 0..1) di sini.
- Integrasi: endpoint baru `POST /billing/change-plan` & `POST /billing/change-quota` → hitung proration lines → kalau net charge > 0 buat `payments` (`kind="proration"`), kalau net credit masuk wallet. Settlement tetap lewat `settlePaymentPaid`.

### Edge cases
- Upgrade lalu downgrade di hari sama → faktor hampir 1, selisih kecil; tetap auditable.
- Plan dihapus dari katalog antara checkout & settle → `applyPaidPayment` throw → rollback (pola yang sudah ada).

---

# CREDIT / WALLET SYSTEM — prasyarat proration & "refund"

### Masalah yang ditutup
Proration-credit, kompensasi, promo, dan refund tidak punya "tempat mendarat". Tanpa wallet, downgrade memaksa refund kas (buruk untuk cash flow & akuntansi).

### Perubahan skema (via psql)
1. **`tenant_wallet`** (singleton per owner): `userId` UNIQUE, `balanceIdr integer` (≥0). Saldo agregat.
2. **`wallet_transactions`** (ledger immutable): `userId`, `delta_idr` (+/−), `kind` (`proration_credit|promo|referral|compensation|consumption|adjustment`), `source_ref` (mis. invoice/payment id), `expires_at timestamptz` (untuk kredit promo/referral berbatas waktu), `created_at`. Saldo = SUM(delta) yang belum kedaluwarsa — atau materialized ke `tenant_wallet.balanceIdr` dengan ledger sebagai audit.

### Aturan akuntansi (penting)
- **Kredit dari uang pelanggan** (proration downgrade) = **liabilitas** (kewajiban).
- **Kredit promo/referral** = **bukan pendapatan**; harus terpisah + punya `expires_at`.
- Saat checkout/renewal: **wallet dipakai dulu**, sisanya ke gateway (Xendit/manual).

### Modul baru
- `lib/wallet.ts` (DB): `getWalletBalance(ownerId)`, `creditWallet(ownerId, delta, kind, ref, exec)`, `debitWallet(ownerId, amount, exec)` (clamp, tak boleh minus). Debit/credit selalu lewat `wallet_transactions` (audit) + update saldo dalam transaksi yang sama dengan settlement.
- `lib/wallet-build.ts` (**db-free, unit-tested**): pemilihan kredit yang dipakai (FIFO berdasarkan `expires_at` terdekat), pemisahan saldo kena-expiry vs permanen.
- Integrasi checkout: sebelum buat invoice Xendit, kurangi total dengan saldo wallet (debit dalam txn settlement).

### Edge cases
- Saldo wallet > total order → order Rp0, settle langsung tanpa gateway (tetap buat invoice paid).
- Kredit kedaluwarsa → job harian nolkan delta yang lewat `expires_at` (catat transaksi `adjustment`).

---

# FASE E — Retensi Otomatis + Lifecycle Data

### Masalah yang ditutup
Skema retensi sudah ada (`retention_settings` per kelas + cap `plans.retentionLimitDays`), **tapi purger belum aktif** → storage menumpuk diam-diam, biaya naik, dan liabilitas hukum (UU PDP) atas data chat customer yang tersimpan selamanya.

### Desain
- **Purger** harian menghapus data yang melewati retensi efektif = `min(retention_settings, plans.retentionLimitDays)` per kelas (`chatDays/mediaDays/logDays/analyticsDays`).
- **Lifecycle** (opsional, fase lanjutan): hot (DB + Object Storage standar) → warm (infrequent-access) → cold (archive) → deleted. MVP cukup hot → deleted.
- **Default retensi per tier** (kebijakan bisnis, bukan teknis):

| Tier | Chat | Media |
|---|---|---|
| Basic | 3 bln | 1 bln |
| Growth | 6 bln | 3 bln |
| Business | 12 bln | 6 bln |
| Enterprise | 24 bln / custom | 12 bln / custom |

### Modul baru
- `lib/retention-build.ts` (**db-free, unit-tested**): `effectiveRetentionDays(settings, planCap)` + `cutoffDate(now, days)`. Murni.
- `lib/retention-purge.ts` (DB): `runRetentionPurge(now, {dryRun})` — per owner, per kelas, hapus baris < cutoff. **Wajib:**
  - **Dry-run** dulu (hitung berapa yang akan dihapus, log) sebelum hapus nyata.
  - Hapus media → sweep Object Storage **lalu** ledger `media_objects` (pola tenant-reset: blob dulu, baris ledger belakangan = orphan yang recoverable).
  - **JANGAN PERNAH** hapus `invoices`/`invoice_line_items`/`payments`/`wallet_transactions` (data finansial permanen).
  - Idempoten; per-owner independen.
- Scheduler harian (pola yang sama).

### Edge cases
- Tenant pilih retensi lebih pendek dari cap → boleh (hemat). Lebih panjang dari cap → di-clamp ke cap.
- Enterprise cap `NULL` (unlimited) → skip purge untuk kelas itu.
- "Right to erasure" (UU PDP) sebagian sudah ada lewat **Reset Database Tenant** — purger melengkapi yang otomatis-berkala.

### Risiko
- Purger salah hapus = kehilangan data permanen → **dry-run + uji unit cutoff + hormati cap live + jangan sentuh data finansial**.

---

# FASE H — Revenue Recognition + FinOps Reporting

### Masalah yang ditutup
Saat ini "revenue" sebagian masih dibaca dari model metered estimasi (`computeRevenue` belum di-rewire ke invoice). Pembayaran tahunan diakui sekaligus saat kas masuk → **MRR/ARR melonjak palsu**, salah secara SaaS accounting (PSAK 72 / ASC 606).

### Desain — **deferred revenue, akrual harian**
- Pembayaran tahunan Rp12jt → catat **Deferred Revenue (liabilitas)** Rp12jt, akui **Rp/hari** sepanjang `coversFrom..coversTo` (kolom **sudah ada** di `invoice_line_items`).
- **Booster/overage (konsumsi)** diakui **saat dikonsumsi** (point-in-time), bukan disebar — bedakan dari langganan (over-time).
- Pisahkan **billings** (uang ditagih) dari **recognized revenue** (diakui).

### Perubahan skema (via psql)
- **`revenue_recognition`** (ledger turunan, bisa di-rebuild): `invoice_line_item_id`, `recognized_date`, `amount_idr`. Atau dihitung on-the-fly dari `coversFrom/To` + tanggal — **rekomendasi MVP: hitung on-the-fly** (tanpa tabel baru) untuk laporan, tabel hanya jika perlu performa.

### Modul baru
- `lib/revenue-recognize.ts` (**db-free, unit-tested**): `dailyRecognition(lineAmount, coversFrom, coversTo)` → Rp/hari; `recognizedInPeriod(lines, periodStart, periodEnd)`. Murni.
- `lib/finops.ts` (DB): hitung dari **invoices** (sumber kebenaran):
  - **MRR** = Σ pendapatan langganan ternormalisasi bulanan (tahunan ÷ 12), pakai *recognized*.
  - **ARR** = MRR × 12. **ARPA/ARPU**, **churn** (logo vs revenue), **expansion/contraction**, **NRR**, **LTV**, **CAC payback**.
  - **Gross margin** wajib kurangi **COGS token AI** (dari `aiUsageEventsTable` + biaya provider).
- **Rewire `computeRevenue`** → baca dari `invoices` (recognized), bukan estimasi metered. Ini langkah terakhir yang "mematikan" dualisme angka pendapatan.

### Dashboard
- **Pelanggan:** sisa & forecast token/credit/storage, estimasi overage, status & tanggal anniversary, riwayat invoice + invoice `open` yang perlu dibayar (setelah F), saldo wallet.
- **FinOps internal (admin):** MRR/ARR/churn/NRR/LTV dari invoice + recognized revenue.

---

# Peta Dependensi & Urutan Eksekusi yang Disarankan

```
                 ┌─────────────────────────┐
                 │  OVERAGE ENGINE          │  (tarif overage configurable;
                 │  → line `usage` di       │   line masuk monthly_close)
                 │    monthly_close          │
                 └───────────┬──────────────┘
                             │ (invoice total benar)
                             ▼
   ┌──────────────────────────────────────────────┐
   │  FASE F — Dunning & penagihan invoice `open`   │  ROI tercepat:
   │  (state machine + jalur bayar + enforcement)   │  menutup kebocoran uang
   └───────────────────────┬────────────────────────┘
                           │ (uang berulang benar-benar masuk)
                           ▼
   ┌─────────────────────┐     ┌──────────────────────────────┐
   │  CREDIT / WALLET     │────▶│  FASE D — Proration          │
   │  (tempat mendarat    │     │  (upgrade/downgrade prorata; │
   │   kredit)            │     │   credit → wallet)           │
   └─────────────────────┘     └──────────────────────────────┘

   ┌──────────────────────────────┐   (independen, bisa paralel)
   │  FASE E — Retensi + lifecycle │   kendalikan biaya storage
   └──────────────────────────────┘

   ┌──────────────────────────────────────────────┐
   │  FASE H — Revenue recognition + FinOps         │  terakhir:
   │  (rewire computeRevenue ke invoices)           │  butuh data F+overage
   └──────────────────────────────────────────────┘
```

**Urutan rekomendasi (prioritas ROI, sesuai roadmap dokumen review):**
1. **Overage engine** + **FASE F (dunning)** — menutup kebocoran uang (paling mendesak).
2. **Credit/Wallet** → **FASE D (proration)** — keadilan upgrade/downgrade (wallet wajib lebih dulu).
3. **FASE E (retensi)** — kendalikan biaya storage (bisa paralel kapan saja, independen).
4. **FASE H (revenue recognition + FinOps)** — kebenaran finansial; dikerjakan terakhir karena butuh data dari F + overage.

---

# Ringkasan Perubahan Skema (semua via raw `psql`)

| Fase | Tabel/kolom baru | Tabel yang sudah cukup (tanpa ubah) |
|---|---|---|
| F | `invoice_dunning_log`; `invoices.due_at`; `subscriptions.grace_until/dunning_started_at` | `invoices.status/paidAt` |
| Overage | `overage_rates` (admin-config) | `invoice_line_items` (line `usage` sudah ada), `usage_snapshots`, `aiUsageEventsTable` |
| D | — | `invoice_line_items` (proration_* + faktor/covers_* sudah ada) |
| Wallet | `tenant_wallet`, `wallet_transactions` | — |
| E | (opsional) kolom lifecycle di `media_objects` | `retention_settings`, `plans.retentionLimitDays` |
| H | (opsional) `revenue_recognition` — MVP hitung on-the-fly | `invoice_line_items.coversFrom/To` (sudah ada) |

---

# Invarian yang tidak boleh dilanggar (carry-over dari FASE A–G)

1. Invoice **immutable** + harga **snapshot** saat terbit.
2. **Satu chokepoint** `settlePaymentPaid` transaksional & idempoten — semua jalur uang (termasuk pay-invoice, proration, wallet-debit) lewat sini.
3. **Limit terpusat** di `tenant_quota`; **usage live** (jangan duplikasi sumber kebenaran).
4. **Rupiah bulat** integer; route re-check `Number.isInteger`.
5. Migration via **`psql`**; data finansial (invoice/payment/wallet ledger) **tak pernah** dihapus purger.
6. Logika murni di modul **db-free** + unit test (`node:test` via tsx).
7. **Infinity owner** di-bypass di setiap fase penagihan/pembatasan.
8. PPN: invoice payment-sourced selalu **inclusive** (total == kas yang ditagih); monthly_close honor config.
