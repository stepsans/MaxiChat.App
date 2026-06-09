# AI PIPELINE — COMPLETE IMPLEMENTATION PROMPT
# Untuk: Claude Code / Replit
# Versi: 1.0 Final
# ============================================================
# INSTRUKSI UNTUK CLAUDE CODE:
# Baca seluruh dokumen ini sebelum menulis satu baris kode pun.
# Implementasi harus PERSIS sesuai spesifikasi ini. Tidak ada
# improvisasi fitur. Setiap komponen, logika, dan UI sudah
# didefinisikan. Ikuti urutan implementasi di bagian akhir.
# ============================================================

---

## 1. OVERVIEW & KONTEKS SISTEM

Menu baru bernama **AI Pipeline** ditambahkan ke aplikasi CRM yang sudah ada.
AI Pipeline adalah fitur otomatis yang membaca percakapan chat harian dari
channel yang dipilih, menganalisa setiap percakapan dengan AI, memberikan skor
prospek, dan secara otomatis memasukkan kontak bernilai tinggi ke dalam pipeline
penjualan beserta trigger opportunity dan follow-up otomatis.

**Scope:** Fitur ini terikat ke tenant. Satu konfigurasi AI Pipeline berlaku
untuk semua agent/user di dalam tenant tersebut.

**Integrasi yang diperlukan:**
- Sistem channel yang sudah ada (WhatsApp, Instagram, dll)
- Sistem label kontak yang sudah ada
- Sistem pipeline penjualan yang sudah ada
- Sistem opportunity yang sudah ada
- API Anthropic Claude (model: claude-sonnet-4-20250514) untuk analisa AI
- Scheduler/cron job untuk cut-off otomatis
- Sistem pengiriman pesan untuk auto follow-up

---

## 2. DATABASE SCHEMA

Buat tabel-tabel berikut (gunakan ORM yang sudah dipakai di project):

