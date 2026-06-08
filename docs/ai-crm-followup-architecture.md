# MaxiChat Enterprise — AI CRM & AI Sales Follow-Up Assistant

> **Status: ANALISIS & ARSITEKTUR & IMPLEMENTATION PLAN — belum ada kode, migration, atau perubahan database.**
> Dokumen ini menjadi sumber kebenaran (source of truth) untuk pembangunan bertahap, sama seperti `docs/billing-architecture-review.md`.

## 0. Ringkasan & Positioning

Yang dijual **bukan** "auto follow-up 24 jam", melainkan **AI Sales Follow-Up Assistant** — asisten yang membantu sales **menutup penjualan**: lead tidak hilang, follow-up konsisten & personal, dan peluang closing naik. Naive keyword-based auto-reply menghasilkan spam (customer sudah beli / sudah balas di channel lain / sedang menunggu penawaran / sudah tidak tertarik). Karena itu inti desain adalah **scoring + status-awareness + mode bertingkat (manusia tetap in control)**, bukan blast pesan.

Prinsip non-negotiable (selaras dengan constraint utama MaxiChat: *additive / gradual / safe, jangan rusak fitur lama*):

1. **Enterprise-only & default-off.** Fitur tidak aktif untuk paket non-Enterprise, dan bahkan untuk Enterprise sekalipun, otomasi pengiriman default **OFF**. Tenant naik level keterlibatan AI secara sadar (opt-in).
2. **Suggestion-first.** Default AI hanya *menyarankan*. Auto-send adalah level tertinggi yang harus dinyalakan eksplisit.
3. **Tidak pernah spam.** Berlapis: waiting-status gate, do-not-contact, batas sequence (max 3), pembatalan otomatis saat customer membalas, dan pacing pengiriman WhatsApp.
4. **Hemat token.** Pre-filter murah (db-free, tanpa AI) memutuskan *kapan* layak menghabiskan token untuk scoring AI. Skor di-cache, bukan dihitung ulang tiap pesan.
5. **Multi-tenant aman.** Semua entitas di-scope ke `ownerUserId` + `channelId`, mengikuti pola `resolveOwnerUserId` + `getAllowedChannelIds`.

---

## 1. Database Design

> Semua tabel baru, **tidak menyentuh tabel lama** (kecuali penambahan kolom kapabilitas opsional di `plans`, lihat §11). Migration via raw `psql` (konvensi repo, **bukan** drizzle push). Uang = whole-integer Rupiah (`integer`/`bigint mode:number`). Schema baru di `lib/db/src/schema/crm.ts`.

### 1.1 `crm_stages` — kolom Kanban (per-tenant, customizable)
| kolom | tipe | catatan |
|---|---|---|
| `id` | serial PK | |
| `owner_user_id` | int FK users(id) ON DELETE CASCADE | scoping tenant |
| `name` | text | "New Lead", "Quotation Sent", dst. |
| `sort_order` | int | urutan kolom Kanban |
| `is_won` | bool default false | stage terminal menang |
| `is_lost` | bool default false | stage terminal kalah |
| `probability_bps` | int default 0 | peluang menang (basis points 0..10000) untuk forecast |
| `color` | text nullable | warna chip |
| `created_at`/`updated_at` | timestamptz | |

Seed default saat tenant pertama mengaktifkan CRM: New Lead → Inquiry → Quotation Sent → Follow Up → Negotiation → Won(`is_won`) → Lost(`is_lost`). Stage bisa ditambah/rename/urut ulang (drag-drop kolom), tetapi minimal harus selalu ada satu `is_won` dan satu `is_lost`.

### 1.2 `crm_opportunities` — entitas inti
| kolom | tipe | catatan |
|---|---|---|
| `id` | serial PK | |
| `owner_user_id` | int FK | scoping tenant |
| `channel_id` | int FK channels(id) ON DELETE CASCADE | untuk per-channel access |
| `chat_id` | int FK chats(id) ON DELETE SET NULL | sumber percakapan |
| `phone_number` | text | kunci kontak (sejajar dengan `contact_labels`) |
| `customer_name` | text | |
| `company_name` | text nullable | |
| `product_interest` | text nullable | diisi AI, bisa diedit |
| `lead_score` | int (0..100) | skor terakhir |
| `intent_category` | text | low / medium / high |
| `estimated_value_idr` | bigint mode:number default 0 | nilai potensi |
| `stage_id` | int FK crm_stages(id) | |
| `assigned_agent_id` | int FK users(id) nullable | sales penanggung jawab |
| `status` | text default 'open' | open / won / lost |
| `notes` | text nullable | catatan AI/manusia |
| `source` | text | ai / manual |
| `last_activity_at` | timestamptz | interaksi terakhir yang bermakna |
| `created_at`/`updated_at` | timestamptz | |

