// AI Chat Report — PDF export (Section 8 of the ACR spec).
// Built with pdf-lib like invoice-pdf.ts (pdfkit/Puppeteer can't run in this
// deploy environment). Page plan: cover → executive summary → one page per
// agent → full red-flag log.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { AcrAgentScoreRow, AcrJobRow, AcrRedFlagRow } from "@workspace/db";

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const dateFmt = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "long",
  year: "numeric",
});

const dateTimeFmt = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const VIOLATION_LABEL: Record<string, string> = {
  customer_angry: "Customer Marah",
  rude_language: "Bahasa Tidak Sopan",
  no_reply_critical: "Tidak Dibalas",
  customer_ignored: "Customer Dicuekin",
  answer_caused_dropout: "Jawaban Menyebabkan Dropout",
};

// Helvetica is WinAnsi-only — strip characters pdf-lib cannot encode
// (emoji, bullets from AI output) instead of throwing mid-render.
function safe(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/•/g, "-")
    .replace(/[^\x20-\x7E -ÿ\n]/g, "")
    .trim();
}

function fmtDate(d: string): string {
  return dateFmt.format(new Date(`${d}T00:00:00+07:00`));
}

export interface AcrPdfData {
  job: AcrJobRow;
  agents: AcrAgentScoreRow[];
  redFlags: AcrRedFlagRow[];
  businessName: string;
  generatedByName: string;
  includeRedFlags: boolean;
  includeCoaching: boolean;
}

