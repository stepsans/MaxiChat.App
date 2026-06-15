import {
  pgTable,
  integer,
  bigserial,
  text,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";

// ===========================================================================
// Centralized platform AI engine + prepaid AI-credit wallet (spec: "Mesin AI
// Terpusat + Dompet Kredit Prabayar").
//
// NOTE: this is a DISTINCT concept from the billing-v2 Rupiah `wallet` /
// `wallet_transactions` tables. Those hold cash (balanceIdr); these hold AI
// CREDITS (an abstraction over tokens). Keep the two separate — never conflate
// a credit balance with a Rupiah balance.
// ===========================================================================

// Singleton (always id=1): the one AI engine all tenants ride, configured by
// the platform owner with the owner's own credentials. api_key_enc is
// AES-256-GCM (lib/crypto.ts) and is never returned in plaintext.
export const platformAiConfigTable = pgTable("platform_ai_config", {
  id: integer("id").primaryKey().default(1),
  // DEPRECATED single-engine fields (engine/model/baseUrl/apiKeyEnc): kept only
  // until resolveAiClient is reworked onto platformAiEngineTable (SPEC BAGIAN 4
  // "DIGANTI"). Credentials now live per-engine in platform_ai_engine.
  engine: text("engine").notNull().default("anthropic"),
  model: text("model"),
  baseUrl: text("base_url"),
  apiKeyEnc: text("api_key_enc"),
  isActive: boolean("is_active").notNull().default(false),
  markupBps: integer("markup_bps").notNull().default(5000), // 5000 = +50%
  creditPer1kTokenAnthropic: integer("credit_per_1k_token_anthropic").notNull().default(1000),
  creditPer1kTokenGemini: integer("credit_per_1k_token_gemini").notNull().default(1000),
  minStopCredits: integer("min_stop_credits").notNull().default(0),
  // Failover knobs (owner-tunable; SPEC defaults).
  autoFailover: boolean("auto_failover").notNull().default(true),
  autoFailback: boolean("auto_failback").notNull().default(true),
  unhealthyMinutes: integer("unhealthy_minutes").notNull().default(5),
  bothFailedRetry: boolean("both_failed_retry").notNull().default(true),
  bothFailedRetryDelayMs: integer("both_failed_retry_delay_ms").notNull().default(1500),
  updatedBy: integer("updated_by").references(() => usersTable.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// The four centralized AI engines (one row each), priority-ordered for chained
// failover (#1→#4). Credentials are AES-256-GCM at rest (api_key_enc) and read
// masked. `unhealthy_until` is the circuit-breaker: an engine that fails a
// failover-eligible call is skipped until this time, then re-probed (auto-
// failback). Reached through their OpenAI-compatible endpoints.
export const PLATFORM_AI_ENGINES = ["deepseek", "gemini", "openai", "anthropic"] as const;
export const platformAiEngineTable = pgTable("platform_ai_engine", {
  engine: text("engine").primaryKey(), // one of PLATFORM_AI_ENGINES
  baseUrl: text("base_url"),
  model: text("model"),
  apiKeyEnc: text("api_key_enc"),
  creditPer1kToken: integer("credit_per_1k_token").notNull().default(1000),
  isEnabled: boolean("is_enabled").notNull().default(false),
  priority: integer("priority").notNull(), // 1..4 (1 = primary), unique
  health: text("health").notNull().default("unknown"), // 'healthy'|'unhealthy'|'unknown'
  unhealthyUntil: timestamp("unhealthy_until", { withTimezone: true }),
  lastError: text("last_error"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One wallet per tenant owner. grant = Ember A (plan allowance, expires at
// period end, spent first). paid = Ember B (purchased top-ups, rollover/never
// reset). reserved = sum of active holds, to prevent negative balance on
// concurrent calls.
export const creditWalletTable = pgTable("credit_wallet", {
  ownerUserId: integer("owner_user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  grantBalance: integer("grant_balance").notNull().default(0),
  grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
  paidBalance: integer("paid_balance").notNull().default(0),
  paidExpiresAt: timestamp("paid_expires_at", { withTimezone: true }),
  reserved: integer("reserved").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Append-only audit of every credit mutation (financial source of truth).
export const creditLedgerTable = pgTable(
  "credit_ledger",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(), // + fill, - spend
    bucket: text("bucket").notNull(), // 'grant' | 'paid'
    reason: text("reason").notNull(), // 'topup'|'usage'|'grant'|'expire'|'adjust'
    engine: text("engine"), // serving engine for reason='usage'
    callId: text("call_id"), // idempotency for per-call usage
    balanceAfter: integer("balance_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One usage charge per call_id — the idempotency guard for settlement.
    uniqueIndex("credit_ledger_usage_idem")
      .on(t.callId)
      .where(sql`reason = 'usage'`),
    index("credit_ledger_owner_idx").on(t.ownerUserId, t.createdAt),
  ]
);

// Temporary reservation per AI call; released on settle or expiry sweep.
export const creditHoldTable = pgTable("credit_hold", {
  callId: text("call_id").primaryKey(),
  ownerUserId: integer("owner_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  amount: integer("amount").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// Anti-spam state for low-balance notifications: the last threshold already
// sent (100=full, 20, 5, 0) so we notify once per crossing.
export const creditNotifyStateTable = pgTable("credit_notify_state", {
  ownerUserId: integer("owner_user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  lastThreshold: integer("last_threshold").notNull().default(100),
  periodStart: timestamp("period_start", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type PlatformAiConfigRow = typeof platformAiConfigTable.$inferSelect;
export type PlatformAiEngineRow = typeof platformAiEngineTable.$inferSelect;
export type PlatformAiEngineName = (typeof PLATFORM_AI_ENGINES)[number];
export type CreditWalletRow = typeof creditWalletTable.$inferSelect;
export type CreditLedgerRow = typeof creditLedgerTable.$inferSelect;
export type CreditHoldRow = typeof creditHoldTable.$inferSelect;
export type CreditNotifyStateRow = typeof creditNotifyStateTable.$inferSelect;
