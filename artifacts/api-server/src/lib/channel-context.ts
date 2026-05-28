import type { Request, Response } from "express";
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

// ---- Route helpers ---------------------------------------------------------
// These short-circuit error responses so handler code reads cleanly:
//   const channel = await requireConnectedChannel(req, res);
//   if (!channel) return;
// They never *throw* — they 4xx and return null so the caller can early-exit.

// For routes that operate on a single channel that MUST be connected
// (everything that talks to Baileys: send message, post status, etc.).
// Replies 401 / 400 / 503 as appropriate and returns null on failure.
export async function requireConnectedChannel(
  req: Request,
  res: Response
): Promise<ChannelRow | null> {
  const sel = await resolveActiveChannel(req);
  if (!sel) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  if (sel.kind === "all") {
    res.status(400).json({
      error: "channel_required",
      message: "Pilih channel spesifik dulu (bukan 'All channels').",
    });
    return null;
  }
  if (!sel.channel.ownerPhone || sel.channel.status !== "connected") {
    res.status(503).json({
      error: "channel_not_connected",
      message: "Hubungkan channel WhatsApp dulu sebelum melanjutkan.",
    });
    return null;
  }
  return sel.channel;
}

// Like requireConnectedChannel but accepts un-paired channels — used by
// channel-config endpoints (settings, flows, etc.) that should still be
// addressable pre-pairing so the UI can prefill them.
export async function requireOwnedChannelLoose(
  req: Request,
  res: Response
): Promise<ChannelRow | null> {
  const sel = await resolveActiveChannel(req);
  if (!sel) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  if (sel.kind === "all") {
    res.status(400).json({ error: "channel_required" });
    return null;
  }
  return sel.channel;
}

// For listing endpoints that support an "All channels" aggregate view.
// Returns the list of channel ids in scope (1 entry for a single channel,
// many for "all") plus the owner user id (useful when joining shared
// resources by userId).
export async function resolveChannelScope(
  req: Request,
  res: Response
): Promise<{ channelIds: number[]; ownerUserId: number; mode: "single" | "all" } | null> {
  const sel = await resolveActiveChannel(req);
  if (!sel) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  if (sel.kind === "channel") {
    return {
      channelIds: [sel.channel.id],
      ownerUserId: sel.channel.userId,
      mode: "single",
    };
  }
  const all = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, sel.ownerUserId));
  return {
    channelIds: all.map((r) => r.id),
    ownerUserId: sel.ownerUserId,
    mode: "all",
  };
}

// For shared resources (products / knowledge / shortcuts): they live at
// the user level and ignore the channel header for scoping. Sends 401 and
// returns null when the request isn't signed in.
export async function requireOwnerUserId(
  req: Request,
  res: Response
): Promise<number | null> {
  const sessionUid = getSessionUserId(req);
  if (sessionUid == null) {
    res.status(401).json({ error: "not_signed_in" });
    return null;
  }
  return getEffectiveOwnerUserId(sessionUid);
}

// User's primary channel's ownerPhone (lowest channel id with a paired
// ownerPhone). Transitional helper — needed only for legacy tables that
// still have ownerPhone NOT NULL and need a value at insert time. Returns
// null if the user has no paired channels yet.
export async function getOwnerPrimaryPhone(
  ownerUserId: number
): Promise<string | null> {
  const rows = await db
    .select({ ownerPhone: channelsTable.ownerPhone })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId))
    .orderBy(asc(channelsTable.id));
  for (const r of rows) {
    if (r.ownerPhone) return r.ownerPhone;
  }
  return null;
}