export async function buildAcrPdf(data: AcrPdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 48;

  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.42, 0.46, 0.52);
  const accent = rgb(0.15, 0.42, 0.65);
  const lineColor = rgb(0.85, 0.87, 0.9);
  const danger = rgb(0.78, 0.18, 0.18);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  };
  const ensure = (needed: number) => {
    if (y - needed < MARGIN) newPage();
  };
  const text = (
    s: string,
    x: number,
    size: number,
    f: PDFFont = font,
    color = ink
  ) => page.drawText(safe(s), { x, y, size, font: f, color });
  const line = () => {
    page.drawLine({
      start: { x: MARGIN, y: y },
      end: { x: PAGE_W - MARGIN, y: y },
      thickness: 0.7,
      color: lineColor,
    });
  };
  const wrap = (s: string, size: number, maxWidth: number, f: PDFFont = font): string[] => {
    const words = safe(s).split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const cand = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(cand, size) > maxWidth && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = cand;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const paragraph = (s: string, size: number, color = ink, indent = 0) => {
    for (const raw of safe(s).split("\n")) {
      for (const ln of wrap(raw, size, PAGE_W - 2 * MARGIN - indent)) {
        ensure(size + 6);
        text(ln, MARGIN + indent, size, font, color);
        y -= size + 4;
      }
    }
  };

  const periodLabel = `${fmtDate(data.job.periodStart)} - ${fmtDate(data.job.periodEnd)}`;

  // ── Halaman 1: Cover ──────────────────────────────────────────────────
  y = PAGE_H - 240;
  text(data.businessName || "MaxiChat", MARGIN, 22, fontBold, accent);
  y -= 70;
  text("LAPORAN KINERJA TIM CS", MARGIN, 28, fontBold);
  y -= 34;
  text("AI Chat Report", MARGIN, 18, font, muted);
  y -= 70;
  text(`Periode: ${periodLabel}`, MARGIN, 13);
  y -= 22;
  text(
    `Dibuat oleh: ${data.generatedByName} pada ${dateFmt.format(new Date())}`,
    MARGIN,
    13
  );
  y -= 22;
  text(`Tenant: ${data.businessName || "-"}`, MARGIN, 13);

  // ── Halaman 2: Ringkasan Eksekutif ────────────────────────────────────
  newPage();
  text("Ringkasan Eksekutif", MARGIN, 18, fontBold);
  y -= 14;
  line();
  y -= 24;

  const sorted = [...data.agents].sort(
    (a, b) => Number(b.totalScore) - Number(a.totalScore)
  );
  const avg =
    sorted.length > 0
      ? sorted.reduce((a, s) => a + Number(s.totalScore), 0) / sorted.length
      : 0;
  const best = sorted[0];
  const cfg = data.job.configSnapshot as Record<string, number>;
  const cThreshold = Number(cfg.gradeCThreshold ?? 60);
  const needsAttention = sorted.filter((s) => Number(s.totalScore) < cThreshold).length;

  const metrics: Array<[string, string]> = [
    ["Rata-rata skor tim", `${avg.toFixed(1)} / 100`],
    [
      "Agent nilai terbaik",
      best ? `${safe(best.agentName) || "-"} (${Number(best.totalScore).toFixed(1)})` : "-",
    ],
    ["Perlu perhatian", `${needsAttention} agent skor < ${cThreshold}`],
    ["Total red flag", `${data.redFlags.length} pelanggaran`],
  ];
  for (const [k, v] of metrics) {
    text(k, MARGIN, 11, font, muted);
    text(v, MARGIN + 200, 11, fontBold);
    y -= 18;
  }

  y -= 14;
  text("Distribusi Grade", MARGIN, 13, fontBold);
  y -= 20;
  for (const g of ["A", "B", "C", "D", "E"] as const) {
    const n = sorted.filter((s) => s.grade === g).length;
    text(`Grade ${g}`, MARGIN, 11, font, muted);
    const barW = sorted.length > 0 ? (n / sorted.length) * 200 : 0;
    if (barW > 0) {
      page.drawRectangle({
        x: MARGIN + 70,
        y: y - 2,
        width: barW,
        height: 9,
        color: accent,
      });
    }
    text(`${n} agent`, MARGIN + 70 + Math.max(barW, 0) + 8, 11);
    y -= 18;
  }

  const topBottom = (label: string, list: AcrAgentScoreRow[]) => {
    y -= 14;
    ensure(80);
    text(label, MARGIN, 13, fontBold);
    y -= 18;
    for (const s of list) {
      text(
        `${safe(s.agentName) || s.agentEmail || "-"} — ${Number(s.totalScore).toFixed(
          1
        )} (Grade ${s.grade})`,
        MARGIN + 10,
        11
      );
      y -= 16;
    }
  };
  topBottom("Top 3 Performer", sorted.slice(0, 3));
  topBottom("Bottom 3 Performer", sorted.slice(-3).reverse());

  // ── Halaman 3–N: Per Agent ────────────────────────────────────────────
  const w = (k: string): number => Number(cfg[k] ?? 0);
  for (const s of sorted) {
    newPage();
    text(safe(s.agentName) || s.agentEmail || "-", MARGIN, 18, fontBold);
    const right = `Grade ${s.grade}  -  ${IDR.format(s.allowanceAmount)}`;
    page.drawText(safe(right), {
      x: PAGE_W - MARGIN - fontBold.widthOfTextAtSize(safe(right), 13),
      y,
      size: 13,
      font: fontBold,
      color: accent,
    });
    y -= 18;
    text(`${s.agentRole} - ${s.agentEmail ?? ""}`, MARGIN, 10, font, muted);
    y -= 14;
    line();
    y -= 26;

    text(`Skor Total: ${Number(s.totalScore).toFixed(1)} / 100`, MARGIN, 15, fontBold);
    y -= 26;

    text("Breakdown:", MARGIN, 12, fontBold);
    y -= 18;
    const rows: Array<[string, string, string]> = [
      [
        "Kecepatan Balas",
        `${Number(s.scoreResponseTime).toFixed(1)} / ${w("weightResponseTime")}`,
        s.avgResponseTimeMinutes != null
          ? `(avg ${Math.round(Number(s.avgResponseTimeMinutes))} mnt)`
          : "",
      ],
      [
        "Kualitas Bahasa",
        `${Number(s.scoreLanguageQuality).toFixed(1)} / ${w("weightLanguageQuality")}`,
        "",
      ],
      [
        "Ketepatan Jawaban",
        `${Number(s.scoreAnswerQuality).toFixed(1)} / ${w("weightAnswerQuality")}`,
        "",
      ],
      [
        "Handling Komplain",
        `${Number(s.scoreComplaintHandling).toFixed(1)} / ${w("weightComplaintHandling")}`,
        s.totalComplaints > 0
          ? `(${s.totalComplaints} komplain, ${Math.round(
              (s.complaintsResolved / s.totalComplaints) * 100
            )}% selesai)`
          : "(tidak ada komplain)",
      ],
      [
        "Chat Tak Terjawab",
        `${Number(s.scoreMissedChat).toFixed(1)} / ${w("weightMissedChat")}`,
        `(${s.totalMissedChats} chat)`,
      ],
    ];
    for (const [k, v, extra] of rows) {
      text(k, MARGIN + 10, 11, font, muted);
      text(v, MARGIN + 160, 11);
      if (extra) text(extra, MARGIN + 250, 11, font, muted);
      y -= 16;
    }

    y -= 10;
    text("Raw Metrics:", MARGIN, 12, fontBold);
    y -= 18;
    text(
      `${s.totalConversations} percakapan - ${s.totalMessagesSent} pesan dikirim - ${s.totalMissedChats} chat tidak terjawab` +
        (s.insufficientData ? "  (data < 5 percakapan)" : ""),
      MARGIN + 10,
      11
    );
    y -= 24;

    if (s.aiSummary) {
      text("AI Summary:", MARGIN, 12, fontBold);
      y -= 16;
      paragraph(s.aiSummary, 10, ink, 10);
      y -= 8;
    }
    if (data.includeCoaching && s.coachingInsights?.top_improvements?.length) {
      ensure(60);
      text("Coaching — 3 Hal Utama yang Perlu Diperbaiki:", MARGIN, 12, fontBold);
      y -= 16;
      for (const [i, item] of s.coachingInsights.top_improvements.entries()) {
        paragraph(`${i + 1}. ${item}`, 10, ink, 10);
      }
      y -= 8;
    }

    const agentFlags = data.redFlags.filter((f) => f.agentUserId === s.agentUserId);
    if (data.includeRedFlags && agentFlags.length > 0) {
      ensure(50);
      text(`Red Flag: ${agentFlags.length} pelanggaran`, MARGIN, 12, fontBold, danger);
      y -= 18;
      for (const f of agentFlags.slice(0, 8)) {
        ensure(18);
        const when = f.occurredAt ? dateTimeFmt.format(f.occurredAt) : "-";
        text(
          `${when} | ${VIOLATION_LABEL[f.violationType] ?? f.violationType} | ${
            safe(f.contactName) || "-"
          }`,
          MARGIN + 10,
          10
        );
        y -= 14;
      }
      if (agentFlags.length > 8) {
        text(`… +${agentFlags.length - 8} lainnya`, MARGIN + 10, 10, font, muted);
        y -= 14;
      }
    }
  }

  // ── Halaman terakhir: Log Red Flag Lengkap ────────────────────────────
  if (data.includeRedFlags && data.redFlags.length > 0) {
    newPage();
    text("Log Red Flag Lengkap", MARGIN, 18, fontBold);
    y -= 14;
    line();
    y -= 22;
    for (const f of data.redFlags) {
      ensure(60);
      const when = f.occurredAt ? dateTimeFmt.format(f.occurredAt) : "-";
      text(
        `${when} | ${safe(f.agentName) || "-"} | ${safe(f.contactName) || "-"} | ${
          f.channelType ?? "-"
        }`,
        MARGIN,
        10,
        fontBold
      );
      y -= 14;
      text(
        `${VIOLATION_LABEL[f.violationType] ?? f.violationType} — ${f.violationSeverity}`,
        MARGIN,
        10,
        font,
        danger
      );
      y -= 14;
      paragraph(f.aiExplanation, 9, muted);
      y -= 10;
    }
  }

  return doc.save();
}

