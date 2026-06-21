import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { DrillRow } from "./dashboard-metrics";

// Generic dashboard drill-down → PDF table (spec 5.1 / 7 Export). Built with
// pdf-lib (StandardFonts only, no embedded TTF), so all text must be reduced to
// a WinAnsi-encodable subset first.
const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 40;

// Keep only WinAnsi-encodable code points (ASCII printable + Latin-1 letters,
// excluding the undefined 0x80-0x9F block) so pdf-lib drawText never throws on
// emoji / CJK / control characters in real-world names and messages.
function safe(s: string): string {
  let out = "";
  for (const ch of s ?? "") {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) out += ch;
  }
  return out.trim();
}

function truncate(s: string, max: number): string {
  const t = safe(s);
  return t.length > max ? t.slice(0, max - 1) + "..." : t;
}

export async function buildDrillPdf(
  title: string,
  range: { from: Date; to: Date },
  rows: DrillRow[]
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.42, 0.46, 0.52);
  const line = rgb(0.85, 0.87, 0.9);

  // Columns: #, Nama, Telepon, Status, Lead.
  const cols = [
    { label: "#", x: MARGIN },
    { label: "Nama", x: MARGIN + 24 },
    { label: "Telepon", x: MARGIN + 194 },
    { label: "Status", x: MARGIN + 304 },
    { label: "Lead", x: MARGIN + 414 },
  ];

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (s: string, x: number, yy: number, size: number, f: PDFFont, color = ink) =>
    page.drawText(safe(s), { x, y: yy, size, font: f, color });

  // Header
  text(title, MARGIN, y, 16, bold);
  y -= 18;
  const fmtDate = (d: Date) => d.toLocaleDateString("id-ID", { dateStyle: "medium" });
  text(`${fmtDate(range.from)} - ${fmtDate(range.to)} . ${rows.length} baris`, MARGIN, y, 9, font, muted);
  y -= 22;

  const drawHeaderRow = () => {
    for (const c of cols) text(c.label, c.x, y, 9, bold, muted);
    y -= 4;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: PAGE_W - MARGIN, y },
      thickness: 0.7,
      color: line,
    });
    y -= 12;
  };
  drawHeaderRow();

  rows.forEach((r, i) => {
    if (y < MARGIN + 20) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawHeaderRow();
    }
    text(String(i + 1), cols[0]!.x, y, 9, font, muted);
    text(truncate(r.contactName || r.phoneNumber || "-", 32), cols[1]!.x, y, 9, font);
    text(truncate(r.phoneNumber || "-", 20), cols[2]!.x, y, 9, font);
    text(truncate(r.status || "-", 20), cols[3]!.x, y, 9, font);
    text(truncate(r.leadStatus || "-", 16), cols[4]!.x, y, 9, font);
    y -= 15;
  });

  return doc.save();
}

// CSV sibling (server-side, mirrors the client-side export for parity).
export function buildDrillCsv(rows: DrillRow[]): string {
  const headers = ["Nama", "Telepon", "Status", "Lead Status", "Pesan Terakhir", "Waktu"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    headers.join(","),
    ...rows.map((r) =>
      [r.contactName, r.phoneNumber, r.status, r.leadStatus, r.lastMessage, r.lastMessageAt]
        .map(esc)
        .join(",")
    ),
  ];
  return "﻿" + lines.join("\r\n");
}
