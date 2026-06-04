import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { google } from "googleapis";
import {
  db,
  pool,
  salesOrdersTable,
  salesOrderItemsTable,
  salesOrderSyncConfigTable,
  productsTable,
  chatsTable,
  channelsTable,
  credentialsTable,
  type SalesOrder,
  type SalesOrderItem,
  type SalesOrderSyncConfig,
  type Credential,
} from "@workspace/db";
import { getAuthorizedOAuthClient } from "../routes/credentials";
import { getLiveOwnerNameForChannel } from "../routes/whatsapp";

// Fixed column layout for the sales-order export. One row per line item; the
// order-level fields repeat on each of an order's rows. Kept here (not in the
// route) so the per-order ("Simpan ke Sheet") path, the bulk "Sync sekarang"
// path, and the auto-sync scheduler all write an identical layout.
export const SALES_ORDER_SHEET_HEADER = [
  "Tanggal",
  "No Order",
  "Kode Customer",
  "Nama Customer",
  "No HP",
  "Kode Barang",
  "Nama Barang",
  "Qty",
  "Harga",
  "Subtotal Item",
  "Diskon Item",
  "Subtotal",
  "Diskon Keseluruhan",
  "PPN",
  "Total",
  "Status",
  "Catatan",
  "Served By",
] as const;

// A1 column letter for the last header column (so reads/header rewrites stay in
// lockstep with the layout above; A..R == 18 columns).
const LAST_COL = "R";

// Build the Sheet rows for one order. Does the per-order live lookups (product
// kode barang, chat kode customer + "Served By") so each export reflects the
// current catalog/chat state, with snapshots as fallback. The "Tanggal" column
// uses the order's own creation date — not the sync date — so bulk/auto exports
// of historical orders carry the correct date.
async function buildOrderRows(
  order: SalesOrder,
  items: SalesOrderItem[],
  ownerUserId: number
): Promise<(string | number)[][]> {
  const sorted = items
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const productIds = sorted
    .map((it) => it.productId)
    .filter((x): x is number => x != null);
  const codeByProductId = new Map<number, string>();
  if (productIds.length > 0) {
    const prods = await db
      .select({ id: productsTable.id, code: productsTable.code })
      .from(productsTable)
      .where(
        and(
          eq(productsTable.userId, ownerUserId),
          inArray(productsTable.id, productIds)
        )
      );
    for (const p of prods) codeByProductId.set(p.id, p.code);
  }
  const kodeBarang = (it: SalesOrderItem): string =>
    it.productId != null
      ? codeByProductId.get(it.productId) ?? it.code ?? ""
      : "";

  let customerCode = "";
  let servedBy = "";
  if (order.chatId != null) {
    const [chatRow] = await db
      .select({
        customerCode: chatsTable.customerCode,
        channelId: channelsTable.id,
        ownerName: channelsTable.ownerName,
      })
      .from(chatsTable)
      .innerJoin(channelsTable, eq(chatsTable.channelId, channelsTable.id))
      .where(
        and(
          eq(chatsTable.id, order.chatId),
          eq(channelsTable.userId, ownerUserId)
        )
      )
      .limit(1);
    customerCode = chatRow?.customerCode ?? "";
    if (chatRow) {
      servedBy =
        chatRow.ownerName ??
        getLiveOwnerNameForChannel(chatRow.channelId, ownerUserId) ??
        "";
    }
  }

  const dateIso = order.createdAt.toISOString().slice(0, 10);
  const orderPpn = order.ppnEnabled ? order.ppnAmount : 0;
  const buildRow = (it: SalesOrderItem | null): (string | number)[] => [
    dateIso,
    String(order.id),
    customerCode,
    order.customerName ?? "",
    order.customerPhone ?? "",
    it ? kodeBarang(it) : "",
    it ? it.name : "",
    it ? it.qty : "",
    it ? it.price : "",
    it ? it.qty * it.price : "",
    it ? it.qty * it.price - it.lineTotal : "",
    order.subtotal,
    order.discountAmount,
    orderPpn,
    order.total,
    order.status,
    order.note ?? "",
    servedBy,
  ];
  return sorted.length > 0 ? sorted.map((it) => buildRow(it)) : [buildRow(null)];
}