Index: `(owner_user_id, stage_id)`, `(owner_user_id, phone_number)`, `(chat_id)`.

> **Catatan relasi opportunity↔contact.** Label bersifat contact-level (per `owner+phone`). Opportunity sebaiknya **per (owner, phone, siklus penjualan)**: satu kontak bisa punya beberapa opportunity historis (yang sudah Won/Lost), tetapi **maksimal satu opportunity `open`** per kontak per owner pada satu waktu (di-enforce di level aplikasi, bukan unique index, seperti pola "1 flow aktif per channel").

### 1.3 `crm_followups` — antrian & histori follow-up
| kolom | tipe | catatan |
|---|---|---|
| `id` | serial PK | |
| `opportunity_id` | int FK crm_opportunities ON DELETE CASCADE | |
| `owner_user_id` | int FK | scoping + agregasi |
| `sequence_no` | int (1..3) | urutan dalam sequence |
| `mode` | text | suggestion / approval / full_auto (snapshot mode saat dibuat) |
| `status` | text | suggested / awaiting_approval / scheduled / sent / cancelled / skipped / failed |
| `scheduled_at` | timestamptz | waktu jatuh tempo (dihitung dari last meaningful interaction) |
| `draft_message` | text | pesan personal hasil AI |
| `sent_message` | text nullable | yang benar-benar terkirim |
| `sent_wa_message_id` | text nullable | id pesan WA (rekonsiliasi tick) |
| `cancel_reason` | text nullable | mis. "customer_replied", "won", "do_not_contact" |
| `created_at`/`sent_at` | timestamptz | |

Index: `(status, scheduled_at)` untuk scheduler; `(opportunity_id, sequence_no)`.

### 1.4 `crm_settings` — preferensi per-tenant (default aman)
| kolom | tipe | default | catatan |
|---|---|---|---|
| `owner_user_id` | int PK FK | | satu baris per owner |
| `auto_create_enabled` | bool | false | Toggle 1 (default off) |
| `auto_create_min_score` | int | 70 | ambang buat opportunity otomatis |
| `auto_followup_mode` | text | 'off' | off / suggestion / approval / full_auto |
| `followup_timings_hours` | jsonb | `[24,72,168]` | jadwal FU1/FU2/FU3 (jam) |
| `max_sequence` | int | 3 | batas anti-spam |
| `business_hours` | jsonb nullable | | jam kirim aman (mis. 08–20) |
| `created_at`/`updated_at` | timestamptz | | |

> Toggle **per percakapan** (Auto Create CRM, Auto Follow Up) yang diminta di sidebar kanan disimpan sebagai **override** per chat. Opsi A (disarankan, minim perubahan): tabel kecil `crm_chat_settings(chat_id PK, auto_create bool nullable, auto_followup bool nullable)` di mana `null` = ikut default owner. Opsi B: dua kolom nullable di `chats`. Pakai Opsi A agar `chats` tidak membengkak.

### 1.5 `crm_do_not_contact` — stop-list (contact-level)
`(owner_user_id, phone_number, reason, created_at)`, unik per `(owner, phone)`. Diisi saat customer minta berhenti dihubungi (deteksi AI/manual). Follow-up wajib mengecek tabel ini.

### 1.6 `crm_events` — Audit Trail
| kolom | tipe | catatan |
|---|---|---|
| `id` | serial PK | |
| `owner_user_id` | int FK | |
| `opportunity_id` | int FK nullable | |
| `type` | text | ai_recommendation / opportunity_created / opportunity_updated / stage_changed / followup_suggested / followup_approved / followup_sent / followup_cancelled / score_updated |
| `actor` | text | ai / user / system |
| `actor_user_id` | int nullable | jika actor=user |
| `payload` | jsonb | snapshot keputusan (skor, alasan, draft, dsb.) |
| `created_at` | timestamptz | |

Inilah "histori keputusan AI" yang diminta — append-only, tidak pernah di-update.

