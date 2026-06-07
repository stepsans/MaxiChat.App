import { eq } from "drizzle-orm";
import { db, paymentMethodSettingsTable } from "@workspace/db";
import { logger } from "./logger";

// Platform payment-method selection + manual-transfer config (Hybrid
// subscription). Backs the admin "Gateway Pembayaran" provider switch and the
// manual bank/Sheet verification settings. Singleton row pinned to id=1.

export type ActiveProvider = "xendit" | "manual";

const SINGLETON_ID = 1;

export function normalizeProvider(value: unknown): ActiveProvider {
  return value === "manual" ? "manual" : "xendit";
}

export interface ManualPaymentRow {
  activeProvider: ActiveProvider;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  manualInstructions: string | null;
  verificationCredentialId: number | null;
  verificationSpreadsheetId: string | null;
  verificationSpreadsheetName: string | null;
  verificationSheetTab: string | null;
  lastPolledAt: Date | null;
  updatedAt: Date | null;
}

// Read the singleton row, defaulting to a Xendit-active empty config when no
// row exists yet (the migration seeds one, but stay defensive).
export async function getPaymentMethodRow(): Promise<ManualPaymentRow> {
  try {
    const [row] = await db
      .select()
      .from(paymentMethodSettingsTable)
      .where(eq(paymentMethodSettingsTable.id, SINGLETON_ID))
      .limit(1);
    if (row) {
      return {
        activeProvider: normalizeProvider(row.activeProvider),
        bankName: row.bankName,
        bankAccountNumber: row.bankAccountNumber,
        bankAccountHolder: row.bankAccountHolder,
        manualInstructions: row.manualInstructions,
        verificationCredentialId: row.verificationCredentialId,
        verificationSpreadsheetId: row.verificationSpreadsheetId,
        verificationSpreadsheetName: row.verificationSpreadsheetName,
        verificationSheetTab: row.verificationSheetTab,
        lastPolledAt: row.lastPolledAt,
        updatedAt: row.updatedAt,
      };
    }
  } catch (err) {
    logger.error({ err }, "payment-method: failed to read settings row");
  }
  return {
    activeProvider: "xendit",
    bankName: null,
    bankAccountNumber: null,
    bankAccountHolder: null,
    manualInstructions: null,
    verificationCredentialId: null,
    verificationSpreadsheetId: null,
    verificationSpreadsheetName: null,
    verificationSheetTab: null,
    lastPolledAt: null,
    updatedAt: null,
  };
}

export async function getActiveProvider(): Promise<ActiveProvider> {
  return (await getPaymentMethodRow()).activeProvider;
}

// True when the manual bank account is fully filled (shown to customers).
export function isManualBankConfigured(row: ManualPaymentRow): boolean {
  return (
    !!row.bankName?.trim() &&
    !!row.bankAccountNumber?.trim() &&
    !!row.bankAccountHolder?.trim()
  );
}

// True when the verification Google Sheet is fully selected (poller can run).
export function isVerificationConfigured(row: ManualPaymentRow): boolean {
  return (
    row.verificationCredentialId != null &&
    !!row.verificationSpreadsheetId?.trim() &&
    !!row.verificationSheetTab?.trim()
  );
}

export interface PaymentMethodStatus {
  activeProvider: ActiveProvider;
  bankName: string | null;
  bankAccountNumber: string | null;
  bankAccountHolder: string | null;
  manualInstructions: string | null;
  verificationCredentialId: number | null;
  verificationSpreadsheetId: string | null;
  verificationSpreadsheetName: string | null;
  verificationSheetTab: string | null;
  manualBankConfigured: boolean;
  verificationConfigured: boolean;
  lastPolledAt: string | null;
  updatedAt: string | null;
}

