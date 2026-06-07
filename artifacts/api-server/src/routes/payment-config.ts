import { Router } from "express";
import {
  AdminUpdatePaymentConfigBody,
  AdminUpdatePaymentMethodBody,
} from "@workspace/api-zod";
import {
  getPaymentConfigStatus,
  updatePaymentConfig,
} from "../lib/payment-config";
import {
  getPaymentMethodStatus,
  updatePaymentMethodSettings,
} from "../lib/manual-payment-config";

// Admin-only payment gateway (Xendit) credential management (Hybrid FASE 2).
// Mounted under /admin AFTER requireAdmin, so every caller is a verified
// platform admin. Lets the operator paste their own Xendit secret key + webhook
// callback token without a redeploy. Secrets are encrypted at rest and NEVER
// returned — reads expose only masked metadata (configured flags + last4).
const router = Router();

router.get("/payment-config", async (req, res): Promise<void> => {
  try {
    const status = await getPaymentConfigStatus();
    res.json(status);
  } catch (err) {
    req.log.error({ err }, "adminGetPaymentConfig failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/payment-config", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdatePaymentConfigBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input gateway tidak valid" });
      return;
    }
    const status = await updatePaymentConfig(parsed.data);
    res.json(status);
  } catch (err) {
    req.log.error({ err }, "adminUpdatePaymentConfig failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Active provider + manual bank / verification sheet --------------------

router.get("/payment-method", async (req, res): Promise<void> => {
  try {
    const status = await getPaymentMethodStatus();
    res.json(status);
  } catch (err) {
    req.log.error({ err }, "adminGetPaymentMethod failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/payment-method", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdatePaymentMethodBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input metode pembayaran tidak valid" });
      return;
    }
    // OpenAPI `integer` codegens to zod.number() (accepts decimals); re-check.
    const credId = parsed.data.verificationCredentialId;
    if (credId != null && !Number.isInteger(credId)) {
      res.status(400).json({ error: "verificationCredentialId harus bilangan bulat" });
      return;
    }
    const status = await updatePaymentMethodSettings(parsed.data);
    res.json(status);
  } catch (err) {
    req.log.error({ err }, "adminUpdatePaymentMethod failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
