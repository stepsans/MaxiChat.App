import { Router } from "express";
import { db, whatsappStatusesTable, chatsTable } from "@workspace/db";
import { sql, eq, gt, desc } from "drizzle-orm";
import { getCurrentOwnerPhone, postTextStatus, refreshChatProfilePic } from "./whatsapp";
import { requireNotAgent } from "../lib/team-permissions";
import { requirePermission } from "../lib/role-permissions";

const router = Router();

// Matrix gates layered on top of the legacy requireNotAgent gate that the
// DELETE handler already declares — both must pass.
router.get("/", requirePermission("statuses", "view"));
router.post("/", requirePermission("statuses", "create"));
router.delete("/:id", requirePermission("statuses", "delete"));

// Group statuses by author and order most recent first. Filter out anything
// already past its 24h TTL — WhatsApp removes statuses then anyway.
router.get("/", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.json([]);
      return;
    }

    const now = new Date();
    const rows = await db
      .select()
      .from(whatsappStatusesTable)
      .where(
        sql`${whatsappStatusesTable.ownerPhone} = ${ownerPhone}
            AND ${whatsappStatusesTable.expiresAt} > ${now}`
      )
      .orderBy(desc(whatsappStatusesTable.postedAt));

    // Fetch profile pics from chats table (joined by author phone).
    const authorPhones = Array.from(new Set(rows.map((r) => r.authorPhone)));
    type ChatLite = {
      phoneNumber: string;
      profilePicUrl: string | null;
      contactName: string;
      nickname: string | null;
    };
    let chats: ChatLite[] = [];
    if (authorPhones.length) {
      chats = await db
        .select({
          phoneNumber: chatsTable.phoneNumber,
          profilePicUrl: chatsTable.profilePicUrl,
          contactName: chatsTable.contactName,
          nickname: chatsTable.nickname,
        })
        .from(chatsTable)
        .where(
          sql`${chatsTable.ownerPhone} = ${ownerPhone}
              AND ${chatsTable.phoneNumber} = ANY(${authorPhones.map(
                (p: string) => "+" + p
              )})`
        );
    }
    const chatByPhone = new Map(chats.map((c) => [c.phoneNumber.replace(/^\+/, ""), c]));

    // Group rows by authorJid (use authorPhone as the stable group key for
    // "Me" status grouping when posted from multiple sessions/devices).
    type AuthorGroup = {
      authorJid: string;
      authorName: string;
      authorPhone: string;
      profilePicUrl: string | null;
      isMine: boolean;
      latestPostedAt: Date;
      statuses: typeof rows;
    };
    const groups = new Map<string, AuthorGroup>();
    for (const r of rows) {
      const key = r.isMine ? "__mine__" : r.authorPhone;
      const existing = groups.get(key);
      const chat = chatByPhone.get(r.authorPhone);
      const displayName = r.isMine
        ? "Status Saya"
        : chat?.nickname ?? chat?.contactName ?? r.authorName;
      if (existing) {
        existing.statuses.push(r);
        if (r.postedAt > existing.latestPostedAt) existing.latestPostedAt = r.postedAt;
      } else {
        groups.set(key, {
          authorJid: r.authorJid,
          authorName: displayName,
          authorPhone: r.authorPhone,
          profilePicUrl: chat?.profilePicUrl ?? null,
          isMine: r.isMine,
          latestPostedAt: r.postedAt,
          statuses: [r],
        });
      }
    }

    // Sort: Mine first, then by latest post desc.
    const out = Array.from(groups.values()).sort((a, b) => {
      if (a.isMine && !b.isMine) return -1;
      if (b.isMine && !a.isMine) return 1;
      return b.latestPostedAt.getTime() - a.latestPostedAt.getTime();
    });

    // Lazy profile pic refresh for status authors (best-effort, no-await).
    for (const g of out) {
      if (g.profilePicUrl) continue;
      const chatRows = await db
        .select()
        .from(chatsTable)
        .where(
          sql`${chatsTable.ownerPhone} = ${ownerPhone} AND ${chatsTable.phoneNumber} = ${"+" + g.authorPhone}`
        )
        .limit(1);
      if (chatRows[0]) {
        void refreshChatProfilePic(req.session.userId!, chatRows[0]).catch(() => {});
      }
    }

    res.json(
      out.map((g) => ({
        authorJid: g.authorJid,
        authorName: g.authorName,
        authorPhone: g.authorPhone,
        profilePicUrl: g.profilePicUrl,
        isMine: g.isMine,
        statuses: g.statuses
          .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())
          .map((s) => ({
            id: s.id,
            statusType: s.statusType,
            textContent: s.textContent,
            backgroundColor: s.backgroundColor,
            mediaUrl: s.mediaUrl,
            caption: s.caption,
            isMine: s.isMine,
            authorName: g.authorName,
            postedAt: s.postedAt.toISOString(),
            expiresAt: s.expiresAt.toISOString(),
          })),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list statuses");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const text = String(req.body?.text ?? "").trim();
    const backgroundColor =
      typeof req.body?.backgroundColor === "string" && /^#[0-9a-fA-F]{6}$/.test(req.body.backgroundColor)
        ? (req.body.backgroundColor as string)
        : "#128c7e";
    if (!text || text.length > 700) {
      res.status(400).json({ error: "Status text must be 1-700 characters" });
      return;
    }
    const row = await postTextStatus(req.session.userId!, ownerPhone, text, backgroundColor);
    res.json({
      id: row.id,
      statusType: row.statusType,
      textContent: row.textContent,
      backgroundColor: row.backgroundColor,
      mediaUrl: row.mediaUrl,
      caption: row.caption,
      isMine: row.isMine,
      authorName: "Status Saya",
      postedAt: row.postedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to post status");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", requireNotAgent, async (req, res): Promise<void> => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      res.status(409).json({ error: "WhatsApp not connected" });
      return;
    }
    const id = parseInt(String(req.params["id"]), 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    // Owner-scoped delete — never expose another account's row.
    await db
      .delete(whatsappStatusesTable)
      .where(
        sql`${whatsappStatusesTable.id} = ${id} AND ${whatsappStatusesTable.ownerPhone} = ${ownerPhone}`
      );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete status");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