// ── CSV export (one row per agent) ─────────────────────────────────────────

export function buildAcrCsv(job: AcrJobRow, agents: AcrAgentScoreRow[]): string {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "Agent",
    "Email",
    "Role",
    "Total Skor",
    "Grade",
    "Kecepatan Balas",
    "Kualitas Bahasa",
    "Ketepatan Jawaban",
    "Handling Komplain",
    "Chat Tak Terjawab",
    "Avg Waktu Balas (mnt)",
    "Total Percakapan",
    "Pesan Dikirim",
    "Chat Tidak Terjawab",
    "Komplain",
    "Komplain Selesai",
    "Red Flag",
    "Tunjangan (Rp)",
    "Periode Mulai",
    "Periode Selesai",
  ];
  const rows = agents.map((s) =>
    [
      s.agentName ?? "",
      s.agentEmail ?? "",
      s.agentRole,
      Number(s.totalScore).toFixed(2),
      s.grade,
      Number(s.scoreResponseTime).toFixed(2),
      Number(s.scoreLanguageQuality).toFixed(2),
      Number(s.scoreAnswerQuality).toFixed(2),
      Number(s.scoreComplaintHandling).toFixed(2),
      Number(s.scoreMissedChat).toFixed(2),
      s.avgResponseTimeMinutes != null
        ? Number(s.avgResponseTimeMinutes).toFixed(1)
        : "",
      s.totalConversations,
      s.totalMessagesSent,
      s.totalMissedChats,
      s.totalComplaints,
      s.complaintsResolved,
      s.redFlagCount,
      s.allowanceAmount,
      job.periodStart,
      job.periodEnd,
    ]
      .map(esc)
      .join(",")
  );
  return [header.map(esc).join(","), ...rows].join("\n");
}
