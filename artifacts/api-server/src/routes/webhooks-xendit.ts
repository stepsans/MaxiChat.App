import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, paymentsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  verifyXenditCallbackToken,
  isPaidStatus,
  isExpiredStatus,
} from "../lib/xendit";
import {
  settlePaymentPaid,
  settlePaymentTerminal,
} from "../lib/subscription-purchase";

const router = Router();

// Inbound Xendit invoice webhook. Mounted at /api/webhooks/xendit BEFORE
// requireAuth — Xendit has no session cookie. We authenticate the caller via
// the static token Xendit sends in the `x-callback-token` header (configured in
// the Xendit dashboard, stored as XENDIT_CALLBACK_TOKEN). See
// docs/payments-webhook.md for the contract.
//
// We reconcile BEFORE ACKing: the pending→paid (or →expired) transition runs
// inside a single transaction (see settlePaymentPaid), so a crash mid-flight
// never half-applies and Xendit retries on a non-2xx. Reconciliation is also
// idempotent — the conditional UPDATE (WHERE status='pending') means a webhook
// delivered twice applies its effect exactly once.
router.post("/", async (req, res): Promise<void> => {
  const token = req.header("x-callback-token");
  if (!verifyXenditCallbackToken(token)) {
    res.status(403).json({ error: "Bad callback token" });
    return;
  }

  const body = (req.body ?? {}) as {
    id?: string;
    external_id?: string;
    status?: string;
  };
  const invoiceId = typeof body.id === "string" ? body.id : undefined;
  const externalRef =
    typeof body.external_id === "string" ? body.external_id : undefined;
  const status = typeof body.status === "string" ? body.status : "";

  if (!status) {
    res.status(400).json({ error: "Missing status" });
    return;
  }

  // Resolve the payment row. Primary: our stored externalId == Xendit invoice
  // id. Fallback: parse the id we embedded in external_id (maxichat-pay-<id>).
  let paymentId: number | null = null;
  if (invoiceId) {
    const [row] = await db
      .select({ id: paymentsTable.id })
      .from(paymentsTable)
      .where(eq(paymentsTable.externalId, invoiceId))
      .limit(1);
    if (row) paymentId = row.id;
  }
  if (paymentId == null && externalRef) {
    const m = /^maxichat-pay-(\d+)$/.exec(externalRef);
    if (m) {
      const candidate = Number.parseInt(m[1], 10);
      const [row] = await db
        .select({ id: paymentsTable.id })
        .from(paymentsTable)
        .where(eq(paymentsTable.id, candidate))
        .limit(1);
      if (row) paymentId = row.id;
    }
  }

  if (paymentId == null) {
    // Unknown invoice — ACK so Xendit stops retrying, but log for the operator.
    logger.warn({ invoiceId, externalRef, status }, "xendit webhook: no matching payment");
    res.status(200).json({ ok: true });
    return;
  }

  // Reconcile before ACKing. On a transient failure we respond 500 so Xendit
  // retries; the transactional settle leaves the payment `pending` (retriable)
  // rather than half-applied.
  const pid = paymentId;
  try {
    if (isPaidStatus(status)) {
      const applied = await settlePaymentPaid(pid, body);
      logger.info(
        { paymentId: pid, applied, status },
        applied
          ? "xendit payment settled + quota applied"
          : "xendit payment already settled (idempotent no-op)"
      );
    } else if (isExpiredStatus(status)) {
      await settlePaymentTerminal(pid, "expired", body);
      logger.info({ paymentId: pid }, "xendit payment expired");
    } else {
      // PENDING / other intermediate states — store payload, no transition.
      logger.info({ paymentId: pid, status }, "xendit webhook: non-terminal status");
    }
  } catch (err) {
    logger.error({ err, paymentId: pid, status }, "xendit webhook reconcile failed");
    res.status(500).json({ error: "Reconcile failed" });
    return;
  }

  res.status(200).json({ ok: true });
});

export default router;