---

## 2. CRM Architecture (lapisan & alur)

```
Inbound message (Baileys/Telegram listener di routes/whatsapp.ts)
        │
        ▼
[Pre-filter intent murah, db-free]  ── tidak ada sinyal beli ──▶ stop (0 token)
        │ ada sinyal
        ▼
[Opportunity Detection + Lead Scoring (AI, 1 panggilan, JSON terstruktur)]
        │  recordAiUsage(owner)  ← token diatribusikan ke owner
        ▼
[Upsert skor ke opportunity / atau simpan rekomendasi]
        │
        ├─ Toggle Auto-Create ON & score ≥ min_score ──▶ buat crm_opportunities (stage "New Lead") + crm_events
        └─ OFF ──▶ tampilkan kartu rekomendasi di sidebar ([Create Opportunity])
        ▼
[Waiting-status engine (db-free, dari arah pesan terakhir)]
        ▼
[Follow-Up Engine] ── dijadwalkan ── ▶ crm_followups (status sesuai mode)
        ▼
[Scheduler poller 60s] ── re-validasi rules ──▶ suggestion / draft / auto-send (pacing)
        ▼
[Audit Trail crm_events]  +  [Revenue Forecast agregasi]
```

Modul kode (mirror pola lib yang sudah ada):
- `lib/crm-intent.ts` — **db-free** pre-filter + parser hasil AI (unit-testable, pola `ai-review-parse.ts`).
- `lib/crm-waiting-status.ts` — **db-free** penentu Waiting Customer/Company dari daftar pesan (unit-testable, pola `chat-read-sync.ts`).
- `lib/crm-scoring.ts` — pemanggil AI scoring (pakai `resolveAiClient`, `recordAiUsage`).
- `lib/crm-opportunities.ts` — CRUD + guard "1 open per kontak".
- `lib/crm-followup.ts` — penjadwalan + generasi pesan personal + aturan kelayakan.
- `lib/crm-followup-poller.ts` — scheduler (mirror `manual-payment-poller.ts`).
- `lib/crm-forecast.ts` — agregasi pipeline.
- `lib/crm-capability.ts` — resolusi Enterprise gating (lihat §11/§12).
- Routes: `routes/crm.ts` (opportunities, stages, settings, followups, forecast, events).

---

## 3. Opportunity Detection Engine

**Dua tahap, untuk hemat token & menghindari false trigger:**

**Tahap 1 — Pre-filter (db-free, tanpa AI).** Daftar sinyal niat beli (harga, katalog, quotation, stok, spesifikasi, demo, lead time, garansi, "berapa", "PO", dll. dalam Bahasa Indonesia + variasi). Jika pesan inbound tidak mengandung sinyal apa pun → tidak memicu scoring (0 token). Ini sekaligus pelindung biaya. Fungsi murni, mudah diuji.

**Tahap 2 — AI Scoring (1 panggilan).** Hanya jika pre-filter lolos *atau* dipicu manual dari sidebar. AI membaca jendela percakapan terakhir + konteks produk (reuse pola RAG produk/knowledge yang sudah dipakai auto-reply) dan mengembalikan **JSON terstruktur** (output-contract enforced di atas instruksi, pola AI Review):

```json
{
  "leadScore": 88,
  "category": "high",
  "productInterest": "Mesin UV DTF",
  "estimatedValueIdr": 85000000,
  "reasons": ["menanyakan harga", "meminta katalog", "meminta spesifikasi"]
}
```

Parser db-free memvalidasi & menormalkan angka (ikut konvensi Rupiah `.`=ribuan). Skor & alasan disimpan di opportunity + dicatat di `crm_events` (type `score_updated`/`ai_recommendation`).

**Anti-double-scoring:** watermark per chat (pola `lastRunAt` AI Review) — skor di-refresh hanya saat ada pesan baru sejak skor terakhir, bukan tiap poll.

---

## 4. Lead Scoring Engine

- Output 0..100 + kategori **Low (<40) / Medium (40–69) / High (≥70)** (ambang dapat dikonfigurasi tenant).
- **Explainability wajib**: `reasons[]` ditampilkan ke user ("High Intent karena: menanyakan harga, meminta katalog…").
- Skor adalah **sinyal, bukan keputusan**: semua field hasil AI **dapat diedit** user; auto-create hanya jalan bila toggle ON dan score ≥ `auto_create_min_score`.
- Skor bisa turun (mis. customer bilang "nanti dulu") — engine boleh menurunkan skor pada refresh berikutnya; perubahan dicatat di audit.

