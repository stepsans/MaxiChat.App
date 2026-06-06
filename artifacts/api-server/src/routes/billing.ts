import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  computeOwnerBill,
  getOrCreateSubscription,
} from "../lib/billing";

const router = Router();

// GET /billing/me — the signed-in tenant owner's subscription, live usage and
// computed monthly bill. Team members (supervisor/agent) resolve to their
// owner, so the figures shown are always the OWNER's tenant-wide spend.
router.get("/me", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await resolveOwnerUserId(userId);

    // Guard against a stale session whose owner was deleted: without this the
    // FK insert in getOrCreateSubscription would throw a 500. Return 404 so the
    // client can treat it as a logged-out / gone account deterministically.
    const ownerExists = await db.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (SELECT 1 FROM users WHERE id = ${ownerUserId}) AS exists
    `);
    const exists =
      (ownerExists as any).rows?.[0]?.exists ??
      (ownerExists as any)[0]?.exists ??
      false;
    if (!exists) {
      res.status(404).json({ error: "Tenant owner not found" });
      return;
    }

    const [subscription, bill] = await Promise.all([
      getOrCreateSubscription(ownerUserId),
      computeOwnerBill(ownerUserId),
    ]);

    res.json({
      subscription,
      usage: bill.usage,
      pricing: bill.pricing,
      breakdown: bill.breakdown,
    });
  } catch (err) {
    req.log.error({ err }, "getMyBilling failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
