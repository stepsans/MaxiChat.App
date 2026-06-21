import { Router } from "express";
import type { Request, Response } from "express";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { requirePermission } from "../lib/role-permissions";
import { getAllowedChannelIds } from "../lib/user-channel-access";
import { getSystemHealth } from "../lib/system-health";
import { getCachedTopQuestions } from "../lib/dashboard-insights";
import { buildDrillPdf, buildDrillCsv } from "../lib/dashboard-pdf";
import {
  type DashboardRange,
  conversationCount,
  waitingCompanyCount,
  avgFirstResponseSeconds,
  aiHandledPercent,
  myActiveChatCount,
  hotLeadCount,
  dissatisfiedCount,
  leadStatusCounts,
  drillList,
  flowMenuRanking,
  ownerHasActiveFlow,
  wonMetric,
  productRanking,
  chatVolumeByHour,
  aiVsHumanCounts,
} from "../lib/dashboard-metrics";

// Parse ?from&to (ISO) into a range; default = today (local midnight → now).
function parseRange(req: Request): DashboardRange {
  const now = new Date();
  const fromRaw = typeof req.query.from === "string" ? new Date(req.query.from) : null;
  const toRaw = typeof req.query.to === "string" ? new Date(req.query.to) : null;
  const from =
    fromRaw && !Number.isNaN(fromRaw.getTime())
      ? fromRaw
      : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = toRaw && !Number.isNaN(toRaw.getTime()) ? toRaw : now;
  return { from, to };
}

// Unified Dashboard API (spec §3.2). All endpoints scope to the tenant owner and
// honour the requester's allowed channels. Money/credit signals are hidden from
// non-owner roles.
const router: Router = Router();

// GET /dashboard/system-health — channel connectivity, AI engine failover,
// scheduled jobs, AI credit (spec A.9). Strip is shown to anyone who can view the
// dashboard; the AI credit figure is included only for the tenant owner.
router.get(
  "/system-health",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const allowedChannelIds = await getAllowedChannelIds(uid);
    const health = await getSystemHealth({
      ownerUserId,
      allowedChannelIds,
      includeCredit: uid === ownerUserId,
    });
    res.json(health);
  }
);

// GET /dashboard/summary — KPI cards for the range (spec 5.1). Owner-only signals
// (lead panas, customer tidak puas) are included for the owner; CS-operational
// signals for everyone who can view. Money cards (Won) land in a later phase.
router.get(
  "/summary",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const allowed = await getAllowedChannelIds(uid);
    const range = parseRange(req);
    const isOwner = uid === ownerUserId;

    const [percakapan, belumDibalas, avgFrt, aiPct, myActive, leadStatus] = await Promise.all([
      conversationCount(allowed, range),
      waitingCompanyCount(allowed),
      avgFirstResponseSeconds(allowed, range),
      aiHandledPercent(allowed, range),
      myActiveChatCount(allowed, uid),
      leadStatusCounts(allowed, range),
    ]);

    // Owner-facing AI + money signals.
    const [leadPanas, tidakPuas, won] = isOwner
      ? await Promise.all([
          hotLeadCount(allowed, range),
          dissatisfiedCount(allowed, range),
          wonMetric(allowed, range),
        ])
      : [null, null, null];

    res.json({
      role: isOwner ? "owner" : "cs",
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      percakapan,
      belum_dibalas: belumDibalas,
      avg_frt_seconds: avgFrt,
      ai_handled_percent: aiPct,
      my_active: myActive,
      lead_panas: leadPanas,
      tidak_puas: tidakPuas,
      won,
      lead_status: leadStatus,
    });
  }
);

// GET /dashboard/lead-status — counts per lead_status (spec A.7).
router.get(
  "/lead-status",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const allowed = await getAllowedChannelIds(uid);
    const counts = await leadStatusCounts(allowed, parseRange(req));
    res.json(counts);
  }
);

// GET /dashboard/tier2/chat — dense Chat module dashboard (spec A.10): KPI +
// inbound volume per hour + AI-vs-human reply split.
router.get(
  "/tier2/chat",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const allowed = await getAllowedChannelIds(uid);
    const range = parseRange(req);
    const [percakapan, avgFrt, aiPct, waiting, volumeByHour, aiVsHuman] =
      await Promise.all([
        conversationCount(allowed, range),
        avgFirstResponseSeconds(allowed, range),
        aiHandledPercent(allowed, range),
        waitingCompanyCount(allowed),
        chatVolumeByHour(allowed, range),
        aiVsHumanCounts(allowed, range),
      ]);
    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      kpi: {
        percakapan,
        avg_frt_seconds: avgFrt,
        ai_handled_percent: aiPct,
        belum_dibalas: waiting,
      },
      volume_by_hour: volumeByHour,
      ai_vs_human: aiVsHuman,
    });
  }
);

// GET /dashboard/top-questions — cached free-text intent clustering (spec A.3 /
// 3.4). Snapshot is scheduled (every 6h), not computed per request.
router.get(
  "/top-questions",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    res.json(await getCachedTopQuestions(ownerUserId));
  }
);

// GET /dashboard/products — most-requested products (spec A.3).
router.get(
  "/products",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const allowed = await getAllowedChannelIds(uid);
    const rows = await productRanking(allowed, parseRange(req));
    res.json({ rows });
  }
);

// GET /dashboard/flow-menu — pressed chatbot menu options (spec A.4). Returns
// hasActiveFlow so the panel can show an "activate a flow" hint when empty.
router.get(
  "/flow-menu",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(uid);
    const allowed = await getAllowedChannelIds(uid);
    const range = parseRange(req);
    const [hasActiveFlow, rows] = await Promise.all([
      ownerHasActiveFlow(ownerUserId),
      flowMenuRanking(allowed, range),
    ]);
    res.json({ hasActiveFlow, rows });
  }
);

const METRIC_TITLES: Record<string, string> = {
  conversations: "Percakapan",
  waiting: "Belum Dibalas",
  my_active: "Chat Aktif Saya",
  lead: "Leads",
  not_lead: "Not Leads",
  unknown: "Unknown",
};

// GET /dashboard/export?metric&from&to&format=csv|pdf — downloadable report of a
// drill-down list (spec 5.1 / 7). Binary/CSV, deliberately not in OpenAPI.
router.get(
  "/export",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const allowed = await getAllowedChannelIds(uid);
    const range = parseRange(req);
    const metric = String(req.query.metric ?? "conversations");
    const format = String(req.query.format ?? "csv").toLowerCase();
    const rows = await drillList(metric, allowed, range, uid);
    const title = METRIC_TITLES[metric] ?? "Dashboard";
    const base = `${metric}-${range.from.toISOString().slice(0, 10)}`;

    if (format === "pdf") {
      const pdf = await buildDrillPdf(title, range, rows);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${base}.pdf"`);
      res.end(Buffer.from(pdf));
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
    res.send(buildDrillCsv(rows));
  }
);

// GET /dashboard/drill/:metric — the list behind a KPI card (spec 5.1).
router.get(
  "/drill/:metric",
  requirePermission("dashboard", "view"),
  async (req: Request, res: Response): Promise<void> => {
    const uid = getSessionUserId(req)!;
    const allowed = await getAllowedChannelIds(uid);
    const metric = String(req.params.metric);
    const rows = await drillList(metric, allowed, parseRange(req), uid);
    res.json({ metric, rows });
  }
);

export default router;
