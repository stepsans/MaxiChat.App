# Audit: Combined Implementation Prompt v2.0 vs Codebase Aktual

> Tanggal: 2026-06-19 · Sifat: **audit read-only, tanpa perubahan kode fitur**.
> Metode: 3 agent paralel (B-backend, B-frontend, C) + verifikasi DB langsung
> oleh main via `psql "$DATABASE_URL"` untuk BAGIAN A & kolom `ai_pipeline_analyses`.
> Legend: ✅ ADA · 🟡 SEBAGIAN (ada tapi beda/parsial) · ❌ BELUM.

## Ringkasan Eksekutif

**Mayoritas dokumen ini sudah diimplementasikan.** Spec ditulis seolah A/B/C
fitur baru, padahal:

- **BAGIAN A (fix leadStatus): sudah selesai — bahkan lebih baik dari spec.**
- **BAGIAN B (AI Pipeline): inti sudah jalan; yang belum hanya lapis
  "lead-classification + conversation-role + skip + auto-opportunity".**
- **BAGIAN C (Laporan & Jadwal): hampir seluruhnya sudah ada & terpasang.**

Gap nyata terkonsentrasi di **satu lapis koheren di BAGIAN B** + beberapa item
kecil. Total ~85–90% spec sudah ada.

### ⚠️ Dua ranjau di spec (jangan diikuti mentah)

1. **`CREATE TABLE IF NOT EXISTS` di B.2/C.2 akan no-op diam-diam.** Semua tabel
   AI Pipeline & report sudah ada → pernyataan dilewati total, kolom baru
   (`lead_classification`, `conversation_role`, dst) TIDAK tertambah. Wajib
   pakai `ALTER TABLE ADD COLUMN IF NOT EXISTS`.
2. **Spec menyimpan leadStatus di `chats.lead_status` (per-chat).** Itu pola
   **legacy yang sudah ditinggalkan**. Sumber kebenaran sekarang adalah tabel
   **`contact_lead_status`** (per owner+phone). Integrasi AI Pipeline harus ke
   sana, bukan menulis ulang kolom legacy.

---

## BAGIAN A — Fix Lead Status

Premis spec A.1 ("tidak ada di DB/OpenAPI, data tak pernah tersimpan") **sudah
usang / salah untuk codebase saat ini.**

| Item spec | Status | Bukti / catatan |
|---|---|---|
| A.2 kolom `chats.lead_status` di DB | ✅ ADA (DB-verified) | Ada di `chats`. Tapi kini **legacy/unused** — reads resolve dari `contact_lead_status`. |
| Penyimpanan leadStatus (data persist?) | ✅ ADA | Di-refactor jadi **per-kontak**: `contactLeadStatusTable` (owner+phone), `whatsapp.ts:168-188`. Klasifikasi ikut kontak di semua channel. |
| A.3 drizzle `leadStatus` | ✅ ADA | `whatsapp.ts:40` (legacy chat col) + `:175` (contact_lead_status, sumber kebenaran). |
| A.4 leadStatus di OpenAPI (Chat, ChatWithMessages, ChatUpdate) | ✅ ADA | `openapi.yaml` (≥4 schema). |
| A.5 PATCH `/chats/:id` persist leadStatus | ✅ ADA | `routes/chats.ts:1976,1991` → `setContactLeadStatus(owner, phone, leadStatus)` (`:521-531`). |
| Frontend dropdown → PATCH | ✅ ADA | `ChatInfoSidebar.tsx:2205-2207` `onUpdate({leadStatus})`. |
| `lead_classified_by` (manual\|ai) | ❌ BELUM | **Tidak ada di mana pun** (DB, schema, kode). Satu-satunya bagian A yang benar-benar baru. Dipakai untuk aturan "manual selalu menang atas AI" (B). |

**Kesimpulan A:** selesai, kecuali `lead_classified_by`. Bila ingin
implementasi aturan override AI vs manual, tambahkan `lead_classified_by` ke
**`contact_lead_status`** (bukan `chats`).

---

## BAGIAN B — AI Pipeline

### B.2/B.3 Schema

| Tabel | Status | Bukti |
|---|---|---|
| ai_pipelines, ai_pipeline_channels, ai_pipeline_exclude_labels, ai_pipeline_analyses, ai_pipeline_entries, ai_pipeline_followup_logs, ai_pipeline_cutoff_logs | ✅ ADA | `lib/db/src/schema/ai-pipeline.ts:26–258`. (+3 tabel ekstra: prompt_versions, visibility, user_visibility.) |

Kolom `ai_pipeline_analyses` yang diminta spec (DB-verified, 0 dari 7 ada):

| Kolom | Status |
|---|---|
| chat_id | ❌ BELUM (identitas pakai contact_phone + channel_id) |
| lead_classification | ❌ BELUM |
| lead_classification_reason | ❌ BELUM |
| conversation_role | ❌ BELUM |
| skipped | ❌ BELUM |
| skip_reason | ❌ BELUM |
| opportunity_id | ❌ BELUM |
| previous_score | ✅ ADA (tapi tidak pernah diisi → selalu null) |
| context_hash | ✅ ADA (disimpan, tapi tidak pernah dibandingkan) |

