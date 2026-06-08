import { Router } from "express";
import { AdminUpdateTaxConfigBody } from "@workspace/api-zod";
import { getTaxConfig, updateTaxConfig } from "../lib/tax-config";

// Admin-only tax (PPN) configuration (Billing v2 — FASE G). Mounted under
// /admin AFTER requireAdmin, so every caller is a verified platform admin. The
// policy is snapshotted into each invoice at issue, so changing it never
// rewrites past invoices.
const router = Router();

router.get("/tax-config", async (req, res): Promise<void> => {
  try {
    const config = await getTaxConfig();
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "adminGetTaxConfig failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/tax-config", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdateTaxConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input pajak tidak valid" });
      return;
    }
    // OpenAPI `integer` codegens to zod.number() (accepts decimals); re-check,
    // and bound the rate to a sane 0–100% range (0–10000 bps).
    const { rateBps } = parsed.data;
    if (rateBps !== undefined) {
      if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 10000) {
        res.status(400).json({
          error: "rateBps harus bilangan bulat antara 0 dan 10000 (0–100%)",
        });
        return;
      }
    }
    const config = await updateTaxConfig(parsed.data);
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "adminUpdateTaxConfig failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