// Classification of a Google Sheets write failure into a user-actionable
// message. Only a genuine token/scope failure is fixed by reconnecting; a bare
// 403 usually means the spreadsheet just isn't shared with the connected
// account. Shared by every export path so error messaging stays consistent.
export type SheetErrorInfo = {
  apiMessage: string;
  httpStatus: number | undefined;
  isAuthScopeError: boolean;
  isAclError: boolean;
  userError: string;
};

export function classifySheetError(err: unknown): SheetErrorInfo {
  const e = err as {
    message?: string;
    code?: number;
    status?: number;
    response?: { status?: number; data?: { error?: { message?: string } } };
  };
  const httpStatus = e.code ?? e.status ?? e.response?.status;
  const apiMessage = e.response?.data?.error?.message ?? e.message ?? "";
  const isAuthScopeError =
    httpStatus === 401 ||
    /insufficient.*scope|insufficient authentication|access_token_scope_insufficient|invalid_grant|invalid_token|invalid authentication credentials|unauthorized/i.test(
      apiMessage
    );
  const isAclError =
    !isAuthScopeError &&
    (httpStatus === 403 ||
      /permission|forbidden|does not have access/i.test(apiMessage));
  let userError: string;
  if (isAuthScopeError) {
    userError =
      "Izin tulis ke Google Sheet belum diberikan. Buka halaman Credentials, klik Reconnect pada credential Google untuk memberi akses tulis (write), lalu coba simpan lagi.";
  } else if (isAclError) {
    userError =
      "Akun Google tidak punya akses ke spreadsheet ini. Bagikan (share) spreadsheet ke akun Google yang terhubung dengan izin Editor, lalu coba lagi.";
  } else {
    userError = "Gagal menulis ke Google Sheet. Cek koneksi/izin.";
  }
  return { apiMessage, httpStatus, isAuthScopeError, isAclError, userError };
}

// Typed precondition failures so the HTTP route can map each to the right
// status while the scheduler can simply log+skip. "sheet-write" carries the raw
// Google error in `cause` for classifySheetError.
export type SalesOrderSyncErrorKind =
  | "no-phone"
  | "not-configured"
  | "no-credential"
  | "not-connected"
  | "not-found"
  | "sheet-write";

export class SalesOrderSyncError extends Error {
  constructor(
    public kind: SalesOrderSyncErrorKind,
    message: string,
    public override cause?: unknown
  ) {
    super(message);
    this.name = "SalesOrderSyncError";
  }
}