---

## 5. Kanban Architecture

- Data: `crm_stages` (kolom) + `crm_opportunities.stage_id` (kartu).
- UI: papan Kanban di halaman baru **CRM** (artifact `whatsapp-ai`), drag-and-drop kartu antar kolom **dan** drag untuk urut ulang kolom. Pustaka DnD ringan (mis. `@dnd-kit`) — keputusan implementasi nanti.
- **Optimistic update** dengan rollback bila API gagal; perpindahan stage menulis `crm_events` (`stage_changed`) + mengupdate `last_activity_at`.
- Filter per channel (hormati `getAllowedChannelIds`), per agent, per kategori skor.
- Memindahkan ke stage `is_won`/`is_lost` menutup opportunity (`status`), **menghentikan semua follow-up pending** (cancel reason `won`/`lost`).

---

## 6. Follow-Up Engine

**Kelayakan (semua harus terpenuhi sebelum follow-up dibuat/dikirim):**
- Status percakapan = **Waiting Customer** (sales yang terakhir bicara; lihat §? di bawah).
- Customer **belum** membalas sejak interaksi bermakna terakhir.
- Opportunity **bukan** Won/Lost.
- **Tidak** ada pesan inbound yang belum dijawab (kalau ada → tugas sales adalah *menjawab*, bukan follow-up).
- Nomor **tidak** ada di `crm_do_not_contact`, dan tidak ada permintaan stop kontak.
- `sequence_no` ≤ `max_sequence` (default 3) — setelah FU3, **berhenti**.

**Sequence default:** FU1 = 24 jam, FU2 = 72 jam, FU3 = 7 hari (konfigurabel; lihat §7). Setiap follow-up adalah baris `crm_followups`.

**Pesan personal (anti-template):** AI menyusun pesan dari `product_interest` + histori + stage + nama customer (reuse `resolveAiClient` + pola *context anchoring* auto-reply). Dilarang template kaku "Gimana pak?". Contoh hasil ada di lampiran prompt.

**Tiga mode (level keterlibatan AI), per tenant + override per chat:**
1. **Suggestion Only** (default) — AI hanya menaruh draft + tombol kirim di sidebar; manusia klik kirim. AI **tidak pernah** mengirim.
2. **Approval Required** — AI membuat draft terjadwal; saat jatuh tempo muncul "Follow-up siap dikirim" untuk di-approve user.
3. **Full Auto** — AI mengirim sendiri saat jatuh tempo (fitur premium tertinggi). Tetap tunduk pada semua rule + pacing.

---

## 7. Scheduling Architecture

- **Pola = `manual-payment-poller.ts`**: `setInterval` ~60s, `inFlight` boolean guard (anti-overlap), tulis `lastPolledAt` (liveness), epoch-guard, di-wire di `index.ts`. **Best-effort, tidak pernah meng-crash** API (try/catch luas + logging).
- **Perhitungan jadwal** berbasis **Last Meaningful Interaction** (bukan sekadar timestamp pesan terakhir): pesan kosong/sticker/sistem diabaikan. Fungsi db-free menentukan titik acuan.
- Tiap tick: ambil `crm_followups` dengan `status='scheduled' AND scheduled_at <= now()`, lalu untuk tiap baris **re-validasi ulang seluruh rule kelayakan** (kondisi bisa berubah sejak dijadwalkan — customer mungkin sudah balas). Lalu bertindak sesuai `mode`.
- **Window jam kerja** opsional (`business_hours`): di luar jam, geser ke awal window berikutnya (hindari kirim tengah malam).
- **Idempotensi & race**: update status dengan guard kondisional (`WHERE status='scheduled'`) seperti pola settlement pembayaran, sehingga dua tick tak mengirim ganda.
- **Pacing WhatsApp wajib** (invariant memory): tiap auto-send pakai random delay per pesan + presence "typing" (reuse batas reply-delay tenant) untuk menurunkan risiko ban; idealnya ada **cap harian** auto-send per channel.

### Waiting Status Detection (dipakai §6 & §7)
- **db-free** `lib/crm-waiting-status.ts` membaca arah pesan bermakna terakhir:
  - terakhir **outbound** (fromMe) → **Waiting Customer** → follow-up layak.
  - terakhir **inbound** → **Waiting Company** → follow-up **dilarang** (jawab dulu).
