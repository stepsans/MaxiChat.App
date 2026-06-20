import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, leadReviewRequestsTable } from "@workspace/db";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import { recordLeadCorrection } from "../lib/lead-feedback";
import { AnswerLeadReviewBody } from "@workspace/api-zod";

const router = Router();

async function resolveOwner(req: Request, res: Response): Promise<number | null> {
  const uid = getSessionUserId(req);
  if (uid == null) {
    res.status(401).json({ error: "Not signed in" });
    return null;
  }
  return resolveOwnerUserId(uid);
}

async function countPending(ownerUserId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leadReviewRequestsTable)
    .where(
      and(
        eq(leadReviewRequestsTable.ownerUserId, ownerUserId),
        eq(leadReviewRequestsTable.status, "pending")
      )
    );
  return row?.n ?? 0;
}

// GET /lead-reviews — the open "Review Lead" queue + pending count for the badge.
router.get("/", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const rows = await db
    .select({
      id: leadReviewRequestsTable.id,
      contactPhone: leadReviewRequestsTable.contactPhone,
      contactName: leadReviewRequestsTable.contactName,
      chatId: leadReviewRequestsTable.chatId,
      channelId: leadReviewRequestsTable.channelId,
      trigger: leadReviewRequestsTable.trigger,
      question: leadReviewRequestsTable.question,
      aiSuggestedStatus: leadReviewRequestsTable.aiSuggestedStatus,
      aiScore: leadReviewRequestsTable.aiScore,
      aiConversationRole: leadReviewRequestsTable.aiConversationRole,
      contextSummary: leadReviewRequestsTable.contextSummary,
      status: leadReviewRequestsTable.status,
      createdAt: leadReviewRequestsTable.createdAt,
    })
    .from(leadReviewRequestsTable)
    .where(
      and(
        eq(leadReviewRequestsTable.ownerUserId, ownerUserId),
        eq(leadReviewRequestsTable.status, "pending")
      )
    )
    .orderBy(desc(leadReviewRequestsTable.createdAt))
    .limit(200);

  res.json({
    items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    pendingCount: rows.length,
  });
});

// POST /lead-reviews/:id/answer — record the tenant's final decision.
router.post("/:id/answer", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = AnswerLeadReviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  // Scope to the owner so a tenant can only answer their own queue.
  const [reqRow] = await db
    .select()
    .from(leadReviewRequestsTable)
    .where(
      and(
        eq(leadReviewRequestsTable.id, id),
        eq(leadReviewRequestsTable.ownerUserId, ownerUserId)
      )
    )
    .limit(1);
  if (!reqRow) {
    res.status(404).json({ error: "Review request not found" });
    return;
  }

  // recordLeadCorrection writes the manual status, logs the lesson, and closes
  // the pending request for this contact in one shot.
  await recordLeadCorrection({
    ownerUserId,
    phoneNumber: reqRow.contactPhone,
    contactName: reqRow.contactName,
    toStatus: parsed.data.leadStatus,
    reason: parsed.data.reason ?? null,
    reasonCode: parsed.data.reasonCode ?? null,
    source: "review_answer",
    chatId: reqRow.chatId,
    channelId: reqRow.channelId,
    answeredByUserId: getSessionUserId(req),
  });

  res.json({ ok: true, pendingCount: await countPending(ownerUserId) });
});

// POST /lead-reviews/:id/dismiss — close without deciding (no learning signal).
router.post("/:id/dismiss", async (req, res): Promise<void> => {
  const ownerUserId = await resolveOwner(req, res);
  if (ownerUserId == null) return;

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const result = await db
    .update(leadReviewRequestsTable)
    .set({ status: "dismissed", answeredAt: new Date(), answeredByUserId: getSessionUserId(req) })
    .where(
      and(
        eq(leadReviewRequestsTable.id, id),
        eq(leadReviewRequestsTable.ownerUserId, ownerUserId),
        eq(leadReviewRequestsTable.status, "pending")
      )
    )
    .returning({ id: leadReviewRequestsTable.id });
  if (result.length === 0) {
    res.status(404).json({ error: "Review request not found" });
    return;
  }

  res.json({ ok: true, pendingCount: await countPending(ownerUserId) });
});

export default router;