```sql
-- Konfigurasi utama AI Pipeline per tenant
CREATE TABLE ai_pipelines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  score_threshold INTEGER DEFAULT 70,         -- skor minimum masuk pipeline
  opportunity_threshold INTEGER DEFAULT 80,   -- skor minimum auto-create opportunity
  auto_create_opportunity BOOLEAN DEFAULT false,
  auto_followup_enabled BOOLEAN DEFAULT false,
  followup_intervals JSONB DEFAULT '["24h", "48h", "72h"]', -- array interval
  cutoff_times JSONB DEFAULT '["12:00", "23:59"]',          -- jam cut-off harian
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Channel yang dianalisa per pipeline
CREATE TABLE ai_pipeline_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL,    -- referensi ke tabel channels yang sudah ada
  channel_name VARCHAR(255),   -- cache nama channel
  channel_type VARCHAR(50),    -- 'whatsapp', 'instagram', 'telegram', dll
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Label yang dikecualikan dari analisa
CREATE TABLE ai_pipeline_exclude_labels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES ai_pipelines(id) ON DELETE CASCADE,
  label_id UUID NOT NULL,      -- referensi ke tabel labels yang sudah ada
  label_name VARCHAR(255),     -- cache nama label
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Hasil analisa AI per contact per channel per cut-off
CREATE TABLE ai_pipeline_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES ai_pipelines(id),
  tenant_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  contact_name VARCHAR(255),
  channel_id UUID NOT NULL,
  channel_type VARCHAR(50),
  cutoff_datetime TIMESTAMPTZ NOT NULL,   -- kapan cut-off ini berjalan
  cutoff_window_start TIMESTAMPTZ NOT NULL, -- awal window chat yang dianalisa
  cutoff_window_end TIMESTAMPTZ NOT NULL,   -- akhir window chat yang dianalisa
  score INTEGER NOT NULL DEFAULT 0,         -- 0-100
  previous_score INTEGER,                   -- skor cut-off sebelumnya (untuk deteksi kenaikan)
  status VARCHAR(50),           -- 'waiting_reply', 'interested', 'hot', 'cold', dll
  estimated_value BIGINT,       -- dalam rupiah, bisa null
  product_interest TEXT,
  recommendation TEXT,
  score_reason TEXT,
  ai_notes TEXT,
  context_hash VARCHAR(64),     -- hash dari topik utama percakapan (untuk deteksi context sama)
  entered_pipeline BOOLEAN DEFAULT false,
  pipeline_entry_id UUID,       -- referensi ke pipeline entry bila sudah masuk
  opportunity_id UUID,          -- referensi ke opportunity bila sudah dibuat
  raw_analysis JSONB,           -- full response dari AI
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Entry di pipeline yang dibuat dari AI Pipeline
CREATE TABLE ai_pipeline_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES ai_pipelines(id),
  analysis_id UUID NOT NULL REFERENCES ai_pipeline_analyses(id),
  tenant_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  contact_name VARCHAR(255),
  channel_id UUID NOT NULL,
  channel_type VARCHAR(50),
  current_score INTEGER NOT NULL,
  estimated_value BIGINT,
  product_interest TEXT,
  status VARCHAR(50) DEFAULT 'new',
  -- status: 'new', 'in_progress', 'followup_sent', 'replied', 'closed_won', 'closed_lost', 'do_not_followup'
  followup_count INTEGER DEFAULT 0,
  last_followup_at TIMESTAMPTZ,
  next_followup_at TIMESTAMPTZ,
  do_not_followup BOOLEAN DEFAULT false,
  do_not_followup_reason TEXT,
  do_not_followup_at TIMESTAMPTZ,
  score_history JSONB DEFAULT '[]',  -- array {score, date, cutoff_window}
  entered_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Log follow-up yang terkirim
CREATE TABLE ai_pipeline_followup_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES ai_pipeline_entries(id),
  pipeline_id UUID NOT NULL,
  contact_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  followup_number INTEGER NOT NULL,   -- 1, 2, atau 3
  message_sent TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  was_replied BOOLEAN DEFAULT false,
  replied_at TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'sent'   -- 'sent', 'replied', 'bounced'
);

-- Log run cut-off (untuk audit dan debugging)
CREATE TABLE ai_pipeline_cutoff_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id UUID NOT NULL REFERENCES ai_pipelines(id),
  tenant_id UUID NOT NULL,
  scheduled_time TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  status VARCHAR(50) DEFAULT 'pending',  -- 'pending', 'running', 'completed', 'failed'
  contacts_processed INTEGER DEFAULT 0,
  contacts_entered_pipeline INTEGER DEFAULT 0,
  opportunities_created INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 3. NAVIGASI & ROUTING

Tambahkan menu **"AI Pipeline"** di sidebar navigasi utama aplikasi, sejajar
dengan menu Pipeline yang sudah ada. Gunakan ikon robot/AI (misalnya Sparkles
atau BrainCircuit dari Lucide React).

Route:
- `/ai-pipeline` → Halaman utama daftar pipeline
- `/ai-pipeline/new` → Wizard buat pipeline baru
- `/ai-pipeline/:id` → Detail & dashboard pipeline
- `/ai-pipeline/:id/edit` → Edit konfigurasi pipeline
- `/ai-pipeline/:id/results` → Tabel hasil analisa

---

## 4. UI — HALAMAN UTAMA AI PIPELINE (`/ai-pipeline`)

### Layout
- Header: Judul "AI Pipeline" + tombol "+ Buat Pipeline Baru" di kanan
- Bila belum ada pipeline: empty state dengan ilustrasi dan teks
  "Belum ada AI Pipeline. Buat pipeline pertama Anda untuk mulai menganalisa
  percakapan secara otomatis." + tombol CTA
- Bila sudah ada: card grid (2 kolom di desktop, 1 kolom di mobile)

### Card Pipeline
Setiap card menampilkan:
- Nama pipeline (bold, font besar)
- Badge status: Aktif (hijau) / Nonaktif (abu)
- Jumlah channel yang dianalisa: "3 Channel"
- Threshold skor: "Min. skor: 70"
- Cut-off: "2x/hari · 12:00 & 23:59"
- Statistik ringkas (3 angka kecil dalam 1 baris):
  - Total dianalisa hari ini
  - Masuk pipeline hari ini
  - Opportunity dibuat hari ini
- Last run: "Terakhir dijalankan: 2 jam lalu" atau "Belum pernah dijalankan"
- 3 tombol aksi di pojok kanan bawah card:
  - Ikon mata → lihat detail
  - Ikon edit → edit konfigurasi
  - Ikon toggle → aktifkan/nonaktifkan
  - Ikon titik tiga → dropdown: Duplikat, Hapus

---

## 5. UI — WIZARD BUAT PIPELINE BARU (`/ai-pipeline/new`)

### Struktur Wizard
Progress indicator di atas: Step 1 (aktif) → Step 2 → Selesai
Tombol navigasi bawah: "Batal" di kiri, "Lanjut →" di kanan (Step 1),
"← Kembali" dan "Simpan Pipeline" di kanan (Step 2).

---

### STEP 1 — Identitas Pipeline

**Judul section:** "Buat Pipeline Baru"
**Subjudul:** "Pipeline AI akan membaca percakapan dari channel yang kamu pilih
secara otomatis dua kali sehari, kemudian menganalisa dan memberi skor setiap
kontak."

**Form fields:**

1. **Nama Pipeline** (required)
   - Label: "Nama Pipeline"
   - Placeholder: "Contoh: Pipeline Penjualan Utama"
   - Validasi: minimal 3 karakter, maksimal 100 karakter
   - Error: "Nama pipeline minimal 3 karakter"

2. **Deskripsi** (opsional)
   - Label: "Deskripsi (opsional)"
   - Placeholder: "Tambahkan catatan untuk pipeline ini..."
   - Textarea, 3 baris

3. **Status Pipeline**
   - Label: "Status"
   - Toggle switch: Aktif / Nonaktif
   - Default: Aktif
   - Helper text: "Pipeline nonaktif tidak akan menjalankan analisa otomatis"

Tombol "Lanjut →" disabled bila nama belum diisi.

---

### STEP 2 — Konfigurasi Channel & Aturan

**Judul section:** "Konfigurasi Analisa"

**Form fields:**

#### A. Channel yang Dianalisa (required)
- Label: "Channel yang Dianalisa"
- Helper: "Pilih satu atau lebih channel yang percakapannya akan dianalisa AI"
- Komponen: Multi-select dropdown dengan search
  - Fetch dari API endpoint channel yang sudah ada di tenant
  - Tampilkan: ikon channel + nama channel + tipe (WA/IG/dll)
  - Bisa pilih multiple
  - Tampilkan jumlah yang dipilih: "3 channel dipilih"
  - Bila belum ada channel: tampilkan pesan "Belum ada channel terhubung.
    Hubungkan channel terlebih dahulu di menu Pengaturan > Channel."
- Validasi: minimal 1 channel harus dipilih

#### B. Exclude Label
- Label: "Kecualikan Kontak dengan Label"
- Helper: "Kontak yang memiliki label ini tidak akan dianalisa AI.
  Gunakan untuk mengecualikan teman, keluarga, atau kontak non-bisnis."
- Komponen: Multi-select dropdown dengan search
  - Fetch dari API endpoint label yang sudah ada di tenant
  - Tampilkan: warna label (bullet berwarna) + nama label
  - Bisa pilih multiple, boleh kosong
  - Bila kosong: semua kontak dianalisa
- Tidak required, boleh kosong

#### C. Jadwal Cut-off
- Label: "Jadwal Analisa Harian"
- Helper: "AI akan menganalisa percakapan pada jam-jam berikut setiap hari"
- Default: 2 item: "12:00" dan "23:59"
- Setiap item: time picker (jam:menit format 24 jam)
- Tombol "+ Tambah Jadwal" untuk menambah jam cut-off (maksimal 6)
- Tombol ikon sampah untuk hapus (minimal harus ada 1)
- Keterangan di bawah setiap jam, otomatis dihitung:
  - Jam 12:00 → "Menganalisa chat dari 00:00 – 12:00"
  - Jam 23:59 → "Menganalisa chat dari 12:01 – 23:59"
  - Bila ditambah jam ke-3 misal 18:00 → otomatis:
    - 12:00 → "00:00 – 12:00"
    - 18:00 → "12:01 – 18:00"
    - 23:59 → "18:01 – 23:59"
  - Logika: sort ascending, window = dari (jam sebelumnya + 1 menit) sampai jam ini

#### D. Ambang Skor (Threshold)
- Label: "Skor Minimum Masuk Pipeline"
- Komponen: Slider + input angka di sebelah kanan (sinkron dua arah)
- Range: 0–100
- Default: 70
- Color coding di bawah slider:
  0–40 merah (Dingin), 41–60 kuning (Hangat), 61–79 biru (Potensial), 80–100 hijau (Panas)
- Panah menunjuk posisi slider saat ini
- Helper: "Kontak dengan skor di atas [nilai] akan otomatis masuk ke pipeline"

#### E. Auto-create Opportunity
- Label: "Buat Opportunity Otomatis"
- Toggle switch, default: OFF
- Bila ON, tampilkan sub-field:
  - "Skor Minimum Buat Opportunity"
  - Slider + input, default: 80
  - Range: harus ≥ threshold pipeline (validasi: tidak boleh lebih rendah dari threshold pipeline)
  - Helper: "Opportunity akan dibuat otomatis bila skor mencapai angka ini"

#### F. Auto Follow-up
- Label: "Follow-up Otomatis"
- Toggle switch, default: OFF
- Bila ON, tampilkan:
  - Sub-label: "Kirim follow-up bila tidak ada balasan selama:"
  - Checkboxes + custom:
    - [ ] 24 jam
    - [ ] 48 jam
    - [ ] 72 jam
    - [ ] 7 hari
    - [ ] Custom → input jam (angka + dropdown: jam / hari)
  - Minimal 1 harus dipilih bila toggle ON
  - Urutan follow-up = urutan interval dari terkecil ke terbesar
  - Maksimal 3 follow-up akan dikirim (sistem otomatis ambil 3 interval terkecil bila lebih dari 3 dipilih)
  - Info box (biru muda): "Follow-up dikirim menggunakan AI berdasarkan konteks
    percakapan. Maksimal 3 pesan follow-up per kontak. Follow-up berhenti
    otomatis bila kontak membalas atau meminta dihentikan."

#### G. Review Section (di bawah semua field, sebelum tombol Simpan)
Card abu-abu muda berisi ringkasan konfigurasi yang dipilih:
- Nama pipeline
- Channel: [list nama channel]
- Exclude: [list label] atau "Tidak ada"
- Jadwal: [list jam + window]
- Threshold pipeline: [angka]
- Auto opportunity: Aktif (skor [angka]) / Nonaktif
- Auto follow-up: [list interval] / Nonaktif

---

### STEP 3 — Selesai (Success State)
Setelah klik "Simpan Pipeline":
- Loading state saat menyimpan
- Success screen:
  - Ikon centang hijau besar
  - "Pipeline Berhasil Dibuat!"
  - Nama pipeline yang baru dibuat
  - 2 tombol:
    - "Lihat Pipeline" → redirect ke `/ai-pipeline/:id`
    - "Buat Pipeline Lain" → reset wizard ke Step 1

---

## 6. UI — HALAMAN DETAIL PIPELINE (`/ai-pipeline/:id`)

### Header
- Nama pipeline (H1)
- Badge status (Aktif/Nonaktif) + tombol toggle langsung
- Tombol "Edit Konfigurasi" di kanan
- Tombol "Jalankan Analisa Sekarang" (manual trigger, ada konfirmasi)
- Breadcrumb: AI Pipeline > [Nama Pipeline]

### Tab Navigation
4 tab di bawah header:
1. **Dashboard** (default)
2. **Hasil Analisa**
3. **Pipeline Entries**
4. **Pengaturan**

---

### TAB 1: Dashboard

**Row 1 — Statistik Hari Ini (4 kartu)**
- Total Dianalisa: angka besar + "percakapan hari ini"
- Masuk Pipeline: angka + persentase dari total
- Opportunity Dibuat: angka
- Auto Follow-up Terkirim: angka

**Row 2 — Grafik Skor Distribusi**
- Bar chart horizontal: rentang skor 0-40, 41-60, 61-79, 80-100
- Jumlah kontak di setiap rentang
- Warna sesuai: merah, kuning, biru, hijau

**Row 3 — Aktivitas Terbaru**
- List 10 item terbaru dari analisa hari ini
- Setiap item: foto/inisial kontak, nama, channel badge, skor (badge berwarna),
  estimasi nilai, waktu analisa
- Klik item → buka drawer/modal detail analisa

**Row 4 — Status Cut-off**
- Timeline cut-off hari ini: jam berapa, status (Selesai/Menunggu/Gagal)
- Cut-off berikutnya: countdown timer

---

### TAB 2: Hasil Analisa

**Filter bar (sticky di atas tabel):**
- Date range picker (default: hari ini)
- Filter skor: All / Dingin / Hangat / Potensial / Panas
- Filter channel: dropdown multi-select
- Filter status pipeline: All / Masuk Pipeline / Tidak Masuk
- Search: nama kontak
- Tombol Export CSV

**Tabel kolom:**
| Kolom | Keterangan |
|---|---|
| Kontak | Foto + nama + nomor/username |
| Channel | Badge ikon + nama channel |
| Skor | Badge angka berwarna (merah/kuning/biru/hijau) |
| Status | Teks status dari AI |
| Minat Produk | Text |
| Estimasi Nilai | Format Rp |
| Rekomendasi | Dipotong 50 karakter + tooltip full |
| Pipeline | Badge "Masuk" (hijau) / "Belum" (abu) |
| Cut-off | Jam dan tanggal cut-off |
| Aksi | Tombol mata (detail), tombol + (paksa masuk pipeline) |

Klik baris → buka **Drawer Detail Analisa** (slide dari kanan):
- Header: nama kontak + channel badge
- Skor besar di tengah dengan gauge chart
- Breakdown skor per dimensi (6 bar kecil):
  - Sinyal Beli: X/30
  - Urgensi: X/20
  - Keterlibatan: X/20
  - Komitmen: X/15
  - Kesesuaian Produk: X/10
  - Hambatan: +X atau -X / 5
- Section: Status, Estimasi Nilai, Minat Produk
- Section: Rekomendasi AI (full text)
- Section: Alasan Skor (full text)
- Section: Catatan AI (full text)
- Section: Window Analisa (dari jam berapa sampai jam berapa)
- Tombol "Masukkan ke Pipeline" bila belum masuk
- Tombol "Buat Opportunity" bila skor ≥ opportunity threshold

---

### TAB 3: Pipeline Entries

**Filter bar:**
- Filter status: All / Baru / Diproses / Follow-up Terkirim / Dibalas / Closed Won / Closed Lost / Jangan Follow-up
- Filter channel
- Search nama kontak
- Date range picker

**Tabel kolom:**
| Kolom | Keterangan |
|---|---|
| Kontak | Foto + nama |
| Channel | Badge |
| Skor Terakhir | Badge berwarna |
| Estimasi Nilai | Rp format |
| Minat Produk | Text |
| Status Entry | Badge berwarna |
| Follow-up | "1x/3 · Berikutnya: 2j lagi" |
| Masuk Pipeline | Tanggal |
| Aksi | Mata (detail), chat (buka percakapan), tiga titik (menu) |

Menu tiga titik:
- Tandai Closed Won
- Tandai Closed Lost
- Jangan Follow-up Lagi
- Buat Opportunity Manual

**Drawer Detail Entry** (klik baris):
- Header: nama + channel
- Skor history: mini line chart perubahan skor dari waktu ke waktu
- Semua info analisa AI (sama seperti drawer hasil analisa)
- Section Follow-up Log:
  - Timeline setiap follow-up yang terkirim
  - Isi pesan yang dikirim
  - Status: Terkirim / Dibalas
  - Waktu kirim + waktu balas (bila ada)
- Section Opportunity: link ke opportunity bila sudah dibuat

---

### TAB 4: Pengaturan

Form edit konfigurasi pipeline (sama persis dengan Step 2 wizard).
Tombol "Simpan Perubahan" di bawah.
Tombol "Hapus Pipeline" merah di bagian paling bawah (dengan konfirmasi double:
modal pertama tanya yakin, modal kedua minta ketik nama pipeline).

---

## 7. LOGIKA BACKEND — ANALISA AI

### 7.1 Cut-off Scheduler

```
Setiap menit, cron job memeriksa:
  - Apakah ada ai_pipeline_cutoff_logs dengan scheduled_time <= NOW() dan status = 'pending'
  - Bila ada → jalankan proses analisa untuk pipeline tersebut

