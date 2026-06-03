import { Router } from "express";
import { db } from "@workspace/db";
import { customerLabelsTable } from "@workspace/db";
import { and, eq, asc } from "drizzle-orm";
import { z } from "zod";
import { requireOwnerUserId } from "../lib/channel-context";
import { requireSuperAdmin } from "../lib/team-permissions";

const router = Router();

// #ef4444 / #ef4444cc style hex (3/6/8 digits). Keeps storage simple and the
// UI can apply it directly as a CSS color.
const HEX_REGEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const CreateBody = z.object({
  name: z.string().trim().min(1, "Nama label wajib diisi").max(60),
  color: z.string().trim().regex(HEX_REGEX, "Warna harus berupa hex, mis. #ef4444"),
});

const UpdateBody = z.object({
  name: z.string().trim().min(1, "Nama label wajib diisi").max(60).optional(),
  color: z
    .string()
    .trim()
    .regex(HEX_REGEX, "Warna harus berupa hex, mis. #ef4444")
    .optional(),
});

function serialize(l: typeof customerLabelsTable.$inferSelect) {
  return {
    id: l.id,
    name: l.name,
    color: l.color,
    createdAt: l.createdAt.toISOString(),
  };
}

// List the owner's labels. Readable by any signed-in team member so the chat
// sidebar can render the assignment picker; mutations are super-admin-only.
router.get("/", async (req, res): Promise<void> => {
  try {
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;
    const rows = await db
      .select()
      .from(customerLabelsTable)
      .where(eq(customerLabelsTable.ownerUserId, ownerUserId))
      .orderBy(asc(customerLabelsTable.name));
    res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "Failed to list customer labels");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    const inserted = await db
      .insert(customerLabelsTable)
      .values({ ownerUserId, name: parsed.data.name, color: parsed.data.color })
      .onConflictDoNothing({
        target: [customerLabelsTable.ownerUserId, customerLabelsTable.name],
      })
      .returning();

    if (inserted.length === 0) {
      res.status(409).json({ error: `Label "${parsed.data.name}" sudah ada` });
      return;
    }
    res.status(201).json(serialize(inserted[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to create customer label");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
      return;
    }
    if (parsed.data.name === undefined && parsed.data.color === undefined) {
      res.status(400).json({ error: "Tidak ada perubahan" });
      return;
    }
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    try {
      const [updated] = await db
        .update(customerLabelsTable)
        .set(parsed.data)
        .where(
          and(
            eq(customerLabelsTable.id, id),
            eq(customerLabelsTable.ownerUserId, ownerUserId)
          )
        )
        .returning();
      if (!updated) {
        res.status(404).json({ error: "Label tidak ditemukan" });
        return;
      }
      res.json(serialize(updated));
    } catch (e: any) {
      if (e?.code === "23505") {
        res.status(409).json({ error: `Label "${parsed.data.name}" sudah ada` });
        return;
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update customer label");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", requireSuperAdmin, async (req, res): Promise<void> => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const ownerUserId = await requireOwnerUserId(req, res);
    if (ownerUserId == null) return;

    // contact_labels rows cascade-delete via the FK, so unassigning is automatic.
    const deleted = await db
      .delete(customerLabelsTable)
      .where(
        and(
          eq(customerLabelsTable.id, id),
          eq(customerLabelsTable.ownerUserId, ownerUserId)
        )
      )
      .returning({ id: customerLabelsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Label tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete customer label");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
