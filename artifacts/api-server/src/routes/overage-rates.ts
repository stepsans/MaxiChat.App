import { Router } from "express";
import { AdminUpdateOverageRatesBody } from "@workspace/api-zod";
import { getOverageRates, updateOverageRates } from "../lib/overage-config";

// Admin-only metered-overage rates (Billing v2 — Overage engine). Mounted under
// /admin AFTER requireAdmin (platform admin, not tenant super_admin). Inert by
// default (enabled=false), so the monthly-close raises no usage lines until the
// operator turns it on.
const router = Router();

router.get("/overage-rates", async (req, res): Promise<void> => {
  try {
    const config = await getOverageRates();
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "adminGetOverageRates failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/overage-rates", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdateOverageRatesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tarif overage tidak valid" });
      return;
    }
    // OpenAPI `integer` codegens to zod.number() (accepts decimals) — re-check
    // every numeric field is a whole non-negative Rupiah / unit value.
    const { tokenUnit, tokenUnitPriceIdr, storageGbDayPriceIdr } = parsed.data;
    for (const [k, v] of Object.entries({
      tokenUnit,
      tokenUnitPriceIdr,
      storageGbDayPriceIdr,
    })) {
      if (v !== undefined && (!Number.isInteger(v) || v < 0)) {
        res.status(400).json({
          error: `${k} harus bilangan bulat ≥ 0`,
        });
        return;
      }
    }
    // A zero token unit would divide-by-zero in the overage math; reject it.
    if (tokenUnit !== undefined && tokenUnit < 1) {
      res.status(400).json({ error: "tokenUnit harus ≥ 1" });
      return;
    }
    const config = await updateOverageRates(parsed.data);
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "adminUpdateOverageRates failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
