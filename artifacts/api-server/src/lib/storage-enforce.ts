import { sql, eq } from "drizzle-orm";
import { db, mediaObjectsTable, tenantQuotaTable } from "@workspace/db";
import { getStorageConfig } from "./storage-config";
import { isInfinityOwner } from "./infinity-owner";
import { isStorageWritable } from "./storage-quota";

// Compact human-readable bytes for the user-facing block message (e.g. "1.5 GB").
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

// Storage enforcement for USER-INITIATED uploads (Billing v2 — FASE C). This is
// deliberately NOT applied to inbound WhatsApp media ingestion — dropping a
// customer's incoming media would break the core data flow, so ingestion is
// always allowed and only metered.
//
// Enforcement is fully gated: it is a no-op unless the operator has turned on
// `enforcementEnabled` in the storage singleton. Even then, a tenant with no
// plafon (storageLimit <= 0) and the Owner Infinity account are never blocked.

export interface StorageCheckResult {
  ok: boolean;
  // Indonesian, user-facing message when ok=false.
  message?: string;
  usedBytes?: number;
  limitBytes?: number;
}

const OK: StorageCheckResult = { ok: true };

// Decide whether `incomingBytes` more may be stored for this owner. Returns
// `{ ok: true }` for every disabled/exempt/unprovisioned case so callers can
// guard uploads with a single branch.
export async function checkStorageQuota(
  ownerUserId: number,
  incomingBytes: number
): Promise<StorageCheckResult> {
  const config = await getStorageConfig();
  if (!config.enforcementEnabled) return OK;

  if (await isInfinityOwner(ownerUserId)) return OK;

  const [quota] = await db
    .select({ limit: tenantQuotaTable.storageLimit })
    .from(tenantQuotaTable)
    .where(eq(tenantQuotaTable.userId, ownerUserId))
    .limit(1);
  const limitBytes = Number(quota?.limit ?? 0);
  // Unprovisioned (no plafon) → never block; provisioning is a prerequisite for
  // enforcement, not a side effect of it.
  if (limitBytes <= 0) return OK;

  const [mediaAgg] = await db
    .select({
      bytes: sql<string>`coalesce(sum(${mediaObjectsTable.sizeBytes}), 0)::bigint`,
    })
    .from(mediaObjectsTable)
    .where(eq(mediaObjectsTable.ownerUserId, ownerUserId));
  const usedBytes = Number(mediaAgg?.bytes ?? 0);

  if (isStorageWritable(usedBytes, incomingBytes, limitBytes, config.gracePercent)) {
    return OK;
  }

  return {
    ok: false,
    usedBytes,
    limitBytes,
    message: `Penyimpanan penuh: terpakai ${formatBytes(usedBytes)} dari ${formatBytes(limitBytes)}. Hapus media lama atau tambah kuota penyimpanan untuk mengunggah lagi.`,
  };
}