- Sumber data: `chat_messages.direction`/`fromMe`/`content`/`createdAt` (sudah ada). Tidak ada perubahan skema pesan.

---

## 8. AI Insight Engine (Sidebar Kanan)

Extension pada `ConversationPane.tsx` / `ChatInfoSidebar` (whatsapp-ai). Tampilkan **kartu AI Opportunity**:

```
AI Opportunity
Produk:        Mesin UV DTF
Intent:        High (88%)
Estimasi:      Rp 85.000.000
Tahap:         Quotation Sent
Status:        Waiting Customer
Last Activity: 3 hari lalu
Rekomendasi:   Follow Up besok
AI Notes:      Customer belum merespon 5 hari sejak quotation.
[Create Opportunity]  [Enable Follow Up]  [Kirim Follow-Up sekarang]
```

Plus **Toggle 1 (Auto Create CRM Opportunity)** dan **Toggle 2 (Auto Follow Up)** dengan indikator mode aktif. Insight digenerate on-demand (saat sidebar dibuka / pesan baru), bukan tiap render, dan di-cache. Semua angka editable lewat form opportunity.

---

## 9. AI Revenue Forecast Architecture

Endpoint `GET /crm/forecast` (Enterprise-only), agregasi `crm_opportunities` per owner:
- **Pipeline Value** = Σ `estimated_value_idr` opportunity `open`.
- **Expected Revenue** = Σ (`estimated_value_idr` × `stage.probability_bps/10000`) — weighted by stage.
- **Won Rate / Lost Rate** = dari opportunity tertutup dalam periode.
- **Forecast Revenue** = kombinasi expected + tren historis won-rate.
Semua whole-Rupiah. Ditampilkan sebagai ringkasan + chart di halaman CRM/Analytics. (Bisa memakai snapshot harian seperti `usage_snapshots` bila perlu tren.)

---

## 10. Audit Trail Design

- Semua tindakan AI & override manusia → `crm_events` (append-only, lihat §1.6).
- Yang dicatat: rekomendasi AI, pesan yang digenerate, follow-up terkirim, opportunity dibuat/diupdate, perpindahan stage, perubahan skor.
- UI: tab "Riwayat AI" di detail opportunity — transparansi penuh atas keputusan AI (syarat kepercayaan untuk mode Full Auto).

---

## 11. Tenant Permission Design

- **Owner resolution**: semua query di-scope via `resolveOwnerUserId` (hormati `parent_user_id`).
- **Per-channel access**: opportunity & forecast difilter `getAllowedChannelIds` (supervisor/agent hanya channel yang diizinkan; super_admin semua).
- **Menu permission**: tambah menu `crm` ke sistem `role_permissions`/`user_permissions` + `requirePermission("crm", action)`. Frontend gating via `usePermissions` (sembunyikan menu **dan** self-guard halaman — ingat: menyembunyikan nav ≠ mengamankan route).
- **Capability gating (Enterprise)**: lihat §12.

---

## 12. Enterprise Package Restriction

Karena `plans` saat ini **hanya** punya kuota numerik (tidak ada feature-flag), dan **plan key dapat diubah admin** (jangan hardcode string `"enterprise"`), rekomendasi:

- **Tambah kolom kapabilitas di katalog `plans`** (additive, default-off): mis. `crm_enabled boolean default false` (atau `capabilities jsonb`). Operator mencentang paket mana yang membuka CRM dari tab admin "Paket & Add-on". Ini konsisten dengan prinsip MaxiChat "katalog admin-configurable, never hardcoded".
- **Resolusi runtime** `lib/crm-capability.ts` → `isCrmEnabled(ownerUserId)`: baca `users.plan` owner → join `plans.crm_enabled` (+ bypass untuk Owner Infinity). Default fallback false.
- **Backend**: middleware `requireCrmCapability` di semua route `/crm/*` (403 + pesan "Fitur CRM hanya untuk paket Enterprise"). Scheduler & detection **skip** owner tanpa kapabilitas (0 token, 0 efek).
- **Frontend**: menu CRM, Kanban, toggle, panel insight **tidak muncul** bila kapabilitas off; tetap **"siap saat upgrade"** karena tabel & kode sudah ada — menyalakan kapabilitas langsung membuka fitur tanpa migrasi.