// Full status for the admin UI (bank fields are not secret, so returned as-is).
export async function getPaymentMethodStatus(): Promise<PaymentMethodStatus> {
  const row = await getPaymentMethodRow();
  return {
    activeProvider: row.activeProvider,
    bankName: row.bankName,
    bankAccountNumber: row.bankAccountNumber,
    bankAccountHolder: row.bankAccountHolder,
    manualInstructions: row.manualInstructions,
    verificationCredentialId: row.verificationCredentialId,
    verificationSpreadsheetId: row.verificationSpreadsheetId,
    verificationSpreadsheetName: row.verificationSpreadsheetName,
    verificationSheetTab: row.verificationSheetTab,
    manualBankConfigured: isManualBankConfigured(row),
    verificationConfigured: isVerificationConfigured(row),
    lastPolledAt: row.lastPolledAt ? row.lastPolledAt.toISOString() : null,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export interface UpdatePaymentMethodInput {
  activeProvider?: ActiveProvider;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankAccountHolder?: string | null;
  manualInstructions?: string | null;
  verificationCredentialId?: number | null;
  verificationSpreadsheetId?: string | null;
  verificationSpreadsheetName?: string | null;
  verificationSheetTab?: string | null;
}

// Upsert the singleton row. Only the fields explicitly provided are changed
// (undefined = leave unchanged; null/"" = clear). Atomic INSERT ... ON CONFLICT.
export async function updatePaymentMethodSettings(
  input: UpdatePaymentMethodInput
): Promise<PaymentMethodStatus> {
  const now = new Date();
  const set: Partial<typeof paymentMethodSettingsTable.$inferInsert> = {
    updatedAt: now,
  };

  if (input.activeProvider !== undefined) {
    set.activeProvider = normalizeProvider(input.activeProvider);
  }
  const trim = (v: string | null | undefined) =>
    v === undefined ? undefined : v === null ? null : v.trim() || null;

  const bankName = trim(input.bankName);
  if (bankName !== undefined) set.bankName = bankName;
  const bankAccountNumber = trim(input.bankAccountNumber);
  if (bankAccountNumber !== undefined) set.bankAccountNumber = bankAccountNumber;
  const bankAccountHolder = trim(input.bankAccountHolder);
  if (bankAccountHolder !== undefined) set.bankAccountHolder = bankAccountHolder;
  const manualInstructions = trim(input.manualInstructions);
  if (manualInstructions !== undefined) {
    set.manualInstructions = manualInstructions;
  }
  if (input.verificationCredentialId !== undefined) {
    set.verificationCredentialId = input.verificationCredentialId;
  }
  const spreadsheetId = trim(input.verificationSpreadsheetId);
  if (spreadsheetId !== undefined) set.verificationSpreadsheetId = spreadsheetId;
  const spreadsheetName = trim(input.verificationSpreadsheetName);
  if (spreadsheetName !== undefined) {
    set.verificationSpreadsheetName = spreadsheetName;
  }
  const sheetTab = trim(input.verificationSheetTab);
  if (sheetTab !== undefined) set.verificationSheetTab = sheetTab;

  await db
    .insert(paymentMethodSettingsTable)
    .values({
      id: SINGLETON_ID,
      activeProvider: set.activeProvider ?? "xendit",
      bankName: set.bankName ?? null,
      bankAccountNumber: set.bankAccountNumber ?? null,
      bankAccountHolder: set.bankAccountHolder ?? null,
      manualInstructions: set.manualInstructions ?? null,
      verificationCredentialId: set.verificationCredentialId ?? null,
      verificationSpreadsheetId: set.verificationSpreadsheetId ?? null,
      verificationSpreadsheetName: set.verificationSpreadsheetName ?? null,
      verificationSheetTab: set.verificationSheetTab ?? null,
    })
    .onConflictDoUpdate({
      target: paymentMethodSettingsTable.id,
      set,
    });

  return getPaymentMethodStatus();
}

// The unique payment "code" shown to the customer and written to the Sheet as
// the match key. Mirrors the externalId scheme used for Xendit.
export function manualPaymentCode(paymentId: number): string {
  return `maxichat-pay-${paymentId}`;
}

const CODE_RE = /^maxichat-pay-(\d+)$/;

export function parseManualPaymentCode(code: string): number | null {
  const m = CODE_RE.exec(code.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}
