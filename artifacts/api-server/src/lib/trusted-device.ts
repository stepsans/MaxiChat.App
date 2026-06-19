import crypto from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, trustedDevicesTable } from "@workspace/db";

const TD_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 hari
export const TD_COOKIE = "mc_td";

function sha256(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}

// Build a short, human-friendly device label from a User-Agent string,
// e.g. "Chrome · Windows". Best-effort — falls back to "Perangkat".
export function deviceLabelFromUA(ua: string | undefined): string {
  if (!ua) return "Perangkat";
  const browser =
    /Edg\//.test(ua) ? "Edge" :
    /OPR\//.test(ua) ? "Opera" :
    /Chrome\//.test(ua) ? "Chrome" :
    /Firefox\//.test(ua) ? "Firefox" :
    /Safari\//.test(ua) ? "Safari" :
    "Browser";
  const os =
    /Windows/.test(ua) ? "Windows" :
    /Android/.test(ua) ? "Android" :
    /(iPhone|iPad|iOS)/.test(ua) ? "iOS" :
    /Mac OS X|Macintosh/.test(ua) ? "macOS" :
    /Linux/.test(ua) ? "Linux" :
    "";
  return os ? `${browser} · ${os}` : browser;
}

// Buat token baru + simpan hash. Mengembalikan token MENTAH (dikirim ke client).
export async function issueTrustedDevice(
  userId: number,
  label?: string,
  userAgent?: string,
  ipAddress?: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + TD_TTL_MS);
  await db.insert(trustedDevicesTable).values({
    userId,
    tokenHash: sha256(token),
    label: label ?? null,
    userAgent: userAgent ?? null,
    ipAddress: ipAddress ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

// Validasi token utk user tertentu. Jika valid, ROTASI (cabut lama, terbit baru)
// dan kembalikan token baru. Null = tidak valid → caller jatuh ke alur OTP.
export async function consumeTrustedDevice(
  userId: number,
  rawToken: string | undefined,
  userAgent?: string,
  ipAddress?: string
): Promise<{ token: string; expiresAt: Date } | null> {
  if (!rawToken) return null;
  const now = new Date();
  const [row] = await db
    .select()
    .from(trustedDevicesTable)
    .where(
      and(
        eq(trustedDevicesTable.userId, userId),
        eq(trustedDevicesTable.tokenHash, sha256(rawToken)),
        isNull(trustedDevicesTable.revokedAt),
        gt(trustedDevicesTable.expiresAt, now)
      )
    )
    .limit(1);
  if (!row) return null;

  // Rotasi: cabut baris lama, terbitkan token baru (sliding 30 hari).
  await db
    .update(trustedDevicesTable)
    .set({ revokedAt: now, lastUsedAt: now })
    .where(eq(trustedDevicesTable.id, row.id));
  return issueTrustedDevice(
    userId,
    row.label ?? undefined,
    userAgent ?? row.userAgent ?? undefined,
    ipAddress
  );
}

export async function revokeTrustedDevice(
  userId: number,
  deviceId: number
): Promise<boolean> {
  const res = await db
    .update(trustedDevicesTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(trustedDevicesTable.id, deviceId),
        eq(trustedDevicesTable.userId, userId),
        isNull(trustedDevicesTable.revokedAt)
      )
    )
    .returning({ id: trustedDevicesTable.id });
  return res.length > 0;
}

// Cabut SEMUA perangkat user (dipakai owner atas anggota tim & saat disable akun).
export async function revokeAllTrustedDevices(userId: number): Promise<void> {
  await db
    .update(trustedDevicesTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(trustedDevicesTable.userId, userId),
        isNull(trustedDevicesTable.revokedAt)
      )
    );
}