Saat pipeline disimpan/diupdate:
  - Generate cutoff_log entries untuk 7 hari ke depan berdasarkan cutoff_times
  - Bila jadwal diubah → hapus pending entries lama, buat yang baru
```

### 7.2 Proses Analisa Per Cut-off

```
FUNCTION run_cutoff_analysis(pipeline_id, cutoff_time, window_start, window_end):

  1. Ambil konfigurasi pipeline (channels, exclude_labels, thresholds)

  2. Untuk setiap channel yang terdaftar:
     a. Ambil semua kontak yang punya chat dalam window_start - window_end
     b. Filter: skip kontak yang punya label di exclude_labels
     c. Filter: skip kontak yang entry-nya sudah 'closed_won', 'closed_lost',
                'do_not_followup' DAN tidak ada chat baru setelah gap 7 hari
     d. Untuk setiap kontak:
        - Ambil semua pesan dalam window_start - window_end
        - Kirim ke AI untuk dianalisa (lihat AI Prompt section 8)
        - Simpan hasil ke ai_pipeline_analyses
        - Jalankan FUNCTION check_pipeline_entry_rules()

  3. Update cutoff_log: status = 'completed', isi statistik

FUNCTION check_pipeline_entry_rules(analysis_result):

  prev = cari ai_pipeline_analyses terbaru sebelumnya untuk kontak+channel ini

  CASE A — Belum pernah ada di pipeline (prev = null ATAU prev.entered_pipeline = false):
    IF analysis_result.score >= pipeline.score_threshold:
      → buat ai_pipeline_entries baru
      → tandai analysis_result.entered_pipeline = true
      IF analysis_result.score >= pipeline.opportunity_threshold AND pipeline.auto_create_opportunity:
        → buat opportunity baru (lihat section 9)

  CASE B — Sudah pernah masuk pipeline (prev.entered_pipeline = true):
    existing_entry = ambil ai_pipeline_entries untuk kontak+channel ini yang aktif

    IF existing_entry.status IN ('closed_won', 'closed_lost', 'do_not_followup'):
      IF tidak ada chat baru setelah entry closed + 7 hari:
        → SKIP
      ELSE:
        → Proses sebagai CASE A (context baru setelah gap)
      RETURN

    IF analysis_result.context_hash == prev.context_hash:
      -- Context sama (topik tidak berubah)
      IF analysis_result.score > prev.score AND analysis_result.score >= pipeline.score_threshold:
        IF prev.score < pipeline.score_threshold:
          -- Tadinya belum masuk, sekarang sudah melewati threshold → MASUK
          → buat ai_pipeline_entries baru
          → tandai entered_pipeline = true
        ELSE:
          -- Sudah di pipeline, update skor di entry yang ada
          → update existing_entry.current_score
          → append ke existing_entry.score_history
          IF analysis_result.score >= pipeline.opportunity_threshold AND
             pipeline.auto_create_opportunity AND existing_entry.opportunity_id IS NULL:
            → buat opportunity baru
      ELSE:
        → SKIP (tidak ada perubahan signifikan)

    ELSE:
      -- Context berbeda (topik/produk baru)
      IF analysis_result.score >= pipeline.score_threshold:
        → buat ai_pipeline_entries baru (entry terpisah, bukan update)
        → tandai entered_pipeline = true
