import { Router } from "express";
import { AdminUpdateDunningSettingsBody } from "@workspace/api-zod";
import {
  getDunningSettings,
  updateDunningSettings,
} from "../lib/dunning-config";

// Admin-only dunning (overdue-invoice escalation) policy (Billing v2 — FASE F).
// Mounted under /admin AFTER requireAdmin (platform admin). Inert by default
// (enabled=false) so prepaid tenants are never auto-suspended until the operator
// turns it on. Days are counted from each invoice's due date.
const router = Router();

router.get("/dunning-settings", async (req, res): Promise<void> => {
  try {
    const config = await getDunningSettings();
    res.json({ enabled: config.enabled, ...config.schedule });
  } catch (err) {
    req.log.error({ err }, "adminGetDunningSettings failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/dunning-settings", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdateDunningSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input dunning tidak valid" });
      return;
    }
    // OpenAPI `integer` codegens to zod.number() (accepts decimals) — re-check
    // every day field is a whole non-negative number.
    const dayFields = {
      reminder0Days: parsed.data.reminder0Days,
      reminder3Days: parsed.data.reminder3Days,
      reminder7Days: parsed.data.reminder7Days,
      suspendDays: parsed.data.suspendDays,
      terminateDays: parsed.data.terminateDays,
    };
    for (const [k, v] of Object.entries(dayFields)) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        res.status(400).json({ error: `${k} harus bilangan bulat ≥ 0` });
        return;
      }
    }
    const config = await updateDunningSettings(parsed.data);
    res.json({ enabled: config.enabled, ...config.schedule });
  } catch (err) {
    req.log.error({ err }, "adminUpdateDunningSettings failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
