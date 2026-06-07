# Payments webhook (Xendit) — FASE 2

This documents the **inbound** payment webhook MaxiChat exposes. It is the
reconciliation channel for the Hybrid subscription system: Xendit calls it when
a hosted invoice changes state, and MaxiChat grants the purchased plan/add-on.

> Outbound webhooks (notifying Odoo / n8n when a payment settles) are **FASE 4**
> and not implemented here. This file describes the current inbound contract so a
> future integrator knows exactly what already exists.

## Endpoint

```
POST /api/webhooks/xendit
```

- Mounted **before** session auth — there is no cookie. Authentication is the
  static token in the `x-callback-token` header.
- Configure the same token in the Xendit dashboard **and** as the
  `XENDIT_CALLBACK_TOKEN` secret. A mismatch returns `403`.

## Required secrets

| Secret                  | Purpose                                            |
| ----------------------- | -------------------------------------------------- |
| `XENDIT_SECRET_KEY`     | Server API key used to create hosted invoices.     |
| `XENDIT_CALLBACK_TOKEN` | Verifies the `x-callback-token` on inbound hooks.  |

## Request

Headers:

```
x-callback-token: <XENDIT_CALLBACK_TOKEN>
content-type: application/json
```

Body (Xendit invoice callback — only the fields we read are listed):

```jsonc
{
  "id": "657...",                 // Xendit invoice id (matches payments.external_id)
  "external_id": "maxichat-pay-42", // our reference: maxichat-pay-<paymentId>
  "status": "PAID"                // PAID | SETTLED | EXPIRED | (other = ignored)
}
```

## Reconciliation rules

1. **Auth** — reject with `403` unless `x-callback-token` matches.
2. **Lookup** — find the payment by `payments.external_id == body.id`; if not
   found, fall back to parsing `maxichat-pay-<id>` out of `external_id`.
   Unknown invoice → `200` ACK (so Xendit stops retrying) + a warning log.
3. **Apply** (idempotent — a conditional `WHERE status='pending'` update):
   - `PAID` / `SETTLED` → mark the payment `paid` and grant its effect:
     - **plan** → set `users.plan`, activate the subscription for
       `plan.durationDays`, reset `tenant_quota` limits to the plan baseline.
     - **addon** → increment the matching `tenant_quota` limit by
       `unitAmount * quantity`.
   - `EXPIRED` → mark the payment `expired` (no quota effect).
   - other statuses → store payload, no transition.
4. **ACK** — reconciliation runs **before** the ACK and inside a single DB
   transaction. On success we respond `200 {ok:true}`. On a transient failure we
   respond `500` so Xendit retries; the payment stays `pending` (never
   half-applied). A duplicate delivery applies its effect exactly once.

## Response codes

| Code | Meaning                                             |
| ---- | --------------------------------------------------- |
| 200  | Accepted (including unknown-invoice ACK).           |
| 400  | Missing `status`.                                   |
| 403  | Bad / missing `x-callback-token`.                   |
| 500  | Reconcile failed — Xendit should retry.             |