```

### 7.3 Penentuan Context Hash

```
FUNCTION generate_context_hash(messages):
  -- Kirim ringkasan ke AI, minta AI return topik utama dalam format:
  -- "PRODUK:[nama produk/layanan utama] KEBUTUHAN:[kebutuhan utama]"
  -- Hash MD5/SHA dari string tersebut → context_hash

-- Bila hash sama → context dianggap sama
-- Bila hash berbeda → context baru
```

---

## 8. AI PROMPT — ANALISA PERCAKAPAN

### System Prompt untuk Analisa

```
Kamu adalah AI Sales Analyst yang bertugas menganalisa percakapan antara agent
penjualan dengan calon pelanggan. Tugasmu adalah membaca percakapan, memahami
konteksnya, dan memberikan penilaian objektif tentang seberapa besar potensi
penjualan dari percakapan ini.

Kamu HARUS merespons dalam format JSON yang valid. Tidak ada teks di luar JSON.

FORMAT RESPONS JSON:
{
  "score": <integer 0-100>,
  "score_breakdown": {
    "buying_signal": <integer 0-30>,
    "urgency": <integer 0-20>,
    "engagement": <integer 0-20>,
    "commitment": <integer 0-15>,
    "product_fit": <integer 0-10>,
    "barrier_adjustment": <integer -5 to 5>
  },
  "status": "<string>",
  "estimated_value": <integer dalam rupiah, atau null bila tidak disebutkan>,
  "product_interest": "<string, produk/layanan yang diminati>",
  "recommendation": "<string, rekomendasi tindakan untuk agent>",
  "score_reason": "<string, alasan pemberian skor ini>",
  "ai_notes": "<string, catatan penting tentang percakapan>",
  "topic_summary": "<string format: 'PRODUK:[nama produk] KEBUTUHAN:[kebutuhan utama]'>",
  "stop_followup_detected": <boolean>,
  "stop_followup_reason": "<string atau null>"
}

