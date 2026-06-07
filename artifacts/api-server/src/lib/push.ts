import { and, eq, inArray, or } from "drizzle-orm";
import {
  db,
  deviceTokensTable,
  usersTable,
  channelsTable,
} from "@workspace/db";
import { getAllowedChannelIds } from "./user-channel-access";
import { logger } from "./logger";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

// Basic shape check for an Expo push token. Expo tokens look like
// `ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]` or `ExpoPushToken[...]`.
export function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token.trim());
}

// Upsert a device token for a user. Re-registering the same physical token
// re-points it at the current user (e.g. a shared device) and refreshes
// updatedAt.
export async function registerDeviceToken(
  userId: number,
  token: string,
  platform: string | null,
): Promise<void> {
  await db
    .insert(deviceTokensTable)
    .values({ userId, token, platform })
    .onConflictDoUpdate({
      target: deviceTokensTable.token,
      set: { userId, platform, updatedAt: new Date() },
    });
}

// Remove a device token (logout / token rotation). Idempotent. Scoped to the
// owning user so one account can never unregister another account's token.
export async function removeDeviceToken(
  userId: number,
  token: string,
): Promise<void> {
  await db
    .delete(deviceTokensTable)
    .where(
      and(
        eq(deviceTokensTable.token, token),
        eq(deviceTokensTable.userId, userId),
      ),
    );
}

interface ExpoMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: "default";
  badge?: number;
}

// Send a batch of messages to Expo's push service. Best-effort: logs and
// swallows failures so a push outage never breaks the message pipeline.
// Also prunes tokens Expo reports as DeviceNotRegistered.
async function sendExpoPush(messages: ExpoMessage[]): Promise<void> {
  if (messages.length === 0) return;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Expo push request failed");
      return;
    }
    const json = (await res.json()) as {
      data?: Array<{ status: string; details?: { error?: string } }>;
    };
    const tickets = json.data ?? [];
    const deadTokens: string[] = [];
    tickets.forEach((t, i) => {
      if (
        t.status === "error" &&
        t.details?.error === "DeviceNotRegistered" &&
        messages[i]
      ) {
        deadTokens.push(messages[i].to);
      }
    });
    if (deadTokens.length > 0) {
      await db
        .delete(deviceTokensTable)
        .where(inArray(deviceTokensTable.token, deadTokens))
        .catch(() => {});
    }
  } catch (err) {
    logger.warn({ err }, "Expo push send threw");
  }
}

export interface InboundPushInput {
  channelId: number;
  chatId: number;
  title: string; // contact / group name
  body: string; // message preview
}

// Notify every user in the channel's tenant who is allowed to see that channel
// (and has a registered device) about an inbound message. Fire-and-forget from
// the message pipeline — callers should NOT await this on the hot path.
export async function notifyInboundMessage(
  input: InboundPushInput,
): Promise<void> {
  try {
    const [channel] = await db
      .select({ ownerUserId: channelsTable.userId, label: channelsTable.label })
      .from(channelsTable)
      .where(eq(channelsTable.id, input.channelId))
      .limit(1);
    if (!channel) return;
    const ownerUserId = channel.ownerUserId;

    // Candidate recipients: the owner plus their invited team members.
    // Disabled accounts must never receive message previews.
    const candidates = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.status, "active"),
          or(
            eq(usersTable.id, ownerUserId),
            eq(usersTable.parentUserId, ownerUserId),
          ),
        ),
      );

    // Keep only users allowed to see this channel.
    const allowedUserIds: number[] = [];
    for (const c of candidates) {
      const allowed = await getAllowedChannelIds(c.id);
      if (allowed.has(input.channelId)) allowedUserIds.push(c.id);
    }
    if (allowedUserIds.length === 0) return;

    const tokens = await db
      .select({ token: deviceTokensTable.token })
      .from(deviceTokensTable)
      .where(inArray(deviceTokensTable.userId, allowedUserIds));
    if (tokens.length === 0) return;

    const messages: ExpoMessage[] = tokens.map((t) => ({
      to: t.token,
      title: input.title || channel.label,
      body: input.body || "Pesan baru",
      sound: "default",
      data: { chatId: input.chatId, channelId: input.channelId },
    }));
    await sendExpoPush(messages);
  } catch (err) {
    logger.warn({ err }, "notifyInboundMessage failed");
  }
}
