import { Router } from "express";
import { computeFinops } from "../lib/finops";

// Admin-only invoice-grounded financial metrics (Billing v2 — FASE H). Mounted
// under /admin AFTER requireAdmin (platform admin). Computes MRR/ARR/ARPU,
// billings (cash collected), recognized revenue, and churn from the immutable
// invoices ledger over a rolling window (default 30 days).
const router = Router();

router.get("/finops", async (req, res): Promise<void> => {
  try {
    const raw = req.query.periodDays;
    let periodDays = 30;
    if (typeof raw === "string" && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && n <= 366) periodDays = n;
    }
    const summary = await computeFinops(periodDays);
    res.json(summary);
  } catch (err) {
    req.log.error({ err }, "adminGetFinops failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