Kolom `ai_pipelines`:

| Field | Status |
|---|---|
| score_threshold, auto_followup_enabled, followup_intervals, cutoff_times, customPrompt | ✅ ADA |
| opportunity_threshold | ❌ BELUM |
| auto_create_opportunity | ❌ BELUM |
| timezone | ❌ BELUM (perhitungan campur UTC/server-local) |

### B.8 Logika

| Item | Status | Catatan |
|---|---|---|
| (a) cut-off scheduler (poller) | 🟡 | `setInterval` 60s ada (`scheduler.ts:57`), tapi tanpa flag `inFlight` global; anti-double-run per-log via status. |
| (b) runCutoffAnalysis + analyzeChat | 🟡 | Ada (`ai-pipeline-analysis.ts:155,393`); nama `analyzeOneChat` tidak ada (= `analyzeChat`). |
| (c) GUARD skip manual not_lead sebelum AI | ❌ | Tidak ada. Hanya guard exclude-label + directionFilter. |
| (d) Pre-filter db-free (detectConversationRoleDbFree / tenant_is_buyer) | ❌ | Tidak ada sama sekali. |
| (e) Update leadStatus + override manual | ❌ | Pipeline tidak menyentuh chats/contact_lead_status. |
| (f) context_hash logic | 🟡 | Dihitung & disimpan, tapi tidak dibandingkan untuk deteksi perubahan konteks. |

### B.9 Prompt

Prompt aktual **hanya scoring 6-dimensi** (+status/estimatedValue/productInterest/
recommendation/scoreReason/aiNotes/lastOpenPoint/stalledReason/contextHash).

| Elemen spec | Status |
|---|---|
| LANGKAH 0 (conversation_role seller/buyer) | ❌ BELUM |
| LANGKAH 1 (lead_classification) | ❌ BELUM |
| field JSON conversation_role / lead_classification / skip_pipeline / topic_summary / stop_followup_detected | ❌ BELUM |

> Catatan: `lastOpenPoint`/`stalledReason` (dari kerja follow-up sebelumnya)
> SUDAH ada di prompt & parser — itu di luar scope spec ini.

### B.10 Auto-create Opportunity

| Item | Status |
|---|---|
| `createOpportunityFromAi` | ❌ BELUM (tidak ada di repo) |
| source='ai_pipeline' | ❌ BELUM |

> Catatan: jalur Sales Assistant terpisah (`sales-detection.ts`) MEMANG membuat
> opportunity, tapi AI Pipeline tidak.

### B.11 Follow-up

| Item | Status | Catatan |
|---|---|---|
| Scheduler + generate follow-up | ✅ ADA | `processPendingFollowups`, `generateFollowupMessage` (pakai 3-lapis bersama). |
| Stop-signal (STOP_EXPLICIT/IMPLICIT) | 🟡 | `handleInboundMessageStopSignal` ada TAPI **dead code** (tak pernah dipanggil). Yang aktif: recent-reply check di `sendFollowup`. Deteksi via AI (stop_followup_detected) belum ada. |
| Update leadStatus saat stop | 🟡 | Yang diupdate `entry.status`, bukan leadStatus chat/kontak. |

### B.12 Endpoints — ✅ SEMUA ADA

`routes/ai-pipeline.ts`: list/create/get/update/delete, toggle, run-now,
dashboard-stats, cutoff-logs, analyses(+:aid), entries(+:eid, PATCH,
do-not-followup). (+endpoint ekstra: test-prompt, generate-followup,
prompt-versions, visibility.)

### B.13 Komponen UI

| Komponen | Status | Catatan |
|---|---|---|
| PipelineCard, AnalysisDrawer | ✅ | Nama persis (lokal di file halaman). |
| ScoreBadge, ScoreBreakdownBar, CutoffTimeline, MultiSelectDropdown, ScoreSlider, EntryDrawer, FollowupTimeline | 🟡 | Ada fungsional tapi inline / nama beda (`scoreBadge`, `ScoreBar`, `MultiSelect`, `EntryModal`). Tidak ada folder `components/ai-pipeline/`. |
| **LeadBadge** | ❌ BELUM | Grep nihil. |
| **ConversationRoleBadge** | ❌ BELUM | Grep nihil. |
| ChannelBadge | ❌ BELUM | Channel inline dot+teks. |

### B.4/B.5/B.6/B.7 UI

- Navigasi & route `/ai-pipeline*`: ✅ ADA (`Layout.tsx:93`, `App.tsx:138-141`).
  - Permission key `ai_pipeline`: ❌ BELUM (reuse `opportunities` + flag `hasAiSalesAssistant`).
- Halaman utama + PipelineCard: ✅ ADA lengkap.
- Wizard: ✅ ADA (4 step; bonus step "AI Prompt"). **Auto-create opportunity
  toggle + sub-threshold: ❌ BELUM**.
