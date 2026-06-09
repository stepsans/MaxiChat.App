import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, onboardingChecklistTable } from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { refreshChecklist } from "../lib/onboarding";

const router = Router();

// GET /onboarding/checklist
// Fetch the logged-in owner's checklist progress.
router.get("/checklist", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await getEffectiveOwnerUserId(userId);

    // Refresh from actual data first.
    await refreshChecklist(ownerUserId);

    const [row] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
      .limit(1);

    res.json({
      waConnected: row?.waConnected ?? false,
      productAdded: row?.productAdded ?? false,
      teamMemberAdded: row?.teamMemberAdded ?? false,
      firstMessageAt: row?.firstMessageAt?.toISOString() ?? null,
      aiTriedAt: row?.aiTriedAt?.toISOString() ?? null,
      flowActivated: row?.flowActivated ?? false,
      healthScore: row?.healthScore ?? 0,
      riskLevel: row?.riskLevel ?? "high",
    });
  } catch (err) {
    req.log.error({ err }, "GET /onboarding/checklist failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /onboarding/refresh
// Force-refresh the checklist from actual data.
router.post("/refresh", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await getEffectiveOwnerUserId(userId);
    await refreshChecklist(ownerUserId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/refresh failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
