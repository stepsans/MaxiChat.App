import { Router } from "express";
import { AdminUpdateStorageConfigBody } from "@workspace/api-zod";
import { getStorageConfig, updateStorageConfig } from "../lib/storage-config";

// Admin-only storage-enforcement configuration (Billing v2 — FASE C). Mounted
// under /admin AFTER requireAdmin, so every caller is a verified platform
// admin. Defaults are inert (enforcement off) so behavior is unchanged until
// the operator turns it on. Inbound WhatsApp media ingestion is never blocked
// regardless of this policy.
const router = Router();

router.get("/storage-config", async (req, res): Promise<void> => {
  try {
    const config = await getStorageConfig();
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "adminGetStorageConfig failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/storage-config", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdateStorageConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input penyimpanan tidak valid" });
      return;
    }
    // OpenAPI `integer` codegens to zod.number() (accepts decimals); re-check
    // and bound to sane ranges. grace 0–1000% (allow generous slack), warn
    // 0–100% (it's a percent of the plafon).
    const { gracePercent, warnPercent } = parsed.data;
    if (gracePercent !== undefined) {
      if (!Number.isInteger(gracePercent) || gracePercent < 0 || gracePercent > 1000) {
        res.status(400).json({
          error: "gracePercent harus bilangan bulat antara 0 dan 1000",
        });
        return;
      }
    }
    if (warnPercent !== undefined) {
      // Lower bound is 1: "warn at 0%" = always-on is meaningless, and allowing
      // it would make the client's `>0 ? warnPercent : 80` fallback misreport a
      // saved 0 as 80. Bounding at 1..100 keeps client + server faithful.
      if (!Number.isInteger(warnPercent) || warnPercent < 1 || warnPercent > 100) {
        res.status(400).json({
          error: "warnPercent harus bilangan bulat antara 1 dan 100",
        });
        return;
      }
    }
    const config = await updateStorageConfig(parsed.data);
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "adminUpdateStorageConfig failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