- Detail 4 tab: ✅ ADA tapi struktur beda — tab = Papan(Kanban)/Analitik/Analisa/
  Pengaturan. "Pipeline Entries" = **Kanban drag-drop** (bukan tabel+menu titik-tiga).
  - Drawer: LeadBadge/ConversationRoleBadge ❌; **Export CSV ❌** (`Download`
    di-import tak dipakai); **countdown cutoff ❌**; aksi "Buat Opportunity" di
    entry ❌.

### B.14 Error handling

| Item | Status |
|---|---|
| Skip channel kosong | ✅ ADA |
| Dedup entry | ✅ ADA |
| Retry Claude (3x backoff) | ❌ BELUM (`retryCount` kolom idle) |
| Timezone handling | ❌ BELUM (UTC vs server-local mismatch) |

---

## BAGIAN C — Laporan & Jadwal

Hampir seluruhnya ✅ ADA. Shell aktual = `ReportsAndSchedules.tsx`
(`Analytics.tsx` lama = dead file).

| Sub-bagian | Status | Catatan |
|---|---|---|
| C.2/C.3 schema (report_schedules, _logs, _ai_cache) | ✅ ADA | `schema/report-schedules.ts`; +bonus kolom `engine`. |
| C.4 konsolidasi 5 menu → "Laporan & Jadwal" `/analytics` | ✅ ADA | Ikon `BarChart3` (spec minta `BarChart2` — kosmetik). Redirect lama hanya untuk `/ai-chat-report*`. |
| C.5 shell: 4 tab + `?tab=` + date picker `?period=` | ✅ ADA | +bonus filter channel global. |
| C.6 Ringkasan (4 KPI, 2 chart, NextActionBox, InfoBar) | ✅ ADA | |
| C.7 Analisa AI (4 KPI, InsightCard, AnomalyList, KbRecommendations + deep link) | ✅ ADA | **kecuali bar "EscalationTopics" ❌** (data backend ada, komponen UI tidak dirender). |
| C.8 Riwayat Chat (filter, tabel, export CSV) | ✅ ADA | |
| C.9 Jadwal (card, riwayat, wizard 3-step) | ✅ ADA | |
| C.10 endpoints (summary/ai-performance/chat-history/ai-insights/next-actions + schedules CRUD/toggle/send-now/logs) | ✅ ADA | Namespace `/analytics/v2/*` (sengaja, hindari bentrok legacy). |
| C.11 AI prompts (narrative/anomaly/kb) + cache TTL | ✅ ADA | `report-ai-insights.ts`. |
| C.12 scheduler (poller inFlight + processSchedule + mount) | ✅ ADA | Fungsi `sendScheduledReport`/`tick` (nama beda). |
| C.13 komponen UI (14) | ✅ ADA | **kecuali EscalationTopics ❌**; `AnalyticsTabs` = inline shadcn Tabs. |
| C.14 error handling | ✅ ADA (umum) | |

**Gap nyata C: hanya 1 — komponen bar "EscalationTopics" di tab Analisa AI.**
Sisanya kosmetik (nama ikon/komponen/namespace) atau bonus di luar spec.

---

## Daftar Gap Nyata (prioritas)

### Lapis besar (BAGIAN B — koheren, satu fitur)
1. Kolom DB (`ALTER TABLE`): `ai_pipeline_analyses` +7 kolom (lead_classification,
   lead_classification_reason, conversation_role, skipped, skip_reason,
   opportunity_id, chat_id), `ai_pipelines` +2 (opportunity_threshold,
   auto_create_opportunity), `contact_lead_status` +1 (lead_classified_by).
2. Pre-filter db-free `detectConversationRoleDbFree` (reverse-role supplier/vendor).
3. Prompt LANGKAH 0 (conversation_role) + LANGKAH 1 (lead_classification) +
   field JSON terkait + parser.
4. Wiring: skip manual not_lead sebelum AI; update `contact_lead_status` setelah
   AI dengan override manual (`lead_classified_by`).
5. `createOpportunityFromAi` + auto_create_opportunity (toggle wizard + threshold).
6. UI: LeadBadge + ConversationRoleBadge di AnalysisDrawer.

### Item kecil / independen
7. AI-based stop-signal + wiring `handleInboundMessageStopSignal` (saat ini dead code).
8. `EscalationTopics` bar di tab Analisa AI (C).
9. Retry Claude + timezone handling (B.14).
10. Logika pembanding `context_hash` & pengisian `previous_score`.
11. Export CSV + countdown cutoff di AI Pipeline detail.
12. Permission key `ai_pipeline` (saat ini reuse `opportunities`).

### Kosmetik (boleh diabaikan)
- Ikon `BarChart3` vs `BarChart2`; namespace `/analytics/v2/*`; nama komponen
  inline berbeda; file lama dead-code (AIChatReport*, Analytics.tsx).

---

## Rekomendasi

Jangan jalankan urutan Bagian D apa adanya. Yang bernilai: implementasikan
**lapis lead-classification BAGIAN B (item 1–6)** sebagai satu unit, terintegrasi
ke `contact_lead_status`, dengan `ALTER TABLE` (bukan CREATE IF NOT EXISTS).
Item kecil 7–12 opsional, kerjakan terpisah sesuai prioritas. BAGIAN A & C
dianggap selesai (kecuali `lead_classified_by` & `EscalationTopics`).
