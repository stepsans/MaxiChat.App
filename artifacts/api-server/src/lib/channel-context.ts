import type { Request } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, channelsTable } from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "./auth";

export type ChannelRow = typeof channelsTable.$inferSelect;

// Sentinel for "All channels" aggregate view. Frontend sets
// `X-Channel-Id: all`; consumers that support aggregation check
// for this explicitly. Most per-channel routes treat it as a 400.
export const ALL_CHANNELS = "all" as const;
export type ActiveChannelSelection =
  | { kind: "channel"; channel: ChannelRow }
  | { kind: "all"; ownerUserId: number };

function readHeader(req: Request): string | null {
  const raw =
    (req.headers["x-channel-id"] as string | string[] | undefined) ??
    (req.query?.channelId as string | undefined);
  if (raw == null) return null;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = (v ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Look up a channel by id and confirm it belongs to the signed-in user's
// owning account (super_admin → self; supervisor/agent → parent). Returns
// null on ownership mismatch / not found so callers can 403/404 cleanly.
export async function loadOwnedChannel(
  req: Request,
  channelId: number
): Promise<ChannelRow | null> {
  const sessionUid = getSessionUserId(req);
  if (sessionUid == null) return null;
  const ownerUid = await getEffectiveOwnerUserId(sessionUid);
  const [row] = await db
    .select()
    .from(channelsTable)
    .where(
      and(eq(channelsTable.id, channelId), eq(channelsTable.userId, ownerUid))
    )
    .limit(1);
  return row ?? null;
}

// Resolve the request's "active channel" for routes that operate on a
// single channel's scope. Order:
//   1. X-Channel-Id header (numeric) → validate ownership, return that row.
//   2. X-Channel-Id: "all" → return { kind: "all" } sentinel.
//   3. No header → return the user's primary (lowest-id) channel, or null
//      if they have none (shouldn't happen post-seed).
export async function resolveActiveChannel(
  req: Request
): Promise<ActiveChannelSelection | null> {
  const sessionUid = getSessionUserId(req);
  if (sessionUid == null) return null;
  const ownerUid = await getEffectiveOwnerUserId(sessionUid);

  const raw = readHeader(req);
  if (raw === ALL_CHANNELS) {
    return { kind: "all", ownerUserId: ownerUid };
  }
  if (raw != null) {
    const id = Number.parseInt(raw, 10);
    if (!Number.isFinite(id) || id <= 0) return null;
    const [row] = await db
      .select()
      .from(channelsTable)
      .where(and(eq(channelsTable.id, id), eq(channelsTable.userId, ownerUid)))
      .limit(1);
    if (!row) return null;
    return { kind: "channel", channel: row };
  }

  // No header → primary channel (lowest id for the owner).
  const [primary] = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUid))
    .orderBy(asc(channelsTable.id))
    .limit(1);
  return primary ? { kind: "channel", channel: primary } : null;
}

// List every channel owned by the signed-in user (resolved via parent for
// invited agents). Ordered by id so the dropdown is stable.
export async function listOwnedChannels(req: Request): Promise<ChannelRow[]> {
  const sessionUid = getSessionUserId(req);
  if (sessionUid == null) return [];
  const ownerUid = await getEffectiveOwnerUserId(sessionUid);
  return db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUid))
    .orderBy(asc(channelsTable.id));
}