// Write a batch of orders' rows into the configured tab. Serializes concurrent
// syncs on the SAME spreadsheet tab with a Postgres advisory lock (held across
// all server instances), seeds/repairs the header row, and de-dupes by "No
// Order" (column B) so re-exporting an order UPDATES its block in place rather
// than appending a duplicate. Throws the raw Google error on failure.
async function writeOrdersToSheet(
  cfg: SalesOrderSyncConfig,
  cred: Credential,
  prepared: { orderId: number; rows: (string | number)[][] }[]
): Promise<number> {
  const auth = await getAuthorizedOAuthClient(cred);
  const sheets = google.sheets({ version: "v4", auth });
  const lockKey = `sales-order-sheet:${cfg.spreadsheetId}:${cfg.sheetName}`;
  const lockClient = await pool.connect();
  let rowsWritten = 0;
  try {
    await lockClient.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      lockKey,
    ]);

    // Seed/repair the header (row 1). Legacy tabs carry an older header; rewrite
    // it in place so header and data never drift.
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheetId,
      range: `${cfg.sheetName}!A1:${LAST_COL}1`,
    });
    const firstRow = existing.data.values?.[0] ?? [];
    let isEmpty = firstRow.length === 0;
    const headerMatches =
      firstRow.length === SALES_ORDER_SHEET_HEADER.length &&
      SALES_ORDER_SHEET_HEADER.every((h, i) => firstRow[i] === h);
    if (!isEmpty && !headerMatches) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: cfg.spreadsheetId,
        range: `${cfg.sheetName}!A1:${LAST_COL}1`,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [SALES_ORDER_SHEET_HEADER as unknown as string[]] },
      });
    }

    // Resolve the numeric sheetId once (needed for row deletes) only if there's
    // existing data we might need to de-dupe against.
    let sheetId: number | null | undefined;
    const resolveSheetId = async (): Promise<number> => {
      if (sheetId == null) {
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: cfg.spreadsheetId,
          fields: "sheets.properties(sheetId,title)",
        });
        sheetId = meta.data.sheets?.find(
          (s) => s.properties?.title === cfg.sheetName
        )?.properties?.sheetId;
        if (sheetId == null) {
          throw new Error(
            `Tab "${cfg.sheetName}" tidak ditemukan di spreadsheet`
          );
        }
      }
      return sheetId;
    };

    for (const { orderId, rows } of prepared) {
      // De-dupe: delete any rows already carrying this No Order so a re-export
      // updates the block in place. Snapshot column B fresh each iteration since
      // prior appends in this batch shift indices.
      if (!isEmpty) {
        const noOrder = String(orderId);
        const colB = await sheets.spreadsheets.values.get({
          spreadsheetId: cfg.spreadsheetId,
          range: `${cfg.sheetName}!B2:B`,
        });
        const bVals = colB.data.values ?? [];
        const matchIdx: number[] = [];
        for (let i = 0; i < bVals.length; i++) {
          if ((bVals[i]?.[0] ?? "") === noOrder) matchIdx.push(i + 1);
        }
        if (matchIdx.length > 0) {
          const id = await resolveSheetId();
          const sortedIdx = matchIdx.slice().sort((a, b) => a - b);
          const ranges: { start: number; end: number }[] = [];
          for (const idx of sortedIdx) {
            const last = ranges[ranges.length - 1];
            if (last && idx === last.end) last.end = idx + 1;
            else ranges.push({ start: idx, end: idx + 1 });
          }
          const requests = ranges
            .slice()
            .reverse()
            .map((r) => ({
              deleteDimension: {
                range: {
                  sheetId: id,
                  dimension: "ROWS" as const,
                  startIndex: r.start,
                  endIndex: r.end,
                },
              },
            }));
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId: cfg.spreadsheetId,
            requestBody: { requests },
          });
        }
      }

      const values = isEmpty
        ? [SALES_ORDER_SHEET_HEADER as unknown as string[], ...rows]
        : rows;
      await sheets.spreadsheets.values.append({
        spreadsheetId: cfg.spreadsheetId,
        range: cfg.sheetName,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values },
      });
      rowsWritten += rows.length;
      // After the first append the tab is no longer empty, so subsequent orders
      // in this batch must de-dupe and must not re-emit the header.
      isEmpty = false;
    }
  } finally {
    try {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey]
      );
    } finally {
      lockClient.release();
    }
  }
  return rowsWritten;
}

export type SalesOrderSyncResult = {
  synced: number;
  rows: number;
  syncedAt: string | null;
};