PANDUAN PENILAIAN SKOR:

1. SINYAL BELI (0-30 poin):
   - 25-30: Menyebut harga secara spesifik, minta invoice/bukti transfer, konfirmasi mau beli
   - 15-24: Tanya detail harga, tanya cara pembayaran, minta info lebih lanjut produk spesifik
   - 5-14: Menyebut nama produk, tanya ketersediaan, minta brosur/katalog
   - 0-4: Hanya salam, pertanyaan umum, belum ada sinyal beli

2. URGENSI (0-20 poin):
   - 17-20: Menyebut "hari ini", "sekarang", "segera", deadline spesifik
   - 10-16: "Minggu ini", "bulan ini", ada kebutuhan yang mendesak
   - 5-9: "Nanti", "dalam waktu dekat", tidak terlalu mendesak
   - 0-4: Tidak ada urgensi, hanya browsing

3. KETERLIBATAN (0-20 poin):
   - 17-20: Percakapan panjang, banyak pertanyaan spesifik, bolak-balik aktif
   - 10-16: Beberapa pertanyaan relevan, ada diskusi
   - 5-9: Sedikit pertanyaan, respons singkat tapi relevan
   - 0-4: Monosyllabic, tidak engage, hanya balas sekedarnya

4. KOMITMEN (0-15 poin):
   - 13-15: "Oke saya mau", "transfer ke mana", minta jadwal/appointment, konfirmasi
   - 8-12: Menyatakan minat jelas, minta tindak lanjut dari agent
   - 4-7: Tertarik tapi masih ragu, ada pertanyaan keberatan
   - 0-3: Belum ada komitmen sama sekali

5. KESESUAIAN PRODUK (0-10 poin):
   - 9-10: Produk yang diminati persis sesuai dengan yang dijual
   - 6-8: Produk yang diminati ada dalam katalog dengan sedikit penyesuaian
   - 3-5: Ada kebutuhan yang bisa dipenuhi tapi tidak langsung
   - 0-2: Produk tidak sesuai atau tidak relevan

6. PENYESUAIAN HAMBATAN (-5 hingga +5):
   - +5: Semua hambatan sudah terjawab, customer sangat antusias
   - +1 hingga +4: Ada keberatan kecil tapi sudah ditangani
   - 0: Tidak ada hambatan atau hambatan netral
   - -1 hingga -4: Ada keberatan yang belum terselesaikan (harga terlalu mahal, ragu kualitas)
   - -5: Hambatan besar (sudah pakai kompetitor, tidak punya budget, tidak butuh)

TOTAL SKOR = Jumlah semua komponen. Pastikan total sesuai dengan jumlah breakdown.