> Catatan: ini berbeda dari `enforceSubscription` (yang memblok tenant *expired*). Capability gating adalah lapisan terpisah berbasis paket, bukan status bayar.

---

## 13. Risks & Mitigation

| Risiko | Dampak | Mitigasi |
|---|---|---|
| **Spam follow-up** | customer terganggu, brand rusak, ban WA | waiting-status gate, do-not-contact, max sequence 3, cancel saat customer balas, mode suggestion default, business-hours window |
| **Salah kirim ke customer yang sudah closing** | malu/kredibilitas | re-validasi rule di scheduler (bukan saat dijadwalkan), cek Won/Lost & reply terbaru sebelum kirim |
| **Biaya token membengkak** | margin turun | pre-filter db-free, scoring hanya saat ada sinyal, watermark anti-recompute, cache skor, atribusi & kuota token ke owner (sistem `ai_usage_events` sudah ada) |
| **False positive scoring** | lead salah prioritas | semua editable, suggestion-first, ambang konfigurabel, explainability |
| **Ban nomor WhatsApp** | channel mati | pacing per pesan + typing presence + cap harian auto-send, hanya Full Auto yang kirim |
| **Race / double-send scheduler** | pesan ganda | inFlight guard, update kondisional `WHERE status='scheduled'`, idempotensi per followup |
| **Kebocoran antar tenant** | data leak | scope owner+channel di SETIAP query, FK cascade, uji regresi tenant-isolation |
| **Merusak fitur lama** | regresi | semua additive, default-off, tabel & route terpisah, tidak mengubah pipeline pesan inti |
| **Crash dari listener/scheduler** | API down | try/catch luas, best-effort, epoch-guard, logging (pola Baileys/poller yang sudah teruji) |
| **Privasi / permintaan stop** | komplain/hukum | deteksi & hormati stop-contact, audit trail penuh |

---

## 14. Roadmap Implementation (bertahap, DB didesain penuh sejak awal)

Database (§1) **didesain lengkap untuk Fase 1–3 sejak awal** sesuai permintaan, agar tidak perlu bongkar arsitektur. Yang bertahap adalah *fitur yang diaktifkan*, bukan skema.

### FASE 1 — Foundation + Insight (Suggestion-only) — *paling aman, nilai langsung terasa*
- Schema CRM lengkap (raw psql) + capability flag `plans.crm_enabled` + gating Enterprise.
- Pre-filter intent + AI scoring + waiting-status (semua db-free + unit test).
- Kartu AI Insight + rekomendasi follow-up di sidebar; **kirim manual** (tombol).
- Audit trail dasar. **Tidak ada auto-send, tidak ada scheduler.**
- *Hasil*: lead terdeteksi & ter-score, sales dapat rekomendasi follow-up personal yang tinggal klik kirim.

### FASE 2 — CRM Pipeline + Drafts (Approval)
- Halaman Kanban (stages customizable, drag-drop), CRUD opportunity, guard "1 open/kontak".
- Toggle Auto-Create (threshold) → opportunity otomatis.
- Follow-up **sequence** (FU1–3) mode **Approval** (draft terjadwal, manusia approve).
- Audit trail lengkap + tab Riwayat AI.

### FASE 3 — Automation + Forecast
- **Scheduler poller** (mirror manual-payment-poller) + mode **Full Auto** dengan pacing + cap harian + business-hours.
- **Revenue Forecast** (pipeline/expected/won-rate/forecast).
- Penyempurnaan scoring + analitik sales.

---

## Lampiran — Contoh Pesan Follow-Up (personal, bukan template)

**FU1 (24 jam):**
> Halo Pak Bagus, saya mau follow up terkait mesin laminasi yang kemarin sempat kita diskusikan. Apakah ada informasi tambahan yang bisa saya bantu?

**FU2 (72 jam):**
> Halo Pak Bagus, saya ingin memastikan apakah Bapak masih mempertimbangkan mesin laminasi tersebut. Jika ada pertanyaan atau kebutuhan lain, saya siap membantu.

**FU3 (7 hari):**
> Halo Pak Bagus, saya hanya ingin memastikan kembali apakah proyek mesin laminasi ini masih berjalan. Silakan hubungi saya kapan saja jika membutuhkan bantuan.

Lalu **berhenti** (tidak ada FU tanpa batas).
