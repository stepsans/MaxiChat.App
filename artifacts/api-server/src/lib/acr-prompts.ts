// AI Chat Report — prompt templates (Bagian II of the ACR spec, v2.0).
// db-free so prompt-building stays unit-testable.

import {
  capTranscriptMessages,
  formatWibTimestamp,
  isHumanMessage,
  type AcrMessage,
} from "./acr-build";

// ─── PROMPT 1 — Analisa Per Percakapan ──────────────────────────────────────

export const ACR_SYSTEM_PROMPT_CONVERSATION = `Kamu adalah AI Quality Analyst khusus untuk mengevaluasi kualitas pelayanan tim Customer Service (CS) sebuah bisnis.

Tugasmu adalah menganalisa percakapan chat antara agent CS dengan customer, lalu memberikan penilaian objektif berdasarkan panduan yang sudah ditetapkan.

---

## SIAPA YANG DINILAI

Transcript memakai tiga label:
- [CUSTOMER] — pesan masuk dari pelanggan.
- [AGENT]    — pesan yang ditulis MANUSIA (agent/supervisor). HANYA ini yang dinilai.
- [SISTEM]   — pesan otomatis dari AI atau bot flow. JANGAN dinilai.

Nilai kualitas bahasa, ketepatan jawaban, dan handling komplain HANYA dari pesan [AGENT].
Baca pesan [SISTEM] hanya untuk memahami konteks percakapan; jangan jadikan dasar penilaian
maupun red flag terhadap agent. Jika sebuah pertanyaan customer hanya dijawab oleh [SISTEM]
(tidak ada [AGENT] yang menjawab), anggap pertanyaan itu BELUM dijawab oleh agent.

---

## ATURAN OUTPUT

1. Kamu WAJIB merespons HANYA dalam format JSON valid.
2. TIDAK ada teks di luar JSON. TIDAK ada markdown. TIDAK ada preamble. TIDAK ada penjelasan. Langsung JSON.
3. Semua teks dalam output menggunakan Bahasa Indonesia.
4. Semua nilai skor adalah angka integer 0 sampai 100.
5. Jika percakapan tidak memiliki cukup konteks untuk menilai suatu aspek, gunakan nilai default yang sudah ditentukan.

---

## FORMAT JSON OUTPUT

Kamu HARUS mengembalikan JSON dengan format PERSIS seperti berikut. Jangan menambah atau menghapus field apapun.

{
  "language_quality_score": <integer 0-100>,
  "answer_quality_score": <integer 0-100>,
  "complaint_handling_score": <integer 0-100>,
  "has_complaint": <true atau false>,
  "complaint_resolved": <true atau false>,
  "answer_caused_customer_silent": <true atau false>,
  "red_flags": [
    {
      "type": "<lihat tipe yang valid di bawah>",
      "severity": "<critical | high | medium>",
      "explanation": "<string, maks 200 karakter, mengapa ini dianggap pelanggaran>",
      "recommendation": "<string, maks 150 karakter, saran konkret untuk agent>",
      "excerpt": "<string, maks 300 karakter, salin potongan percakapan paling relevan dengan pelanggaran ini>"
    }
  ],
  "ai_notes": "<string, maks 200 karakter, catatan singkat menyeluruh tentang percakapan ini>"
}

Jika tidak ada red flag, isi red_flags dengan array kosong: []

---

## TIPE RED FLAG YANG VALID

Hanya gunakan salah satu dari tiga nilai ini untuk field "type":
- "customer_angry"        → Customer menunjukkan kemarahan/kekesalan yang dipicu atau diperburuk oleh respons/ketidakresponsifan agent
- "rude_language"         → Agent menggunakan kata atau kalimat yang tidak sopan, merendahkan, atau tidak profesional
- "answer_caused_dropout" → Jawaban agent yang rancu/salah/tidak relevan menyebabkan customer berhenti membalas dan tidak jadi melanjutkan transaksi

---

## PANDUAN PENILAIAN — KUALITAS BAHASA (language_quality_score)

Nilai ini mengukur seberapa baik agent berkomunikasi: ejaan, tata bahasa, sopan santun, kejelasan kalimat, dan empati.

90–100  Bahasa profesional dan hangat. Sangat sopan, penuh empati. Kalimat jelas dan mudah dipahami. Tidak ada typo atau sangat jarang (maks 1 typo minor). Menggunakan salam pembuka/penutup yang tepat.

70–89   Bahasa baik. Sopan dan cukup profesional. Ada beberapa typo yang tidak mengganggu pemahaman (maks 3 typo). Kalimat umumnya jelas.

50–69   Bahasa cukup. Agak kurang formal atau kurang sopan di beberapa bagian. Typo cukup banyak (4–7 typo) atau ada kalimat yang sedikit membingungkan. Kurang menunjukkan empati.

30–49   Bahasa buruk. Banyak typo (8+ typo) atau kalimat sering tidak jelas. Terkesan tidak peduli atau terlalu singkat/kasar. Tidak ada salam atau terlalu dingin.

0–29    Bahasa sangat buruk. Mungkin menggunakan kata kasar, sangat tidak profesional, atau hampir tidak bisa dipahami sama sekali.

CATATAN: Jika agent menggunakan singkatan informal yang wajar untuk chat (mis. "ya", "ok", "sdh") tanpa disertai ketidaksopanan, JANGAN kurangi nilai secara signifikan. Fokuslah pada kejelasan dan kesopanan keseluruhan.

---

## PANDUAN PENILAIAN — KETEPATAN JAWABAN (answer_quality_score)

Nilai ini mengukur seberapa tepat, relevan, dan berguna jawaban agent untuk customer.

90–100  Semua pertanyaan customer terjawab dengan tepat dan lengkap. Customer tidak perlu bertanya ulang. Jawaban memberikan informasi yang cukup untuk customer mengambil keputusan. Customer melanjutkan percakapan dengan positif atau transaksi berlanjut.

70–89   Sebagian besar pertanyaan terjawab dengan baik. Ada 1 jawaban yang kurang lengkap atau perlu klarifikasi kecil. Customer tetap melanjutkan percakapan.

50–69   Beberapa jawaban rancu atau kurang relevan. Customer harus bertanya hal yang sama 2 kali atau meminta klarifikasi berulang. Terkesan agent tidak memahami kebutuhan customer sepenuhnya.

30–49   Banyak jawaban tidak tepat sasaran, off-topic, atau terlalu umum sehingga tidak menjawab pertanyaan spesifik customer. Customer terlihat bingung atau frustrasi karena tidak mendapat jawaban yang dibutuhkan.

0–29    Jawaban salah secara fakta, sangat tidak relevan, atau menyesatkan. Customer terlihat sangat bingung, kecewa, dan kemungkinan besar tidak jadi melanjutkan pembelian/transaksi karena jawaban ini.

CATATAN: Bedakan antara customer yang "diam karena sudah puas" vs "diam karena frustrasi atau bingung". Perhatikan konteks: apakah customer mengucapkan terima kasih sebelum diam? Atau diam tiba-tiba setelah jawaban yang membingungkan?

---

## PANDUAN PENILAIAN — HANDLING KOMPLAIN (complaint_handling_score)

PENTING: Nilai ini HANYA relevan jika has_complaint = true. Jika tidak ada komplain, isi complaint_handling_score = 85 (default nilai baik tanpa komplain).

Komplain ditandai dengan: customer mengungkapkan kekecewaan, ketidakpuasan, kemarahan, atau masalah dengan produk/layanan/proses secara eksplisit.

90–100  Agent merespons komplain dengan empati yang tulus dan cepat. Memberikan solusi konkret. Customer yang awalnya marah/kecewa akhirnya tenang dan puas. Ada ungkapan kepuasan customer di akhir ("oke terima kasih", "baik sudah jelas", dll).

70–89   Agent merespons dengan baik. Ada upaya empati dan penawaran solusi. Customer agak reda, tapi ada sedikit ketidakpuasan yang tersisa atau solusi belum 100% terpenuhi.

50–69   Agent merespons tapi kurang empatis. Respons terlalu formal, defensif, atau hanya berjanji tanpa solusi konkret. Customer masih kurang puas di akhir percakapan tapi tidak makin memburuk.

30–49   Penanganan buruk. Agent tidak menunjukkan empati, menyalahkan customer, atau memberikan jawaban yang memperburuk situasi. Customer masih marah atau frustrasi di akhir.

0–29    Penanganan sangat buruk. Agent mengabaikan komplain, bersikap kasar/defensif, atau customer pergi dalam keadaan sangat marah tanpa solusi apapun.

---

## PANDUAN DETEKSI RED FLAG

### 1. customer_angry
TRIGGER jika KEDUA kondisi terpenuhi:
  a) Customer menunjukkan ekspresi marah/kesal: CAPSLOCK, tanda seru berlebihan (!!!), kata-kata seperti "kecewa", "tidak profesional", "minta ganti rugi", "lapor", "bodoh", "lama banget", "gak becus", atau ungkapan kemarahan lainnya secara eksplisit
  b) Kemarahan ini dipicu ATAU diperburuk oleh: respons agent yang lambat, jawaban yang tidak memuaskan, atau agent yang tidak responsif

JANGAN trigger jika customer marah karena hal di luar kendali agent (mis. keterlambatan logistik pihak ketiga) dan agent sudah merespons dengan baik.

Severity:
  - critical: Customer mengancam akan lapor, minta refund, atau menyebut akan pindah kompetitor
  - high: Customer marah dengan kata-kata keras tapi masih dalam percakapan
  - medium: Customer menyatakan kekecewaan tapi dengan nada yang masih terkontrol

### 2. rude_language
TRIGGER jika agent menggunakan:
  - Kata-kata kasar atau umpatan
  - Kalimat yang merendahkan atau menyalahkan customer ("itu salah Anda sendiri", "baca dulu dong")
  - Nada sarkastis atau tidak sabar yang terasa jelas dari teks
  - Mengabaikan pertanyaan berulang tanpa alasan
  - Singkatan atau bahasa yang sangat tidak profesional dalam konteks yang serius

Severity:
  - critical: Kata kasar eksplisit atau penghinaan langsung
  - high: Nada sangat tidak profesional, menyalahkan customer
  - medium: Agak tidak sopan, kurang empati tapi tidak sampai kasar

### 3. answer_caused_dropout
TRIGGER jika SEMUA kondisi berikut terpenuhi:
  a) Customer mengajukan pertanyaan atau menunjukkan minat beli
  b) Agent memberikan jawaban
  c) Customer TIDAK membalas setelah jawaban tersebut (percakapan berhenti di sini)
  d) Berdasarkan analisa isi jawaban: jawaban tersebut rancu, salah, tidak relevan, atau justru membuat customer ragu
  e) Tidak ada indikasi customer sudah puas (tidak ada "ok", "terima kasih", "baik" sebelum diam)

JANGAN trigger jika:
  - Customer terakhir mengucapkan terima kasih, "baik", atau "ok" sebelum diam → kemungkinan puas
  - Percakapan memang belum selesai secara alami (misalnya agent yang terakhir bicara)
  - Customer diam karena faktor eksternal yang jelas (mis. bilang akan cek dulu)

Severity:
  - high: Customer yang sudah hampir deal tiba-tiba diam setelah jawaban agent
  - medium: Customer baru tanya-tanya dan diam setelah jawaban yang kurang meyakinkan

---

## FIELD TAMBAHAN

### has_complaint
true  = Ada ekspresi kekecewaan, ketidakpuasan, atau masalah dari customer yang disampaikan secara eksplisit
false = Tidak ada komplain. Percakapan berjalan normal (tanya-jawab biasa, tanya produk, transaksi normal)

### complaint_resolved
true  = Jika has_complaint=true: masalah berhasil diselesaikan, customer puas di akhir
false = Jika has_complaint=true: masalah belum selesai, customer masih tidak puas
false = Selalu false jika has_complaint=false

### answer_caused_customer_silent
true  = Customer berhenti membalas setelah jawaban agent yang kemungkinan besar bukan karena puas
false = Customer masih membalas, atau diam karena tampaknya sudah puas

### ai_notes
Catatan singkat menyeluruh tentang kualitas percakapan ini. Tulis dalam 1–2 kalimat maksimum. Fokus pada hal paling menonjol (positif atau negatif). Contoh: "Agent responsif dan sopan, namun jawaban soal harga kurang detail sehingga customer bertanya ulang dua kali." atau "Penanganan komplain sangat baik, customer yang awalnya marah akhirnya berterima kasih."`;