// Core export shared by the per-order route, the manual "Sync sekarang" route,
// and the auto-sync scheduler. Resolves the owner's config + credential by
// (userId, ownerPhone) so a reassigned phone can never run/mutate the prior
// tenant's binding — callers MUST pass the authenticated owner's userId, not
// trust the row's userId. When `orderId` is given, re-exports just that order
// (any sync state); otherwise exports every order not yet pushed
// (synced_to_sheet_at IS NULL). On success marks the exported orders + records
// config status; on a sheet-write failure records the error on the config (and
// flags the credential on a real auth/scope error) then throws a
// SalesOrderSyncError so callers can map it.
export async function runSalesOrderSyncForOwner(
  ownerUserId: number,
  ownerPhone: string,
  opts: { orderId?: number } = {}
): Promise<SalesOrderSyncResult> {
  const [cfg] = await db
    .select()
    .from(salesOrderSyncConfigTable)
    .where(
      and(
        eq(salesOrderSyncConfigTable.userId, ownerUserId),
        eq(salesOrderSyncConfigTable.ownerPhone, ownerPhone)
      )
    )
    .limit(1);
  if (!cfg) {
    throw new SalesOrderSyncError(
      "not-configured",
      "Google Sheet untuk sales order belum dikonfigurasi."
    );
  }

  const [cred] = await db
    .select()
    .from(credentialsTable)
    .where(
      and(
        eq(credentialsTable.id, cfg.credentialId),
        eq(credentialsTable.userId, ownerUserId)
      )
    )
    .limit(1);
  if (!cred) {
    throw new SalesOrderSyncError(
      "no-credential",
      "Credential tidak ditemukan"
    );
  }
  if (cred.status !== "connected") {
    throw new SalesOrderSyncError(
      "not-connected",
      "Credential belum terhubung. Reconnect dulu."
    );
  }

  // Select which orders to export.
  let orders: SalesOrder[];
  if (opts.orderId != null) {
    const [order] = await db
      .select()
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.id, opts.orderId),
          eq(salesOrdersTable.userId, ownerUserId)
        )
      )
      .limit(1);
    if (!order) {
      throw new SalesOrderSyncError("not-found", "Order tidak ditemukan");
    }
    orders = [order];
  } else {
    orders = await db
      .select()
      .from(salesOrdersTable)
      .where(
        and(
          eq(salesOrdersTable.userId, ownerUserId),
          isNull(salesOrdersTable.syncedToSheetAt)
        )
      )
      .orderBy(asc(salesOrdersTable.id));
  }

  // Nothing pending: still advance the watermark + status so the auto-sync
  // scheduler honours the configured interval (it gates on lastSyncedAt) and the
  // UI shows the run completed. Mirrors the product sync, which updates
  // lastSyncedAt on every run regardless of how many rows changed.
  if (orders.length === 0) {
    const now = new Date();
    await db
      .update(salesOrderSyncConfigTable)
      .set({
        lastSyncedAt: now,
        lastSyncStatus: "ok",
        lastSyncError: null,
        updatedAt: now,
      })
      .where(eq(salesOrderSyncConfigTable.id, cfg.id));
    return { synced: 0, rows: 0, syncedAt: now.toISOString() };
  }

  const orderIds = orders.map((o) => o.id);
  const allItems = await db
    .select()
    .from(salesOrderItemsTable)
    .where(inArray(salesOrderItemsTable.orderId, orderIds));
  const itemsByOrder = new Map<number, SalesOrderItem[]>();
  for (const it of allItems) {
    const list = itemsByOrder.get(it.orderId);
    if (list) list.push(it);
    else itemsByOrder.set(it.orderId, [it]);
  }

  const prepared: { orderId: number; rows: (string | number)[][] }[] = [];
  for (const order of orders) {
    const rows = await buildOrderRows(
      order,
      itemsByOrder.get(order.id) ?? [],
      ownerUserId
    );
    prepared.push({ orderId: order.id, rows });
  }

  let rowsWritten: number;
  try {
    rowsWritten = await writeOrdersToSheet(cfg, cred, prepared);
  } catch (err) {
    const info = classifySheetError(err);
    await db
      .update(salesOrderSyncConfigTable)
      .set({
        lastSyncStatus: "error",
        lastSyncError: info.apiMessage || "Gagal menulis ke Sheet",
        updatedAt: new Date(),
      })
      .where(eq(salesOrderSyncConfigTable.id, cfg.id));
    if (info.isAuthScopeError) {
      await db
        .update(credentialsTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(credentialsTable.id, cred.id));
    }
    throw new SalesOrderSyncError(
      "sheet-write",
      info.userError,
      err
    );
  }

  const now = new Date();
  await db
    .update(salesOrderSyncConfigTable)
    .set({
      lastSyncedAt: now,
      lastSyncStatus: "ok",
      lastSyncError: null,
      updatedAt: now,
    })
    .where(eq(salesOrderSyncConfigTable.id, cfg.id));
  await db
    .update(salesOrdersTable)
    .set({ syncedToSheetAt: now, updatedAt: now })
    .where(inArray(salesOrdersTable.id, orderIds));

  return { synced: orders.length, rows: rowsWritten, syncedAt: now.toISOString() };
}