PANDUAN STATUS:
- "Menunggu balasan customer" → agent sudah balas, customer belum
- "Menunggu balasan agent" → customer sudah balas, agent belum
- "Sedang negosiasi" → aktif diskusi harga/terms
- "Siap closing" → tinggal konfirmasi pembayaran
- "Butuh follow-up" → percakapan terhenti, perlu diinisiasi ulang
- "Tidak tertarik" → sinyal penolakan jelas
- "Prospek baru" → percakapan pertama, belum ada sinyal jelas

PANDUAN STOP FOLLOW-UP (set stop_followup_detected = true bila):
- Customer secara eksplisit: "jangan hubungi", "stop", "tidak tertarik", "hapus nomor saya",
  "unsubscribe", "jangan WA lagi", atau kalimat serupa
- Customer menyatakan sudah pakai produk lain dan tidak butuh
- Customer merespons marah atau sangat negatif berulang kali
- Indikasi customer memblokir atau melaporkan

PANDUAN BAHASA RESPONS:
- Semua teks dalam Bahasa Indonesia
- Status: kalimat pendek maksimal 5 kata
- Rekomendasi: kalimat aksi yang spesifik, tidak lebih dari 2 kalimat
- Alasan skor: jelaskan poin-poin utama yang mempengaruhi skor, 2-3 kalimat
- Catatan AI: insight penting yang agent perlu tahu, bebas format, 2-4 kalimat
- topic_summary: format WAJIB "PRODUK:[nama] KEBUTUHAN:[kebutuhan]"
```

### User Prompt Template untuk Analisa

```
Analisa percakapan berikut antara agent [AGENT_NAME] dengan kontak [CONTACT_NAME]
melalui channel [CHANNEL_TYPE].

Periode percakapan: [WINDOW_START] sampai [WINDOW_END]

--- PERCAKAPAN ---
[FORMAT: TIMESTAMP | PENGIRIM | PESAN]
[DAFTAR SEMUA PESAN DALAM WINDOW WAKTU, DIURUTKAN CHRONOLOGICAL]
--- AKHIR PERCAKAPAN ---

Konteks tambahan:
- Produk/layanan yang dijual tenant ini: [TENANT_PRODUCT_CATALOG bila tersedia, atau "Tidak diketahui"]
- Label kontak: [LIST LABEL KONTAK bila ada, atau "Tidak ada label"]

Berikan analisa dalam format JSON sesuai instruksi sistem.
```

---

## 9. LOGIKA BACKEND — AUTO-CREATE OPPORTUNITY

```
FUNCTION create_opportunity_from_ai(analysis, pipeline, entry):

  opportunity_data = {
    tenant_id: pipeline.tenant_id,
    contact_id: analysis.contact_id,
    contact_name: analysis.contact_name,
    channel_id: analysis.channel_id,
    channel_type: analysis.channel_type,
    name: "[analysis.product_interest] - [analysis.contact_name]",
    estimated_value: analysis.estimated_value,
    product_interest: analysis.product_interest,
    notes: "📋 Catatan AI:\n" + analysis.ai_notes +
           "\n\n💡 Alasan Skor (" + analysis.score + "/100):\n" + analysis.score_reason,
    status: "new",
    source: "ai_pipeline",
    source_pipeline_id: pipeline.id,
    source_analysis_id: analysis.id,
    tags: ["AI Pipeline"],
    created_at: NOW()
  }

  → Insert ke tabel opportunities yang sudah ada
  → Update ai_pipeline_entries.opportunity_id dengan ID opportunity baru
  → Update ai_pipeline_analyses.opportunity_id
  → Kirim notifikasi ke agent yang bersangkutan (bila sistem notifikasi sudah ada)
  → Return opportunity_id
```

---

## 10. LOGIKA BACKEND — AUTO FOLLOW-UP

### 10.1 Scheduler Follow-up

```
Setiap 5 menit, cron job memeriksa:
  SELECT entries WHERE:
    - auto_followup_enabled = true (dari pipeline)
    - status NOT IN ('closed_won', 'closed_lost', 'do_not_followup', 'replied')
    - do_not_followup = false
    - followup_count < 3
    - next_followup_at <= NOW()
    - next_followup_at IS NOT NULL

  Untuk setiap entry:
    → Cek apakah sudah ada balasan baru dari customer sejak follow-up terakhir
    → Bila ada balasan → update status entry jadi 'replied', skip follow-up
    → Bila tidak ada → FUNCTION generate_and_send_followup()
