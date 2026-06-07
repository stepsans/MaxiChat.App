import { eq } from "drizzle-orm";
import { db, paymentGatewayConfigTable } from "@workspace/db";
import { encryptString, decryptString } from "./crypto";
import { logger } from "./logger";

// Platform payment-gateway credential store (Hybrid subscription FASE 2).
//
// Credentials are resolved DB-first, with the legacy env vars as a fallback so
// existing deployments keep working until an admin saves a row from the UI:
//   secret key    : payment_gateway_config.secret_key_enc  → XENDIT_SECRET_KEY
//   callback token: payment_gateway_config.callback_token_enc → XENDIT_CALLBACK_TOKEN
// A row with is_active=false disables the DB credentials entirely (treated as if
// no row existed → env fallback only), so an admin can switch the gateway off
// without deleting their keys.
//
// Secrets are encrypted at rest with AES-256-GCM (see crypto.ts) and never
// returned to the client — getPaymentConfigStatus() exposes only masked metadata.

const PROVIDER = "xendit";

export type CredentialSource = "db" | "env" | null;

export interface XenditCredentials {
  secretKey: string | null;
  callbackToken: string | null;
  secretKeySource: CredentialSource;
  callbackTokenSource: CredentialSource;
}

function envSecretKey(): string | null {
  const k = process.env.XENDIT_SECRET_KEY?.trim();
  return k ? k : null;
}

function envCallbackToken(): string | null {
  const t = process.env.XENDIT_CALLBACK_TOKEN?.trim();
  return t ? t : null;
}

// Safely decrypt a stored envelope. A failure (e.g. SESSION_SECRET rotated) is
// logged and treated as "not configured" rather than throwing, so a bad row
// never takes down checkout/webhook — it falls back to env.
function tryDecrypt(envelope: string | null, field: string): string | null {
  if (!envelope) return null;
  try {
    const v = decryptString(envelope).trim();
    return v ? v : null;
  } catch (err) {
    logger.error({ err, field }, "payment-config: failed to decrypt credential");
    return null;
  }
}

// Resolve the active Xendit credentials (DB-first, env fallback), per field.
export async function getXenditCredentials(): Promise<XenditCredentials> {
  let dbSecret: string | null = null;
  let dbToken: string | null = null;
  try {
    const [row] = await db
      .select()
      .from(paymentGatewayConfigTable)
      .where(eq(paymentGatewayConfigTable.provider, PROVIDER))
      .limit(1);
    if (row && row.isActive) {
      dbSecret = tryDecrypt(row.secretKeyEnc, "secretKey");
      dbToken = tryDecrypt(row.callbackTokenEnc, "callbackToken");
    }
  } catch (err) {
    logger.error({ err }, "payment-config: failed to read gateway config row");
  }

  const envSecret = envSecretKey();
  const envToken = envCallbackToken();
  const secretKey = dbSecret ?? envSecret;
  const callbackToken = dbToken ?? envToken;
  return {
    secretKey,
    callbackToken,
    secretKeySource: dbSecret ? "db" : envSecret ? "env" : null,
    callbackTokenSource: dbToken ? "db" : envToken ? "env" : null,
  };
}

export interface PaymentConfigStatus {
  provider: string;
  isActive: boolean;
  secretKeyConfigured: boolean;
  callbackTokenConfigured: boolean;
  secretKeySource: CredentialSource;
  callbackTokenSource: CredentialSource;
  // Last 4 chars of the secret key, for the admin to confirm which key is saved
  // without ever exposing the full value. Null when unset.
  secretKeyLast4: string | null;
  updatedAt: string | null;
}

// Masked status for the admin UI. NEVER returns the raw secret/token.
export async function getPaymentConfigStatus(): Promise<PaymentConfigStatus> {
  let isActive = true;
  let updatedAt: string | null = null;
  try {
    const [row] = await db
      .select()
      .from(paymentGatewayConfigTable)
      .where(eq(paymentGatewayConfigTable.provider, PROVIDER))
      .limit(1);
    if (row) {
      isActive = row.isActive;
      updatedAt = row.updatedAt.toISOString();
    }
  } catch (err) {
    logger.error({ err }, "payment-config: failed to read status row");
  }

  const creds = await getXenditCredentials();
  const last4 =
    creds.secretKey && creds.secretKey.length >= 4
      ? creds.secretKey.slice(-4)
      : creds.secretKey
        ? creds.secretKey
        : null;

  return {
    provider: PROVIDER,
    isActive,
    secretKeyConfigured: creds.secretKey !== null,
    callbackTokenConfigured: creds.callbackToken !== null,
    secretKeySource: creds.secretKeySource,
    callbackTokenSource: creds.callbackTokenSource,
    secretKeyLast4: last4,
    updatedAt,
  };
}

export interface UpdatePaymentConfigInput {
  // Provided non-empty → set/replace. Omitted/undefined → leave unchanged.
  secretKey?: string;
  callbackToken?: string;
  // Explicitly clear the stored value (overrides the set above).
  clearSecretKey?: boolean;
  clearCallbackToken?: boolean;
  isActive?: boolean;
}

// Upsert the singleton gateway row, encrypting any provided credentials. Returns
// the masked status after the write.
//
// This is a single atomic INSERT ... ON CONFLICT (provider) DO UPDATE so two
// concurrent first writes can't race on the unique index (no select-then-insert
// gap). Only the columns the caller actually changed are listed in the conflict
// SET, so omitted credentials are preserved; `clear*` flags set them to NULL.
export async function updatePaymentConfig(
  input: UpdatePaymentConfigInput
): Promise<PaymentConfigStatus> {
  // undefined = leave the column unchanged on conflict; null = clear it.
  let newSecretEnc: string | null | undefined;
  if (input.clearSecretKey) {
    newSecretEnc = null;
  } else if (input.secretKey && input.secretKey.trim()) {
    newSecretEnc = encryptString(input.secretKey.trim());
  }

  let newTokenEnc: string | null | undefined;
  if (input.clearCallbackToken) {
    newTokenEnc = null;
  } else if (input.callbackToken && input.callbackToken.trim()) {
    newTokenEnc = encryptString(input.callbackToken.trim());
  }

  const now = new Date();
  const set: Partial<typeof paymentGatewayConfigTable.$inferInsert> = {
    updatedAt: now,
  };
  if (newSecretEnc !== undefined) set.secretKeyEnc = newSecretEnc;
  if (newTokenEnc !== undefined) set.callbackTokenEnc = newTokenEnc;
  if (input.isActive !== undefined) set.isActive = input.isActive;

  await db
    .insert(paymentGatewayConfigTable)
    .values({
      provider: PROVIDER,
      secretKeyEnc: newSecretEnc ?? null,
      callbackTokenEnc: newTokenEnc ?? null,
      isActive: input.isActive ?? true,
    })
    .onConflictDoUpdate({
      target: paymentGatewayConfigTable.provider,
      set,
    });

  return getPaymentConfigStatus();
}
