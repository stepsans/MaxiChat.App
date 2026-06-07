import { and, eq } from "drizzle-orm";
import { google } from "googleapis";
import { db, credentialsTable, paymentsTable, type Credential } from "@workspace/db";
import { getAuthorizedOAuthClient } from "../routes/credentials";
import { settlePaymentPaid } from "./subscription-purchase";
import {
  getPaymentMethodRow,
  isVerificationConfigured,
  manualPaymentCode,
  parseManualPaymentCode,
  type ManualPaymentRow,
} from "./manual-payment-config";
import { logger } from "./logger";

// Manual-payment verification Google Sheet (Hybrid subscription).
//
// On a manual checkout the system appends one PENDING row per order. The
// operator confirms the bank transfer by setting the row's Status cell to
// LUNAS; the poller (readAndSettleManualPayments) then activates the membership
// via settlePaymentPaid. The match key is "Kode Pembayaran" = maxichat-pay-<id>.

// Canonical header. The operator edits only the Status column; everything else
// is system-written.
export const MANUAL_SHEET_HEADER = [
  "Kode Pembayaran",
  "Tanggal",
  "Nama Tenant",
  "Email",
  "Item",
  "Jumlah (Rp)",
  "Status",
  "Catatan",
] as const;

const KODE_COL = "Kode Pembayaran";
const STATUS_COL = "Status";

// Status cell values (normalized) that mean "paid".
const PAID_STATUSES = new Set([
  "lunas",
  "paid",
  "sudah",
  "sudah bayar",
  "sudahbayar",
  "ok",
  "oke",
  "selesai",
  "done",
  "verified",
  "terverifikasi",
]);

function isPaidStatusCell(value: string): boolean {
  return PAID_STATUSES.has(value.trim().toLowerCase());
}

async function loadConnectedCredentialById(
  credentialId: number
): Promise<Credential | null> {
  const [row] = await db
    .select()
    .from(credentialsTable)
    .where(eq(credentialsTable.id, credentialId))
    .limit(1);
  if (!row || row.status !== "connected") return null;
  return row;
}

// Ensure row 1 holds the canonical header (rewrites only if missing/different).
async function ensureHeader(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tab: string
): Promise<void> {
  let existing: string[] = [];
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!1:1`,
    });
    existing = (resp.data.values?.[0] ?? []).map((c) => String(c ?? ""));
  } catch {
    existing = [];
  }
  const same =
    existing.length === MANUAL_SHEET_HEADER.length &&
    MANUAL_SHEET_HEADER.every((h, i) => existing[i] === h);
  if (same) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [[...MANUAL_SHEET_HEADER]] },
  });
}

function formatJakarta(date: Date): string {
  try {
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export interface AppendManualOrderInput {
  paymentId: number;
  tenantName: string;
  email: string;
  item: string;
  amountIdr: number;
}

// Append a PENDING order row to the verification Sheet. Throws on failure so
// the caller can decide how to surface it (checkout logs + continues — the
// poller still matches any row the operator adds with the correct code).
export async function appendManualOrderRow(
  input: AppendManualOrderInput,
  row?: ManualPaymentRow
): Promise<void> {
  const settings = row ?? (await getPaymentMethodRow());
  if (!isVerificationConfigured(settings)) {
    throw new Error("Verification sheet is not configured");
  }
  const cred = await loadConnectedCredentialById(
    settings.verificationCredentialId!
  );
  if (!cred) throw new Error("Verification credential not connected");

  const auth = await getAuthorizedOAuthClient(cred);
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = settings.verificationSpreadsheetId!;
  const tab = settings.verificationSheetTab!;

  await ensureHeader(sheets, spreadsheetId, tab);
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [
        [
          manualPaymentCode(input.paymentId),
          formatJakarta(new Date()),
          input.tenantName,
          input.email,
          input.item,
          input.amountIdr,
          "PENDING",
          "",
        ],
      ],
    },
  });
}

export interface SettleResult {
  scanned: number;
  settled: number;
  errors: number;
}

// Read the verification Sheet and settle every paid-status row whose code
// maps to a still-pending manual payment. Idempotent (settlePaymentPaid only
// flips pending rows; an already-LUNAS row that's already settled is a no-op).
export async function readAndSettleManualPayments(): Promise<SettleResult> {
  const result: SettleResult = { scanned: 0, settled: 0, errors: 0 };
  const settings = await getPaymentMethodRow();
  if (settings.activeProvider !== "manual") return result;
  if (!isVerificationConfigured(settings)) return result;

  const cred = await loadConnectedCredentialById(
    settings.verificationCredentialId!
  );
  if (!cred) {
    logger.warn("manual-poller: verification credential not connected");
    return result;
  }

  const auth = await getAuthorizedOAuthClient(cred);
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = settings.verificationSpreadsheetId!;
  const tab = settings.verificationSheetTab!;

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tab,
  });
  const values = resp.data.values ?? [];
  if (values.length < 2) return result;

  const header = (values[0] ?? []).map((c) => String(c ?? "").trim());
  const kodeIdx = header.findIndex(
    (h) => h.toLowerCase() === KODE_COL.toLowerCase()
  );
  const statusIdx = header.findIndex(
    (h) => h.toLowerCase() === STATUS_COL.toLowerCase()
  );
  if (kodeIdx === -1 || statusIdx === -1) {
    logger.warn(
      { spreadsheetId, tab },
      "manual-poller: sheet missing Kode Pembayaran/Status header"
    );
    return result;
  }

  for (let i = 1; i < values.length; i++) {
    const dataRow = values[i] ?? [];
    const code = String(dataRow[kodeIdx] ?? "").trim();
    const status = String(dataRow[statusIdx] ?? "");
    if (!code || !isPaidStatusCell(status)) continue;
    const paymentId = parseManualPaymentCode(code);
    if (paymentId == null) continue;
    result.scanned++;

    try {
      // Only settle our own pending MANUAL payments. Guards against a stray
      // code colliding with a different-provider payment id.
      const [payment] = await db
        .select({
          id: paymentsTable.id,
          provider: paymentsTable.provider,
          status: paymentsTable.status,
        })
        .from(paymentsTable)
        .where(
          and(
            eq(paymentsTable.id, paymentId),
            eq(paymentsTable.provider, "manual")
          )
        )
        .limit(1);
      if (!payment || payment.status !== "pending") continue;

      const ok = await settlePaymentPaid(paymentId, {
        source: "manual-sheet",
        code,
        spreadsheetId,
        tab,
      });
      if (ok) result.settled++;
    } catch (err) {
      result.errors++;
      logger.error({ err, paymentId }, "manual-poller: settle failed");
    }
  }

  return result;
}