```

### 10.2 Generate Follow-up Message (AI)

```
FUNCTION generate_and_send_followup(entry, followup_number):

  -- Ambil context percakapan terbaru (maks 10 pesan terakhir)
  recent_messages = ambil 10 pesan terakhir dari kontak ini di channel ini

  -- Tentukan tone berdasarkan nomor follow-up
  tone_instruction = {
    1: "Santai dan ramah. Ini adalah pesan pertama. Tunjukkan bahwa kamu ingat konteks
        percakapan sebelumnya. Tidak ada tekanan sama sekali.",
    2: "Helpful dan informatif. Tambahkan nilai berupa informasi yang relevan atau
        reminder halus. Tetap ringan, tidak memaksa.",
    3: "Tulus dan menghormati. Ini adalah pesan terakhir. Sampaikan bahwa kamu
        tidak akan menghubungi lagi, tapi pintu tetap terbuka bila customer butuh.
        Kesan positif di akhir."
  }[followup_number]

  -- AI Prompt untuk generate follow-up
  system_prompt = """
  Kamu adalah asisten AI yang membantu agent penjualan mengirim pesan follow-up.
  Tugasmu adalah menulis pesan follow-up yang natural, personal, dan tidak memaksa.

  ATURAN KERAS YANG TIDAK BOLEH DILANGGAR:
  1. JANGAN pernah gunakan kata atau frasa: "stok terbatas", "penawaran berakhir",
     "harga naik", "kesempatan terakhir", "jangan sampai menyesal", "hanya untuk kamu",
     "eksklusif", "limited", atau kalimat yang menciptakan urgensi palsu.
  2. JANGAN gunakan lebih dari 1 tanda seru dalam satu pesan.
  3. JANGAN tanyakan lebih dari 1 pertanyaan dalam satu pesan.
  4. JANGAN buat pesan yang terkesan copy-paste atau template.
  5. JANGAN sebut kompetitor dalam konteks negatif.
  6. JANGAN umbar janji yang tidak bisa dipastikan.
  7. Jangan terlalu panjang — maksimal 3-4 kalimat pendek.
  8. Gunakan bahasa yang sama dengan bahasa percakapan sebelumnya
     (Indonesia/English/campuran sesuai konteks).
  9. Gunakan nama customer bila tersedia.
  10. Pesan harus terasa ditulis manusia, bukan bot.

  Respons kamu HANYA berisi teks pesan yang akan dikirim. Tidak ada penjelasan,
  tidak ada format JSON, tidak ada preamble.
  """

  user_prompt = """
  Konteks percakapan sebelumnya:
  [recent_messages dalam format TIMESTAMP | PENGIRIM | PESAN]

  Informasi dari analisa AI sebelumnya:
  - Minat produk: [entry.product_interest]
  - Catatan AI: [analysis.ai_notes]
  - Status terakhir: [analysis.status]

  Ini adalah follow-up nomor [followup_number] dari maksimal 3.
  Tone yang diinginkan: [tone_instruction]

  Tulis pesan follow-up sekarang.
  """

  -- Kirim ke Claude API
  message = await call_claude_api(system_prompt, user_prompt)

  -- Scan pesan untuk stop signal sebelum kirim
  IF detect_stop_signal_in_generated_message(message):
    -- Ini tidak seharusnya terjadi, tapi sebagai safeguard
    LOG error, jangan kirim

  -- Kirim pesan via channel
  send_message(entry.channel_id, entry.contact_id, message)

  -- Update entry
  entry.followup_count += 1
  entry.last_followup_at = NOW()
  entry.status = 'followup_sent'

  -- Hitung next_followup_at
  IF followup_count < 3 AND ada interval berikutnya:
    entry.next_followup_at = NOW() + interval_berikutnya
  ELSE:
    entry.next_followup_at = NULL  -- tidak ada follow-up lagi

  -- Simpan ke followup_logs
  INSERT INTO ai_pipeline_followup_logs (...)

  -- Update entry di database
```

### 10.3 Deteksi Stop Signal dari Balasan Customer

```
FUNCTION check_incoming_message_for_stop_signal(message_text, entry_id):

  -- Jalankan ini setiap ada pesan masuk dari customer yang punya entry aktif

  KEYWORDS_EXPLICIT = [
    "jangan hubungi", "stop", "berhenti", "tidak tertarik", "ga tertarik",
    "gak tertarik", "hapus nomor", "jangan wa", "jangan whatsapp", "jangan chat",
    "jangan sms", "block", "blokir", "spam", "ganggu", "unsubscribe",
    "do not contact", "stop contacting", "not interested", "remove my number"
  ]

  KEYWORDS_IMPLICIT = [
    "sudah pakai lain", "sudah punya", "tidak butuh lagi", "ga butuh",
    "gak perlu", "nanti kalau butuh saya yang hubungi", "jangan dulu",
    "jangan sampai" -- dalam konteks penolakan
  ]

  text_lower = message_text.toLowerCase()

  IF text_lower contains any KEYWORDS_EXPLICIT:
    → SET entry.do_not_followup = true
    → SET entry.do_not_followup_reason = "Customer meminta dihentikan"
    → SET entry.do_not_followup_at = NOW()
    → SET entry.status = 'do_not_followup'
    → SET entry.next_followup_at = NULL
    → LOG ke followup_logs dengan status = 'stopped_by_customer'

  ELSE IF text_lower contains any KEYWORDS_IMPLICIT:
    → Kirim ke AI untuk konfirmasi apakah ini sinyal berhenti
    → Bila AI konfirmasi = sinyal berhenti → proses sama seperti eksplisit
```

---

## 11. API ENDPOINTS

```
GET    /api/ai-pipelines                     → list semua pipeline untuk tenant
POST   /api/ai-pipelines                     → buat pipeline baru
GET    /api/ai-pipelines/:id                 → detail pipeline
PUT    /api/ai-pipelines/:id                 → update pipeline
DELETE /api/ai-pipelines/:id                 → hapus pipeline
PATCH  /api/ai-pipelines/:id/toggle          → aktifkan/nonaktifkan

GET    /api/ai-pipelines/:id/analyses        → list hasil analisa (dengan filter + pagination)
GET    /api/ai-pipelines/:id/analyses/:aid   → detail 1 analisa
POST   /api/ai-pipelines/:id/run-now         → trigger manual cut-off (dengan validasi)

GET    /api/ai-pipelines/:id/entries         → list pipeline entries (dengan filter + pagination)
GET    /api/ai-pipelines/:id/entries/:eid    → detail 1 entry
PATCH  /api/ai-pipelines/:id/entries/:eid    → update status entry
POST   /api/ai-pipelines/:id/entries/:eid/do-not-followup  → tandai jangan follow-up

GET    /api/ai-pipelines/:id/dashboard-stats → statistik untuk tab dashboard
GET    /api/ai-pipelines/:id/cutoff-logs     → log riwayat cut-off

