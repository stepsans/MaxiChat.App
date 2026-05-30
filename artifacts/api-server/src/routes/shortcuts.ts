import { Router } from "express";
import { db, textShortcutsTable } from "@workspace/db";
import { sql, desc } from "drizzle-orm";
import {
  requireOwnerUserId,
  getOwnerPrimaryPhone,
} from "../lib/channel-context";
import {
  parseChannelIdsInput,
  replaceChannelAssignments,
  verifyChannelOwnership,
  loadChannelIdsBatch,
} from "../lib/channel-assignments";

const router = Router();

// Shortcuts are a shared resource (per-user, available to every channel).
// Reads scope by user_id. Writes also need owner_phone as long as the legacy
// NOT NULL column is still on the table — derive it from the user's primary
// channel; if the user has no paired channel yet, writes 409 with a clear
// message ("Hubungkan WhatsApp dulu").

async function resolveWriteOwner(
  req: Parameters<typeof requireOwnerUserId>[0],
  res: Parameters<typeof requireOwnerUserId>[1]
): Promise<{ ownerUserId: number; ownerPhone: string } | null> {
  const ownerUserId = await requireOwnerUserId(req, res);
  if (ownerUserId == null) return null;
  const ownerPhone = await getOwnerPrimaryPhone(ownerUserId);
  if (!ownerPhone) {
    res
      .status(409)
      .json({ error: "Hubungkan WhatsApp dulu sebelum menambah shortcut." });
    return null;
  }
  return { ownerUserId, ownerPhone };
}

// Normalize an optional `link` body field. Empty/whitespace → null (clears the
// link). A non-empty value over 2000 chars is rejected. Returns "invalid" so
// callers can 400 without throwing.
function normalizeLinkInput(input: unknown): string | null | "invalid" {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (s.length > 2000) return "invalid";
  return s;
}

function rowToDto(
  r: typeof textShortcutsTable.$inferSelect,
  channelIds: number[]
) {
  return {
    id: r.id,
    shortcut: r.shortcut,
    replacement: r.replacement,
    link: r.link ?? null,
    channelIds,
  };
}

router.get("/", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const rows = await db
      .select()
      .from(textShortcutsTable)
      .where(sql`${textShortcutsTable.userId} = ${ownerUserId}`)
      .orderBy(desc(textShortcutsTable.updatedAt));
    const joins = await loadChannelIdsBatch(
      "shortcut",
      rows.map((r) => r.id)
    );
    res.json(rows.map((r) => rowToDto(r, joins.get(r.id) ?? [])));
  } catch (err) {
    req.log.error({ err }, "Failed to list shortcuts");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res): Promise<void> => {
  try {
    const owner = await resolveWriteOwner(req, res);
    if (!owner) return;
    const shortcut = String(req.body?.shortcut ?? "").trim();
    const replacement = String(req.body?.replacement ?? "").trimEnd();
    if (!shortcut || shortcut.length > 64) {
      res.status(400).json({ error: "Shortcut must be 1-64 characters" });
      return;
    }
    if (!replacement || replacement.length > 4000) {
      res.status(400).json({ error: "Replacement must be 1-4000 characters" });
      return;
    }
    const link = normalizeLinkInput(req.body?.link);
    if (link === "invalid") {
      res.status(400).json({ error: "Link must be 2000 characters or fewer" });
      return;
    }
    const channelIds = parseChannelIdsInput(req.body?.channelIds);
    if (channelIds === "invalid") {
      res.status(400).json({ error: "Invalid channelIds" });
      return;
    }
    try {
      const [row] = await db
        .insert(textShortcutsTable)
        .values({
          userId: owner.ownerUserId,
          shortcut,
          replacement,
          link,
        })
        .returning();
      const assigned = await replaceChannelAssignments(
        "shortcut",
        row.id,
        channelIds,
        owner.ownerUserId
      );
      if (assigned === "forbidden") {
        await db
          .delete(textShortcutsTable)
          .where(sql`${textShortcutsTable.id} = ${row.id}`);
        res.status(400).json({ error: "Invalid channelIds" });
        return;
      }
      res.json(rowToDto(row, channelIds ?? []));
    } catch (err: any) {
      // 23505 = unique violation (per-user, lower(shortcut)).
      if (err?.code === "23505") {
        res.status(409).json({ error: "Shortcut sudah ada" });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const shortcut = String(req.body?.shortcut ?? "").trim();
    const replacement = String(req.body?.replacement ?? "").trimEnd();
    if (!shortcut || shortcut.length > 64 || !replacement || replacement.length > 4000) {
      res.status(400).json({ error: "Invalid shortcut or replacement" });
      return;
    }
    const link = normalizeLinkInput(req.body?.link);
    if (link === "invalid") {
      res.status(400).json({ error: "Link must be 2000 characters or fewer" });
      return;
    }
    const channelIds = parseChannelIdsInput(req.body?.channelIds);
    if (channelIds === "invalid") {
      res.status(400).json({ error: "Invalid channelIds" });
      return;
    }
    // Pre-flight ownership check so a forbidden channelId fails the request
    // BEFORE the row update commits (avoids partial writes).
    if ((await verifyChannelOwnership(ownerUserId, channelIds)) === "forbidden") {
      res.status(400).json({ error: "Invalid channelIds" });
      return;
    }
    try {
      const [row] = await db
        .update(textShortcutsTable)
        .set({ shortcut, replacement, link, updatedAt: new Date() })
        .where(
          sql`${textShortcutsTable.id} = ${id} AND ${textShortcutsTable.userId} = ${ownerUserId}`
        )
        .returning();
      if (!row) {
        res.status(404).json({ error: "Shortcut not found" });
        return;
      }
      await replaceChannelAssignments("shortcut", row.id, channelIds, ownerUserId);
      const joins = await loadChannelIdsBatch("shortcut", [row.id]);
      res.json(rowToDto(row, joins.get(row.id) ?? []));
    } catch (err: any) {
      if (err?.code === "23505") {
        res.status(409).json({ error: "Shortcut sudah ada" });
        return;
      }
      throw err;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    await db
      .delete(textShortcutsTable)
      .where(
        sql`${textShortcutsTable.id} = ${id} AND ${textShortcutsTable.userId} = ${ownerUserId}`
      );
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete shortcut");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
