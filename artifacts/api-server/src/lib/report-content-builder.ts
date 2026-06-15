import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  resolvePeriod,
  computeSummary,
  computeAiPerformance,
  type PeriodKey,
} from "./analytics-v2-metrics";
import type { ReportFrequency } from "./report-schedule-build";

// Builds the email body for a scheduled report from the chosen content types.
// Pure HTML/text — delivered inline (no PDF dependency). Period is derived from
// the schedule cadence.

const ID_MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

function fmtDateTime(d: Date): string {
  // DD MMM YYYY, HH:mm in WIB.
  const w = new Date(d.getTime() + 7 * 3600 * 1000);
  const hh = String(w.getUTCHours()).padStart(2, "0");
  const mm = String(w.getUTCMinutes()).padStart(2, "0");
  return `${w.getUTCDate()} ${ID_MONTHS[w.getUTCMonth()]} ${w.getUTCFullYear()}, ${hh}.${mm}`;
}

function periodForFrequency(freq: ReportFrequency): PeriodKey {
  if (freq === "weekly") return "7d";
  if (freq === "monthly") return "30d";
  return "today";
}

function fmtSeconds(sec: number): string {
  if (sec < 60) return `${sec} dtk`;
  return `${Math.round(sec / 60)} mnt`;
}

function changeLabel(change: number): string {
  if (change === 0) return "0%";
  return `${change > 0 ? "▲" : "▼"} ${Math.abs(change)}%`;
}

export interface BuiltReport {
  subject: string;
  html: string;
  text: string;
}

export async function buildReportContent(opts: {
  ownerUserId: number;
  scheduleName: string;
  contentTypes: string[];
  frequency: ReportFrequency;
  now?: Date;
}): Promise<BuiltReport> {
  const now = opts.now ?? new Date();
  const periodKey = periodForFrequency(opts.frequency);
  const p = resolvePeriod(periodKey, undefined, undefined, now);

  const sections: string[] = [];
  const textParts: string[] = [];

  if (opts.contentTypes.includes("kpi") || opts.contentTypes.includes("trend")) {
    const summary = await computeSummary(opts.ownerUserId, p);
    if (opts.contentTypes.includes("kpi")) {
      sections.push(`
        <h3 style="margin:24px 0 8px">Ringkasan KPI</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${row("Total chat masuk", String(summary.totalChats))}
          ${row("Ditangani AI", `${summary.aiHandledRate}% (${summary.aiHandledCount})`)}
          ${row("Avg. waktu respons", fmtSeconds(summary.avgResponseTimeSeconds))}
          ${row("Belum dibalas", String(summary.unrepliedCount))}
        </table>`);
      textParts.push(
        `RINGKASAN KPI\nTotal chat: ${summary.totalChats}\nDitangani AI: ${summary.aiHandledRate}% (${summary.aiHandledCount})\nAvg respons: ${fmtSeconds(summary.avgResponseTimeSeconds)}\nBelum dibalas: ${summary.unrepliedCount}`,
      );
    }
    if (opts.contentTypes.includes("trend")) {
      sections.push(`
        <h3 style="margin:24px 0 8px">Tren vs periode sebelumnya</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${row("Total chat", changeLabel(summary.totalChatsChange))}
          ${row("Waktu respons", changeLabel(summary.avgResponseTimeChange))}
        </table>`);
      textParts.push(`TREN\nTotal chat: ${changeLabel(summary.totalChatsChange)}\nWaktu respons: ${changeLabel(summary.avgResponseTimeChange)}`);
    }
  }

  if (opts.contentTypes.includes("ai_analysis")) {
    const ai = await computeAiPerformance(opts.ownerUserId, p);
    const topics = ai.topEscalationTopics.map((t) => `<li>${escapeHtml(t.topic)} — ${t.count} (${t.escalationRate}%)</li>`).join("");
    sections.push(`
      <h3 style="margin:24px 0 8px">Analisa Percakapan AI</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        ${row("Diselesaikan AI", `${ai.resolvedByAi}%`)}
        ${row("Dieskalasi ke agent", `${ai.escalatedToAgent}% (${ai.escalatedCount})`)}
        ${row("Avg. panjang sesi", `${ai.avgSessionLength} pesan`)}
        ${row("Token AI dipakai", ai.tokensUsed.toLocaleString("id-ID"))}
      </table>
      ${topics ? `<p style="margin:12px 0 4px;font-weight:600">Topik paling sering dieskalasi:</p><ul style="margin:0;padding-left:18px">${topics}</ul>` : ""}`);
    textParts.push(
      `ANALISA AI\nDiselesaikan AI: ${ai.resolvedByAi}%\nDieskalasi: ${ai.escalatedToAgent}% (${ai.escalatedCount})\nAvg sesi: ${ai.avgSessionLength} pesan\nToken: ${ai.tokensUsed}`,
    );
  }

  if (opts.contentTypes.includes("chat_history")) {
    const rowsRes = await db.execute(sql`
      SELECT c.contact_name, ch.label AS channel_name, c.status, c.last_message_at
      FROM chats c JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.user_id = ${opts.ownerUserId}
        AND EXISTS (SELECT 1 FROM chat_messages cm WHERE cm.chat_id = c.id
                    AND cm.created_at >= ${p.start.toISOString()} AND cm.created_at < ${p.end.toISOString()})
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 20
    `);
    const rows = rowsRes.rows as Array<{ contact_name: string; channel_name: string; status: string; last_message_at: string | null }>;
    const trs = rows
      .map(
        (r) => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(r.contact_name)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(r.channel_name)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(r.status)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${r.last_message_at ? fmtDateTime(new Date(r.last_message_at)) : "-"}</td>
        </tr>`,
      )
      .join("");
    sections.push(`
      <h3 style="margin:24px 0 8px">Riwayat Chat (20 terbaru)</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="text-align:left;color:#666">
          <th style="padding:6px 8px">Kontak</th><th style="padding:6px 8px">Channel</th>
          <th style="padding:6px 8px">Status</th><th style="padding:6px 8px">Terakhir</th>
        </tr>${trs || `<tr><td colspan="4" style="padding:8px;color:#999">Tidak ada percakapan.</td></tr>`}
      </table>`);
    textParts.push(`RIWAYAT CHAT: ${rows.length} percakapan terbaru (lihat versi HTML).`);
  }

  const subject = `${opts.scheduleName} — ${fmtDateTime(now)}`;
  const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;color:#222">
      <h2 style="color:#ea580c;margin-bottom:4px">${escapeHtml(opts.scheduleName)}</h2>
      <p style="color:#666;font-size:13px;margin-top:0">Periode: ${p.label} · ${fmtDateTime(now)} WIB</p>
      ${sections.join("\n")}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Laporan otomatis dari MaxiChat · Laporan &amp; Jadwal</p>
    </div>`;
  const text = `${opts.scheduleName}\nPeriode: ${p.label} · ${fmtDateTime(now)} WIB\n\n${textParts.join("\n\n")}\n\n— MaxiChat`;

  return { subject, html, text };
}

function row(label: string, value: string): string {
  return `<tr><td style="padding:6px 8px;border-bottom:1px solid #eee;color:#666">${label}</td><td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${escapeHtml(value)}</td></tr>`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
