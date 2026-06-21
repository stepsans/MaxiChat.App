import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  workboardNotificationsTable,
} from "@workspace/db";
import { resolveOwnerUserId } from "./seed";
import { notifyUsersPush } from "./push";
import { logger } from "./logger";

// Deliver a WorkBoard @mention to each mentioned user: write an in-app
// notification row (powers the bell) AND send an Expo push with a board+task
// deep-link. Best-effort end-to-end — the caller already wraps this in try/catch
// so a notify failure never fails the comment write.
export async function notifyWorkboardMentions(params: {
  mentionedUserIds: number[];
  boardId: number;
  taskId: number;
  taskTitle: string;
  commentId: number;
  authorUserId: number;
}): Promise<void> {
  const { mentionedUserIds, boardId, taskId, commentId, authorUserId } = params;
  if (mentionedUserIds.length === 0) return;

  // Tenant scope = the author's owner (members share one tenant).
  const ownerUserId = await resolveOwnerUserId(authorUserId);

  // In-app rows (one per recipient) — bell list + unread count read from here.
  await db.insert(workboardNotificationsTable).values(
    mentionedUserIds.map((recipientUserId) => ({
      recipientUserId,
      ownerUserId,
      actorUserId: authorUserId,
      boardId,
      taskId,
      commentId,
      type: "mention",
    }))
  );

  // Mobile push with deep-link (best-effort).
  try {
    const [author] = await db
      .select({ name: usersTable.name, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, authorUserId))
      .limit(1);
    const actorName = author?.name ?? author?.email ?? "Seseorang";
    await notifyUsersPush({
      userIds: mentionedUserIds,
      title: "Anda disebut di WorkBoard",
      body: `${actorName} menyebut Anda di task "${params.taskTitle}"`,
      data: { type: "workboard_mention", boardId, taskId, commentId },
    });
  } catch (err) {
    logger.warn({ err }, "workboard mention push failed");
  }
}
