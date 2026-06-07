import { timingSafeEqual } from "node:crypto";
import { logger } from "./logger";

// Thin Xendit client for the Hybrid subscription system (FASE 2). We use the
// hosted Invoice API (https://developers.xendit.co/api-reference/#create-invoice)
// which renders one checkout page covering VA / QRIS / e-wallet — no card data
// ever touches our server. Auth is HTTP Basic with the secret API key as the
// username and an empty password.
//
// Two secrets drive this module (requested from the operator, never hardcoded):
//   - XENDIT_SECRET_KEY    : creates invoices (Basic auth)
//   - XENDIT_CALLBACK_TOKEN : verifies inbound webhooks (x-callback-token)
//
// The API base is a fixed constant — there is no user-controlled URL here, so
// no SSRF surface.

const XENDIT_API_BASE = "https://api.xendit.co";

export function getXenditSecretKey(): string | null {
  const k = process.env.XENDIT_SECRET_KEY?.trim();
  return k ? k : null;
}

export function getXenditCallbackToken(): string | null {
  const t = process.env.XENDIT_CALLBACK_TOKEN?.trim();
  return t ? t : null;
}

// True only when invoice creation is possible (the webhook can still be
// verified independently as long as the callback token is set).
export function isXenditConfigured(): boolean {
  return getXenditSecretKey() !== null;
}

export interface CreateInvoiceParams {
  // Our own reference echoed back on the webhook as `external_id`.
  externalId: string;
  amount: number; // whole IDR
  description: string;
  payerEmail?: string;
  // Hours until the invoice expires (Xendit default is 24h).
  invoiceDurationSeconds?: number;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
}

export interface CreateInvoiceResult {
  id: string; // Xendit invoice id
  invoiceUrl: string; // hosted checkout page
  status: string; // PENDING on creation
}

// Create a hosted Xendit invoice. Throws on misconfiguration or a non-2xx
// response so the caller can fail the checkout explicitly (no silent fallback).
export async function createXenditInvoice(
  params: CreateInvoiceParams
): Promise<CreateInvoiceResult> {
  const secretKey = getXenditSecretKey();
  if (!secretKey) {
    throw new Error("XENDIT_SECRET_KEY is not configured");
  }

  const auth = Buffer.from(`${secretKey}:`).toString("base64");
  const body: Record<string, unknown> = {
    external_id: params.externalId,
    amount: params.amount,
    description: params.description,
    currency: "IDR",
  };
  if (params.payerEmail) body.payer_email = params.payerEmail;
  if (params.invoiceDurationSeconds) {
    body.invoice_duration = params.invoiceDurationSeconds;
  }
  if (params.successRedirectUrl) {
    body.success_redirect_url = params.successRedirectUrl;
  }
  if (params.failureRedirectUrl) {
    body.failure_redirect_url = params.failureRedirectUrl;
  }

  const res = await fetch(`${XENDIT_API_BASE}/v2/invoices`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    logger.error(
      { status: res.status, body: text, externalId: params.externalId },
      "xendit createInvoice failed"
    );
    throw new Error(`Xendit invoice creation failed (HTTP ${res.status})`);
  }

  let json: { id?: string; invoice_url?: string; status?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Xendit returned a non-JSON invoice response");
  }
  if (!json.id || !json.invoice_url) {
    throw new Error("Xendit invoice response is missing id/invoice_url");
  }
  return {
    id: json.id,
    invoiceUrl: json.invoice_url,
    status: json.status ?? "PENDING",
  };
}

// Constant-time comparison of the inbound x-callback-token against the
// configured token. Returns false (never throws) on length mismatch or when
// the token is unset, so the webhook handler can reject uniformly.
export function verifyXenditCallbackToken(provided: string | undefined): boolean {
  const expected = getXenditCallbackToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Xendit invoice statuses we care about, normalized. The webhook payload uses
// uppercase (PAID/SETTLED/EXPIRED). SETTLED is treated the same as PAID.
export type XenditInvoiceStatus = "PAID" | "SETTLED" | "EXPIRED" | string;

export function isPaidStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s === "PAID" || s === "SETTLED";
}

export function isExpiredStatus(status: string): boolean {
  return status.toUpperCase() === "EXPIRED";
}