GET    /api/channels                         → list channel (sudah ada, reuse)
GET    /api/labels                           → list label (sudah ada, reuse)
```

---

## 12. KOMPONEN UI YANG PERLU DIBUAT

Buat sebagai reusable components:

1. **ScoreBadge** — badge angka dengan warna otomatis berdasarkan rentang
   - 0-40: merah (#EF4444), "Dingin"
   - 41-60: kuning (#F59E0B), "Hangat"
   - 61-79: biru (#3B82F6), "Potensial"
   - 80-100: hijau (#10B981), "Panas"

2. **ChannelBadge** — badge ikon+nama channel dengan warna per tipe
   - WhatsApp: hijau #25D366
   - Instagram: gradient ungu-pink
   - Telegram: biru #0088CC
   - Lainnya: abu

3. **ScoreBreakdownBar** — 6 bar horizontal untuk breakdown skor di drawer

4. **CutoffTimeline** — visual timeline jadwal cut-off dengan status

5. **MultiSelectDropdown** — dropdown dengan search dan multiple selection
   (dipakai untuk channel dan label)

6. **ScoreSlider** — slider dengan color gradient dan color-coded zones

7. **AnalysisDrawer** — drawer slide-from-right untuk detail analisa

8. **EntryDrawer** — drawer untuk detail entry + followup log timeline

9. **PipelineCard** — card untuk list di halaman utama

10. **FollowupTimeline** — timeline visual untuk log follow-up di entry drawer

---

## 13. HANDLING ERROR & EDGE CASES

1. **AI API gagal** → simpan di cutoff_log dengan status 'failed', retry otomatis
   setelah 5 menit, maksimal 3 retry. Setelah 3x gagal → kirim notifikasi ke admin.

2. **Channel tidak ada pesan** → tidak ada error, cukup lewati channel tersebut,
   catat di cutoff_log "0 kontak diproses untuk channel X".

3. **Semua kontak di-exclude** → proses selesai, catat "0 kontak diproses
   (semua dikecualikan oleh label filter)".

4. **Pipeline dinonaktifkan saat cut-off sedang berjalan** → selesaikan proses
   yang sedang berjalan, tapi jangan jadwalkan cut-off berikutnya.

5. **Format estimasi nilai tidak standar** (customer sebut "satu juta lima ratus"):
   → AI diminta selalu return angka integer. Bila tidak bisa dipastikan → null.

6. **Kontak tidak punya nama** → gunakan nomor telepon/username sebagai display name.

7. **Pesan sangat panjang** → truncate input ke AI menjadi maks 8000 token
   (ambil 50 pesan terbaru dalam window).

8. **Multiple agent handle kontak yang sama** → analisa tetap jalan, skor
   mencakup semua pesan dalam window terlepas dari agent mana yang handle.

9. **Duplikat entry** → sebelum insert, cek apakah sudah ada entry aktif
   untuk kombinasi pipeline_id + contact_id + channel_id. Bila ada → update,
   jangan insert baru.

10. **Timezone** → semua timestamp disimpan UTC. Cut-off time diinterpretasikan
    dalam timezone tenant (tambahkan field timezone di tabel tenants bila belum ada,
    default: 'Asia/Jakarta').

---

## 14. URUTAN IMPLEMENTASI

Kerjakan dalam urutan ini, jangan lompat:

1. **Database migration** — buat semua tabel sesuai schema section 2
2. **API endpoints** — buat semua endpoint section 11 (CRUD dulu, logika kompleks belakangan)
3. **Halaman utama** `/ai-pipeline` — list + empty state + card
4. **Wizard** `/ai-pipeline/new` — Step 1, Step 2, Step 3 success
5. **Halaman detail** — 4 tab, mulai dari tab Dashboard (stats + list sederhana)
6. **Tab Hasil Analisa** — tabel + filter + drawer detail
7. **Tab Pipeline Entries** — tabel + filter + drawer detail + followup log
8. **Logika analisa AI** — cut-off scheduler + proses analisa + save ke DB
9. **Logika auto-create opportunity** — integrasi dengan tabel opportunities yang ada
10. **Logika auto follow-up** — scheduler + generate message + kirim + stop signal detection
11. **Tab Pengaturan** — form edit
12. **Polish UI** — loading states, empty states, error states, responsive mobile
13. **Testing** — test manual trigger, test stop signal, test threshold logic

---

## 15. CATATAN TEKNIS PENTING

- **Jangan** hardcode API key Anthropic. Gunakan environment variable ANTHROPIC_API_KEY.
- Model yang digunakan: `claude-sonnet-4-20250514`
- Max tokens untuk analisa: 1500
- Max tokens untuk follow-up message: 300
- Semua call ke Claude API harus ada timeout (30 detik) dan retry logic (3x)
- Rate limiting: jangan kirim lebih dari 10 request paralel ke Claude API
- Semua operasi DB yang berat (analisa batch) harus async/background job
- Log semua AI request/response ke tabel terpisah untuk audit (ai_api_logs)
- Pastikan semua endpoint butuh autentikasi dan validasi tenant_id dari session
  (jangan percaya tenant_id dari request body)

---

## 16. TAMPILAN & STYLE

- Ikuti design system dan warna yang sudah ada di aplikasi
- Gunakan komponen yang sudah ada (Button, Input, Modal, Toast, dll)
- Untuk komponen baru, ikuti pola yang sama dengan komponen existing
- Loading state: gunakan skeleton loader untuk tabel dan card, bukan spinner penuh halaman
- Empty state: selalu ada ilustrasi + teks deskriptif + CTA button bila relevan
- Error state: tampilkan pesan error yang actionable, bukan kode error teknis
- Semua angka Rupiah: format "Rp 1.800.000" (titik sebagai pemisah ribuan)
- Semua tanggal/waktu: format "DD MMM YYYY, HH:mm" contoh "10 Jun 2026, 14:30"
- Responsif: semua halaman harus bisa digunakan di layar 375px (mobile) sampai 1920px

---

# SELESAI — IMPLEMENTASIKAN SESUAI URUTAN SECTION 14
```
