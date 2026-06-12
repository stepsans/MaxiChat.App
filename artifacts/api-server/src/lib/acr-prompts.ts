// AI Chat Report — prompt templates (Bagian II of the ACR spec, v2.0).
// db-free so prompt-building stays unit-testable.

import { capTranscriptMessages, formatWibTimestamp, type AcrMessage } from "./acr-build";

// ─── PROMPT 1 — Analisa Per Percakapan ──────────────────────────────────────

export const ACR_SYSTEM_PROMPT_CONVERSATION = `Kamu adalah AI Quality Analyst khusus untuk mengevaluasi kualitas pelayanan tim Customer Service (CS) sebuah bisnis.

Tugasmu adalah menganalisa percakapan chat antara agent CS dengan customer, lalu memberikan penilaian objektif berdasarkan panduan yang sudah ditetapkan.

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
      const sender =
        m.direction === "inbound"
          ? "Customer"
          : m.isAiGenerated
            ? "Agent (AI otomatis)"
            : `Agent (${input.agentName})`;
      const body = (m.content ?? "").trim() || "[pesan media]";
      return `${time} | ${sender}: ${body}`;
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
Rata-rata waktu balas agent dalam percakapan ini: ${
    input.avgResponseMinutes != null ? Math.round(input.avgResponseMinutes) : "-"
  } menit
Pesan customer yang tidak terjawab: ${input.hasMissedMessage ? "ADA" : "TIDAK ADA"}

=== KONTEKS BISNIS ===
Bisnis    : ${input.businessName ?? "Tidak diketahui"}
Produk/Layanan yang dijual: ${input.productCatalog ?? "Tidak diketahui"}

=== TRANSCRIPT PERCAKAPAN ===
${transcript}
=== AKHIR TRANSCRIPT ===

Berikan analisa dalam format JSON sesuai instruksi sistem.`;
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
