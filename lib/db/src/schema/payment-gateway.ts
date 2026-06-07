import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Platform-level payment gateway configuration (Hybrid subscription FASE 2).
// This is a SINGLETON catalog keyed by `provider` (currently only "xendit") —
// it holds the operator's ONE gateway account that every tenant pays into, NOT
// per-tenant credentials. Managed by platform admins from the admin app so the
// operator can paste their own Xendit secret key + webhook token without a
// redeploy (env vars remain a fallback when no row is configured).
//
// SECURITY: `secretKeyEnc` / `callbackTokenEnc` hold the base64(iv|ciphertext|
// tag) envelope from encryptString() (AES-256-GCM, see api-server/src/lib/
// crypto.ts). They are NEVER returned to the API client — reads are masked.
// Decryption happens only at invoice-create / webhook-verify time on the server.
export const paymentGatewayConfigTable = pgTable(
  "payment_gateway_config",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull().default("xendit"),
    secretKeyEnc: text("secret_key_enc"),
    callbackTokenEnc: text("callback_token_enc"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    paymentGatewayProviderUnique: uniqueIndex(
      "payment_gateway_provider_unique"
    ).on(t.provider),
  })
);

export type PaymentGatewayConfig =
  typeof paymentGatewayConfigTable.$inferSelect;