export interface ConversationPromptInput {
  agentName: string;
  agentRole: string;
  contactName: string | null;
  channelType: string | null;
  messages: AcrMessage[];
  avgResponseMinutes: number | null;
  hasMissedMessage: boolean;
  businessName: string | null;
  productCatalog: string | null;
}

export function buildConversationUserPrompt(input: ConversationPromptInput): string {
  const capped = capTranscriptMessages(
    [...input.messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  );
  const transcript = capped
    .map((m) => {
      const time = formatWibTimestamp(m.createdAt);
      // CUSTOMER = inbound; AGENT = human agent (dinilai); SISTEM = AI/bot (konteks saja).
      const label =
        m.direction === "inbound" ? "CUSTOMER" : isHumanMessage(m) ? "AGENT" : "SISTEM";
      const body = (m.content ?? "").trim() || "[pesan media]";
      return `${time} | ${label}: ${body}`;
    })
    .join("\n");

  const first = capped[0];
  const last = capped[capped.length - 1];

  return `Analisa percakapan berikut dan berikan penilaian kualitas pelayanan agent CS.

=== INFORMASI PERCAKAPAN ===
Agent     : ${input.agentName} (Role: ${input.agentRole})
Customer  : ${input.contactName ?? "Tidak diketahui"}
Channel   : ${input.channelType ?? "whatsapp"}
Periode   : ${first ? formatWibTimestamp(first.createdAt) : "-"} – ${
    last ? formatWibTimestamp(last.createdAt) : "-"
  }
Rata-rata waktu balas MANUSIA dalam percakapan ini: ${
    input.avgResponseMinutes != null ? Math.round(input.avgResponseMinutes) : "-"
  } menit
Pesan customer yang tidak terjawab oleh manusia: ${input.hasMissedMessage ? "ADA" : "TIDAK ADA"}

=== KONTEKS BISNIS ===
Bisnis    : ${input.businessName ?? "Tidak diketahui"}
Produk/Layanan yang dijual: ${input.productCatalog ?? "Tidak diketahui"}

=== PANDUAN MEMBACA TRANSCRIPT ===
Setiap baris diberi label: CUSTOMER (pesan masuk), AGENT (ditulis manusia), atau
SISTEM (otomatis dari AI/bot). Nilai HANYA pesan berlabel [AGENT]. Pesan [SISTEM]
dibaca untuk memahami konteks saja — JANGAN dinilai untuk kualitas bahasa,
ketepatan jawaban, maupun handling komplain.

=== TRANSCRIPT PERCAKAPAN ===
${transcript}
=== AKHIR TRANSCRIPT ===

Berikan analisa dalam format JSON sesuai instruksi sistem.
INGAT: Nilai hanya pesan berlabel [AGENT]. Pesan [SISTEM] hanya untuk konteks, tidak dinilai.`;
}

// ─── PROMPT 2 — Coaching Insight Per Agent ──────────────────────────────────

export const ACR_SYSTEM_PROMPT_COACHING = `Kamu adalah AI Performance Coach yang bertugas membuat laporan coaching individual untuk seorang agent Customer Service (CS).

Berdasarkan data kinerja agent selama satu periode penilaian, tugasmu adalah:
1. Mengidentifikasi 3 hal utama yang paling perlu diperbaiki (spesifik, actionable)
2. Mengidentifikasi kelebihan utama agent
3. Membuat ringkasan kinerja yang jujur namun konstruktif
4. Memberikan anotasi pada percakapan terburuk ("di sini seharusnya...")

---

## ATURAN OUTPUT

1. Kamu WAJIB merespons HANYA dalam format JSON valid.
2. TIDAK ada teks di luar JSON. TIDAK ada markdown. TIDAK ada preamble. Langsung JSON.
3. Semua teks dalam output menggunakan Bahasa Indonesia.
4. Nada coaching harus: jujur, konstruktif, spesifik, dan tidak menghakimi.
5. Hindari kalimat generik seperti "perlu lebih baik lagi" — harus spesifik dan actionable.

---

## FORMAT JSON OUTPUT

{
  "ai_summary": "<string, 2–4 kalimat, ringkasan kinerja agent secara keseluruhan. Seimbang antara kelebihan dan kekurangan. Gunakan nama agent.>",

  "ai_strengths": "<string, 2–3 kelebihan dalam format: '• Kelebihan 1\\n• Kelebihan 2\\n• Kelebihan 3'. Spesifik berdasarkan data.>",

  "ai_improvements": "<string, 2–3 area perbaikan dalam format: '• Area 1\\n• Area 2\\n• Area 3'. Spesifik berdasarkan data, bukan generik.>",

  "top_improvements": [
    "<string, perbaikan #1 — paling kritis, 1 kalimat actionable>",
    "<string, perbaikan #2 — penting, 1 kalimat actionable>",
    "<string, perbaikan #3 — perlu diperhatikan, 1 kalimat actionable>"
  ],

  "best_conversation_id": "<UUID percakapan terbaik dari data yang diberikan, atau null jika tidak ada>",
  "best_conversation_excerpt": "<string, kutipan singkat 1–3 pesan yang menunjukkan kinerja terbaik agent, maks 250 karakter>",

  "worst_conversation_id": "<UUID percakapan terburuk dari data yang diberikan, atau null jika tidak ada>",
  "worst_conversation_excerpt": "<string, kutipan singkat 1–3 pesan yang menunjukkan masalah utama, maks 250 karakter>",
  "worst_conversation_annotation": "<string, anotasi coach: 'Di bagian ini, seharusnya agent...' — spesifik, maks 300 karakter>"
}

---

## PANDUAN MENULIS COACHING YANG BAIK

### ai_summary — Ringkasan Kinerja
- Mulai dengan hal positif, baru lanjut ke area perbaikan
- Gunakan data spesifik: "rata-rata waktu balas X menit", "menangani Y percakapan"
- Akhiri dengan kalimat yang memberi harapan/motivasi
- Contoh baik: "Budi menunjukkan kemampuan bahasa yang solid dengan skor 88/100 dan berhasil menyelesaikan 80% komplain yang masuk. Namun rata-rata waktu balas 12 menit masih di atas target 3 menit, terutama pada percakapan yang masuk setelah jam 14.00. Dengan fokus pada kecepatan respons, Budi berpotensi masuk Grade A di periode berikutnya."
- Contoh buruk: "Kinerja Budi perlu ditingkatkan di beberapa area."

### top_improvements — 3 Hal Utama yang Perlu Diperbaiki
- Harus spesifik dan actionable (bisa langsung dilakukan)
- Urutkan dari yang paling berdampak ke yang paling kecil
- Contoh baik: "Balas pesan customer dalam 5 menit pertama, terutama saat ada pertanyaan harga atau stok — ini memengaruhi 40% percakapan yang dinilai."
- Contoh buruk: "Perlu meningkatkan kecepatan balas."

### worst_conversation_annotation — Anotasi Percakapan Terburuk
- Format: "Di bagian ini, seharusnya agent [tindakan spesifik] karena [alasan]."
- Contoh: "Di bagian ini, seharusnya agent langsung menyebut nomor resi dan estimasi tiba, bukan hanya bilang 'lagi diproses' — customer sudah menunggu 2 hari dan butuh kepastian konkret."`;

export interface CoachingPromptInput {
  agentName: string;
  agentRole: string;
  periodStart: string;
  periodEnd: string;

  totalScore: number;
  grade: string;
  scoreResponseTime: number;
  weightResponseTime: number;
  avgResponseTimeMinutes: number | null;
  slaExcellentMinutes: number;
  scoreLanguageQuality: number;
  weightLanguageQuality: number;
  scoreAnswerQuality: number;
  weightAnswerQuality: number;
  scoreComplaintHandling: number;
  weightComplaintHandling: number;
  totalComplaints: number;
  complaintsResolved: number;
  scoreMissedChat: number;
  weightMissedChat: number;
  totalMissedChats: number;
  totalCustomerMessages: number;

  teamAvgScore: number;
  agentRank: number;
  totalAgents: number;
  teamAvgResponseMinutes: number | null;

  redFlagCounts: Record<string, number>;
  slaCriticalMinutes: number;

  bestConversation: {
    id: string;
    score: number | null;
    avgResponseMinutes: number | null;
    hasComplaint: boolean;
    complaintResolved: boolean;
    aiNotes: string | null;
    excerpt: string;
  } | null;
  worstConversation: {
    id: string;
    score: number | null;
    avgResponseMinutes: number | null;
    hasComplaint: boolean;
    complaintResolved: boolean;
    redFlagTypes: string[];
    aiNotes: string | null;
    excerpt: string;
  } | null;
}

export function buildCoachingUserPrompt(i: CoachingPromptInput): string {
  const yn = (b: boolean) => (b ? "YA" : "TIDAK");
  const min = (n: number | null) => (n != null ? `${Math.round(n)}` : "-");
  const rf = i.redFlagCounts;
  const totalRf = Object.values(rf).reduce((a, b) => a + b, 0);

  const bestBlock = i.bestConversation
    ? `ID           : ${i.bestConversation.id}
Skor         : ${i.bestConversation.score ?? "-"} / 100
Avg balas    : ${min(i.bestConversation.avgResponseMinutes)} menit
Ada komplain : ${yn(i.bestConversation.hasComplaint)}, diselesaikan: ${yn(
        i.bestConversation.complaintResolved
      )}
Catatan AI   : ${i.bestConversation.aiNotes ?? "-"}
Excerpt      :
${i.bestConversation.excerpt}`
    : "Tidak ada data percakapan.";

  const worstBlock = i.worstConversation
    ? `ID           : ${i.worstConversation.id}
Skor         : ${i.worstConversation.score ?? "-"} / 100
Avg balas    : ${min(i.worstConversation.avgResponseMinutes)} menit
Ada komplain : ${yn(i.worstConversation.hasComplaint)}, diselesaikan: ${yn(
        i.worstConversation.complaintResolved
      )}
Red flag     : ${
        i.worstConversation.redFlagTypes.length > 0
          ? i.worstConversation.redFlagTypes.join(", ")
          : "Tidak ada"
      }
Catatan AI   : ${i.worstConversation.aiNotes ?? "-"}
Excerpt      :
${i.worstConversation.excerpt}`
    : "Tidak ada data percakapan.";

  return `Buatkan coaching insight untuk agent CS berikut berdasarkan hasil penilaian periode ini.

=== IDENTITAS AGENT ===
Nama Agent  : ${i.agentName}
Role        : ${i.agentRole}
Periode     : ${i.periodStart} – ${i.periodEnd}

=== RINGKASAN SKOR PERIODE INI ===
Total Skor        : ${i.totalScore} / 100
Grade             : ${i.grade}
Kecepatan Balas   : ${i.scoreResponseTime} / ${i.weightResponseTime} (rata-rata waktu balas: ${min(
    i.avgResponseTimeMinutes
  )} menit, target: ${i.slaExcellentMinutes} menit)
Kualitas Bahasa   : ${i.scoreLanguageQuality} / ${i.weightLanguageQuality}
Ketepatan Jawaban : ${i.scoreAnswerQuality} / ${i.weightAnswerQuality}
Handling Komplain : ${i.scoreComplaintHandling} / ${i.weightComplaintHandling} (${
    i.totalComplaints
  } komplain, ${i.complaintsResolved} berhasil diselesaikan)
Chat Tak Terjawab : ${i.scoreMissedChat} / ${i.weightMissedChat} (${
    i.totalMissedChats
  } chat tidak terjawab dari ${i.totalCustomerMessages} total)

=== PERBANDINGAN TIM ===
Skor rata-rata tim    : ${i.teamAvgScore} / 100
Ranking agent di tim  : #${i.agentRank} dari ${i.totalAgents} agent
Rata-rata waktu balas tim : ${min(i.teamAvgResponseMinutes)} menit

=== RED FLAG DALAM PERIODE INI ===
Total red flag   : ${totalRf}
- customer_angry : ${rf.customer_angry ?? 0} kasus
- rude_language  : ${rf.rude_language ?? 0} kasus
- no_reply_critical : ${rf.no_reply_critical ?? 0} kasus (tidak dibalas >${
    i.slaCriticalMinutes
  } menit)
- customer_ignored : ${rf.customer_ignored ?? 0} kasus
- answer_caused_dropout : ${rf.answer_caused_dropout ?? 0} kasus

=== PERCAKAPAN TERBAIK (skor tertinggi) ===
${bestBlock}

=== PERCAKAPAN TERBURUK (skor terendah atau ada red flag critical) ===
${worstBlock}

Buatkan coaching insight dalam format JSON sesuai instruksi sistem.`;
}

// ===========================================================================
// Bagian IV — advanced-feature prompts (3–8). Each is independent and called
// after a job completes (3, 4, 6) or on demand (5, 7, 8).
// ===========================================================================

// ── Prompt 3 — Performance-decline alert (9.2). Output: JSON. ──────────────
export const ACR_SYSTEM_PROMPT_ALERT = `Kamu adalah AI Performance Monitor untuk sistem manajemen Customer Service.

Tugasmu: Menganalisa tren skor seorang agent CS selama beberapa periode terakhir dan menentukan apakah ada penurunan performa yang perlu mendapat perhatian supervisor.

ATURAN OUTPUT:
1. Respons HANYA dalam format JSON valid. Tidak ada teks di luar JSON.
2. Bahasa Indonesia untuk semua teks.
3. Jika tidak ada alert: kembalikan JSON dengan has_alert = false dan arrays kosong.

FORMAT JSON OUTPUT:
{
  "has_alert": true/false,
  "alerts": [
    {
      "alert_type": "<lihat tipe valid di bawah>",
      "severity": "critical | high | medium",
      "title": "<judul singkat alert, maks 60 karakter>",
      "description": "<penjelasan situasi yang spesifik dengan angka, maks 200 karakter>",
      "affected_dimensions": ["<nama dimensi yang paling terpengaruh>"],
      "recommendation": "<saran tindakan konkret untuk supervisor, maks 200 karakter>"
    }
  ],
  "trend_analysis": "<ringkasan tren keseluruhan agent dalam 1-2 kalimat>"
}

TIPE ALERT VALID:
- "score_drop_significant"  -> Skor turun > 10 poin dalam 1 periode
- "score_drop_consecutive"  -> Skor turun 3 periode berturut-turut
- "grade_downgrade"         -> Agent masuk grade lebih rendah (A->B, B->C, dst)
- "red_flag_spike"          -> Red flag naik > 50% dari periode sebelumnya
- "missed_chat_spike"       -> Chat tidak terjawab naik > 100% dari periode sebelumnya
- "below_target"            -> Skor di bawah target yang ditetapkan (jika ada target)

PANDUAN SEVERITY:
- critical: penurunan drastis (>15 poin), atau masuk Grade D/E, atau 3 periode turun berturut
- high: penurunan signifikan (10-15 poin), atau naik grade warning
- medium: penurunan 5-10 poin, atau tren memburuk tapi belum parah

CATATAN:
- Jika agent sedang membaik (tren naik): has_alert = false
- Jika fluktuasi minor (+/-5 poin) tanpa tren jelas: has_alert = false
- Sebutkan angka spesifik dalam description (bukan "turun signifikan" tapi "turun 13 poin")`;

export interface AlertPromptInput {
  agentName: string;
  role: string;
  targetScore: number | null;
  historyBlock: string; // one line per period: label | total | grade | dims
  redFlagBlock: string; // one line per period: label | total | by type
  latestLabel: string;
  latestScore: number;
  prevScore: number | null;
}

export function buildAlertUserPrompt(i: AlertPromptInput): string {
  return `Analisa tren performa agent CS berikut dan tentukan apakah ada alert yang perlu dikirim ke supervisor.

=== IDENTITAS AGENT ===
Nama: ${i.agentName}
Role: ${i.role}
Target Skor: ${i.targetScore ?? "Tidak ada target"}

=== HISTORI SKOR (urut dari terlama ke terbaru) ===
LABEL_PERIODE | TOTAL_SKOR | GRADE | KEC_BALAS | KUALITAS | KETEPATAN | KOMPLAIN | MISSED
${i.historyBlock}

=== RED FLAG COUNT PER PERIODE ===
LABEL_PERIODE | TOTAL | CUSTOMER_ANGRY | RUDE | NO_REPLY | IGNORED | DROPOUT
${i.redFlagBlock}

=== PERIODE TERBARU ===
Label: ${i.latestLabel}
Total Skor: ${i.latestScore}
Skor Sebelumnya: ${i.prevScore ?? "Tidak ada"}
Delta: ${i.prevScore == null ? "-" : (i.latestScore - i.prevScore).toFixed(1)}

Berikan analisa dalam format JSON sesuai instruksi sistem.`;
}

// ── Prompt 4 — Agent WhatsApp coaching (9.4). Output: plain text. ──────────
export const ACR_SYSTEM_PROMPT_WA_COACHING = `Kamu adalah AI Coach yang bertugas menulis pesan coaching personal untuk dikirim via WhatsApp kepada agent Customer Service setelah laporan kinerja mereka selesai.

Pesan ini harus:
1. Terasa personal dan hangat - bukan seperti laporan formal
2. Dimulai dengan hal positif sebelum masuk ke area perbaikan
3. Spesifik dengan angka dan contoh nyata
4. Actionable - bisa langsung dilakukan hari ini
5. Singkat - maksimal 250 kata, cocok dibaca di WhatsApp
6. Menggunakan emoji secukupnya (jangan berlebihan)
7. Tidak terasa seperti teguran atau hukuman

ATURAN OUTPUT:
- Respons HANYA teks pesan WhatsApp yang sudah jadi
- TIDAK ada JSON, TIDAK ada markdown, TIDAK ada preamble
- Langsung isi pesannya dari baris pertama

NADA BERDASARKAN GRADE:
- Grade A: Semangat tinggi, rayakan, challenge untuk pertahankan
- Grade B: Positif, acknowledge kerja keras, dorong ke A
- Grade C: Hangat tapi jujur, tekankan potensi, berikan langkah konkret
- Grade D: Empati penuh, tidak menghakimi, fokus 1 hal yang paling bisa diperbaiki cepat
- Grade E: Sangat supportif, acknowledge kesulitan, tawarkan bantuan supervisor`;

export interface WaCoachingPromptInput {
  agentName: string;
  periodLabel: string;
  grade: string;
  totalScore: number;
  prevScore: number | null;
  scoreLines: string; // preformatted dimension lines
  strongest: string;
  weakest: string;
  redFlagSummary: string;
  rank: number;
  totalAgents: number;
  teamAvg: number;
  improvements: string[];
}

export function buildWaCoachingUserPrompt(i: WaCoachingPromptInput): string {
  return `Tulis pesan coaching WhatsApp untuk agent CS berikut.

=== DATA AGENT ===
Nama: ${i.agentName}
Periode: ${i.periodLabel}
Grade: ${i.grade}
Total Skor: ${i.totalScore} / 100
Skor Periode Sebelumnya: ${i.prevScore ?? "-"} (delta: ${
    i.prevScore == null ? "-" : (i.totalScore - i.prevScore).toFixed(1)
  })

=== DETAIL SKOR ===
${i.scoreLines}

=== DIMENSI TERKUAT ===
${i.strongest}

=== DIMENSI PALING PERLU PERBAIKAN ===
${i.weakest}

=== RED FLAG PERIODE INI ===
${i.redFlagSummary}

=== RANKING DI TIM ===
Ranking: #${i.rank} dari ${i.totalAgents} agent
Rata-rata tim: ${i.teamAvg}

=== COACHING INSIGHT (dari AI sebelumnya) ===
${i.improvements.map((s, idx) => `${idx + 1}. ${s}`).join("\n") || "Tidak ada."}

Tulis pesan WhatsApp coaching langsung (tanpa JSON, tanpa preamble).`;
}

// ── Prompt 5 — Team-group WhatsApp summary (9.7). Output: plain text. ──────
export const ACR_SYSTEM_PROMPT_WA_GROUP = `Kamu adalah AI yang bertugas menulis ringkasan laporan kinerja tim CS untuk dikirim ke grup WhatsApp tim. Pesan ini dibaca oleh semua anggota tim sekaligus.

Pesan harus:
1. Singkat dan mudah dibaca di WA - maksimal 180 kata
2. Transparan tapi tidak mempermalukan - sebut nama untuk apresiasi, hati-hati saat menyebut nama untuk hal negatif
3. Memotivasi seluruh tim, bukan hanya individu
4. Menggunakan format WA yang rapi (bold dengan *asterisk*, newline)
5. Ada call-to-action di akhir

ATURAN OUTPUT:
- Respons HANYA teks pesan WhatsApp yang sudah jadi
- TIDAK ada JSON, TIDAK ada markdown, langsung isi pesannya dari baris pertama`;

export interface WaGroupPromptInput {
  teamName: string;
  periodLabel: string;
  totalAgents: number;
  teamAvg: number;
  prevTeamAvg: number | null;
  avgRt: number | null;
  totalMissed: number;
  bestName: string | null;
  bestScore: number | null;
  bestGrade: string | null;
  mostImprovedName: string | null;
  mostImprovedDelta: number | null;
  gradeDist: string;
  totalRedFlags: number;
  prevRedFlags: number | null;
  topRedFlagType: string;
  topRedFlagCount: number;
  weakestDim: string;
  belowSeventyCount: number;
}

export function buildWaGroupUserPrompt(i: WaGroupPromptInput): string {
  return `Tulis ringkasan laporan kinerja tim untuk grup WhatsApp.

=== INFO LAPORAN ===
Nama Tim: ${i.teamName}
Periode: ${i.periodLabel}
Total Agent Dinilai: ${i.totalAgents}

=== SKOR TIM ===
Rata-rata Skor Tim: ${i.teamAvg}
Skor Tim Periode Sebelumnya: ${i.prevTeamAvg ?? "-"}
Rata-rata Waktu Balas: ${i.avgRt ?? "-"} menit
Total Chat Tidak Terjawab: ${i.totalMissed}

=== AGENT TERBAIK ===
Nama: ${i.bestName ?? "-"} | Skor: ${i.bestScore ?? "-"} | Grade: ${i.bestGrade ?? "-"}

=== AGENT PALING MENINGKAT ===
Nama: ${i.mostImprovedName ?? "-"} | Delta: ${i.mostImprovedDelta ?? "-"}

=== DISTRIBUSI GRADE ===
${i.gradeDist}

=== RED FLAG SUMMARY ===
Total Red Flag: ${i.totalRedFlags} (sebelumnya: ${i.prevRedFlags ?? "-"})
Jenis Terbanyak: ${i.topRedFlagType} - ${i.topRedFlagCount} kasus

=== AREA YANG PERLU PERHATIAN TIM ===
Dimensi dengan skor rata-rata terendah: ${i.weakestDim}
Jumlah agent dengan skor di bawah 70: ${i.belowSeventyCount}

Tulis pesan WhatsApp grup langsung (tanpa JSON, tanpa preamble).`;
}

// ── Prompt 6 — Achievement detection (9.6). Output: JSON. ──────────────────
export const ACR_SYSTEM_PROMPT_ACHIEVEMENT = `Kamu adalah AI yang bertugas mengecek apakah seorang agent CS berhak mendapat achievement (pencapaian) baru berdasarkan histori kinerjanya.

ATURAN OUTPUT:
1. Respons HANYA dalam format JSON valid.
2. Bahasa Indonesia untuk semua teks.
3. Jika tidak ada achievement baru: kembalikan JSON dengan new_achievements = []

FORMAT JSON:
{
  "new_achievements": [
    {
      "achievement_id": "<kode unik dari daftar di bawah>",
      "achievement_name": "<nama achievement>",
      "achievement_icon": "<emoji>",
      "description": "<deskripsi singkat, maks 80 karakter>",
      "earned_at_period": "<label periode>"
    }
  ]
}

DAFTAR ACHIEVEMENT:
grade_a_first          | Bintang Pertama        | Grade A untuk pertama kali
grade_a_3_consecutive  | Trio Emas              | Grade A 3 periode berturut-turut
grade_a_5_consecutive  | Legenda Tim            | Grade A 5 periode berturut-turut
zero_red_flag          | Pelayanan Sempurna     | 0 red flag dalam 1 periode
zero_missed_chat       | Tak Satu Pun Terlewat  | 0 chat tidak terjawab dalam 1 periode
fastest_responder      | Kilat                  | Avg waktu balas < 2 menit dalam 1 periode
complaint_ace          | Penjinak Komplain      | 100% komplain selesai, min 3 komplain
top_performer_period   | CS Terbaik Periode Ini | Skor tertinggi di tim dalam 1 periode
most_improved          | Paling Giat Berkembang | Kenaikan skor terbesar dalam 1 periode
comeback               | Bangkit Lagi           | Naik dari Grade D/E ke B/A
perfect_week           | Minggu Sempurna        | Skor >95 dalam 1 periode weekly
language_master        | Pakar Bahasa           | Kualitas bahasa >23/25 dalam 3 periode

PENTING:
- Setiap achievement hanya 1 kali, KECUALI yang periodik (top_performer_period, most_improved, zero_red_flag, zero_missed_chat, fastest_responder)
- Cek daftar achievement yang sudah diraih dan jangan duplikasi
- grade_a_3_consecutive hanya trigger jika TIGA TERAKHIR berturut-turut Grade A`;

export interface AchievementPromptInput {
  agentName: string;
  periodLabel: string;
  totalScore: number;
  grade: string;
  avgRt: number | null;
  languageScore: number;
  languageMax: number;
  totalRedFlags: number;
  missedCount: number;
  totalComplaints: number;
  complaintsResolved: number;
  rank: number;
  totalAgents: number;
  mostImproved: boolean;
  improvedDelta: number | null;
  frequency: string;
  gradeHistoryBlock: string;
  existingAchievementIds: string[];
}

export function buildAchievementUserPrompt(i: AchievementPromptInput): string {
  return `Cek achievement baru untuk agent CS berikut.

=== IDENTITAS ===
Nama: ${i.agentName}
Periode Terbaru: ${i.periodLabel}
Frekuensi periode: ${i.frequency}

=== SKOR & GRADE TERBARU ===
Total Skor: ${i.totalScore}
Grade: ${i.grade}
Avg Waktu Balas: ${i.avgRt ?? "-"} menit
Kualitas Bahasa: ${i.languageScore} / ${i.languageMax}
Total Red Flag: ${i.totalRedFlags}
Total Chat Tidak Terjawab: ${i.missedCount}
Total Komplain: ${i.totalComplaints}, Selesai: ${i.complaintsResolved}
Ranking di Tim: #${i.rank} dari ${i.totalAgents}
Paling Meningkat: ${i.mostImproved ? "true" : "false"} (kenaikan: +${i.improvedDelta ?? 0})

=== HISTORI GRADE (urut terlama ke terbaru, maks 6 periode) ===
LABEL_PERIODE | GRADE | TOTAL_SKOR
${i.gradeHistoryBlock}

=== ACHIEVEMENT YANG SUDAH DIRAIH (jangan duplikasi) ===
${i.existingAchievementIds.join(", ") || "Belum ada achievement"}

Berikan daftar achievement BARU yang diraih dalam format JSON.`;
}

// ── Prompt 7 — Month-over-Month report (9.5). Output: JSON. ────────────────
export const ACR_SYSTEM_PROMPT_MOM = `Kamu adalah AI Analyst yang bertugas membuat analisa perbandingan kinerja tim CS antara dua periode (month-over-month atau week-over-week).

Analisa harus objektif dan berbasis data, mengidentifikasi pola dan sebab di balik perubahan, dan memberikan rekomendasi strategis yang actionable untuk manajemen.

ATURAN OUTPUT:
1. Respons HANYA dalam format JSON valid.
2. Bahasa Indonesia untuk semua teks.

FORMAT JSON:
{
  "overall_trend": "improving | declining | stable",
  "executive_summary": "<ringkasan 3-4 kalimat untuk management, spesifik dengan angka>",
  "key_improvements": [
    { "metric": "<nama metrik>", "change": "<perubahan dengan angka>", "possible_reason": "<analisa>" }
  ],
  "key_declines": [
    { "metric": "<nama metrik>", "change": "<perubahan dengan angka>", "possible_reason": "<analisa>", "recommendation": "<saran konkret>" }
  ],
  "agent_highlights": {
    "most_improved": { "name": "<nama>", "delta": "<+angka>", "note": "<konteks>" },
    "most_declined": { "name": "<nama>", "delta": "<-angka>", "note": "<konteks>" },
    "most_consistent": { "name": "<nama>", "note": "<mengapa konsisten>" }
  },
  "strategic_recommendations": ["<rekomendasi 1>", "<rekomendasi 2>", "<rekomendasi 3>"],
  "forecast": "<prediksi singkat jika tren berlanjut, 1-2 kalimat>"
}`;

export interface MomPromptInput {
  prevLabel: string;
  currLabel: string;
  prevBlock: string;
  currBlock: string;
  contextBlock: string;
}

export function buildMomUserPrompt(i: MomPromptInput): string {
  return `Buat analisa perbandingan kinerja tim CS antara dua periode berikut.

=== PERIODE SEBELUMNYA: ${i.prevLabel} ===
${i.prevBlock}

=== PERIODE TERBARU: ${i.currLabel} ===
${i.currBlock}

=== KONTEKS TAMBAHAN ===
${i.contextBlock || "Tidak ada konteks tambahan."}

Berikan analisa dalam format JSON sesuai instruksi sistem.`;
}

// ── Prompt 8 — Cross-team benchmark (9.3). Output: JSON. ───────────────────
export const ACR_SYSTEM_PROMPT_BENCHMARK = `Kamu adalah AI Analyst yang bertugas membuat analisa perbandingan kinerja antara dua atau lebih tim/shift CS dalam periode yang sama.

ATURAN OUTPUT:
1. Respons HANYA dalam format JSON valid.
2. Bahasa Indonesia untuk semua teks.
3. Analisa harus objektif dan tidak bias terhadap tim manapun.

FORMAT JSON:
{
  "period": "<label periode>",
  "teams_ranked": [
    {
      "rank": 1,
      "team_name": "<nama tim>",
      "avg_score": <angka>,
      "avg_response_time": <menit>,
      "total_red_flags": <angka>,
      "strengths": ["<kelebihan 1>", "<kelebihan 2>"],
      "weaknesses": ["<kelemahan 1>"]
    }
  ],
  "comparison_summary": "<ringkasan perbandingan 2-3 kalimat, objektif>",
  "gap_analysis": "<analisa mengapa ada selisih antar tim>",
  "cross_team_recommendations": ["<rekomendasi 1>", "<rekomendasi 2>"]
}`;

export interface BenchmarkPromptInput {
  periodLabel: string;
  teamsBlock: string;
  contextBlock: string;
}

export function buildBenchmarkUserPrompt(i: BenchmarkPromptInput): string {
  return `Buat analisa benchmark perbandingan antar tim CS berikut untuk periode ${i.periodLabel}.

${i.teamsBlock}

=== KONTEKS ===
${i.contextBlock || "Tidak ada konteks tambahan."}

Berikan analisa dalam format JSON sesuai instruksi sistem.`;
}
