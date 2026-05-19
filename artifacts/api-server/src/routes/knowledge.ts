import { Router } from "express";
import { db } from "@workspace/db";
import { knowledgeTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateKnowledgeBody,
  UpdateKnowledgeBody,
  UpdateKnowledgeParams,
  DeleteKnowledgeParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const entries = await db.select().from(knowledgeTable).orderBy(knowledgeTable.createdAt);
    res.json(
      entries.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list knowledge");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateKnowledgeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const [entry] = await db
      .insert(knowledgeTable)
      .values(parsed.data)
      .returning();

    res.status(201).json({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const idParsed = UpdateKnowledgeParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = UpdateKnowledgeBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const [updated] = await db
      .update(knowledgeTable)
      .set({ ...bodyParsed.data, updatedAt: new Date() })
      .where(eq(knowledgeTable.id, idParsed.data.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Entry not found" });

    res.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const idParsed = DeleteKnowledgeParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const deleted = await db
      .delete(knowledgeTable)
      .where(eq(knowledgeTable.id, idParsed.data.id))
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Entry not found" });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
