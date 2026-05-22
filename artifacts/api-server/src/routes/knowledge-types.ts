import { Router } from "express";
import { db } from "@workspace/db";
import { knowledgeTypesTable, knowledgeTable } from "@workspace/db";
import { and, eq, asc, sql } from "drizzle-orm";
import { z } from "zod";
import { getCurrentOwnerPhone } from "./whatsapp";

const router = Router();

const VALUE_REGEX = /^[a-z0-9][a-z0-9_-]{0,30}$/;

const CreateBody = z.object({
  value: z
    .string()
    .trim()
    .min(1, "value wajib diisi")
    .max(31)
    .regex(VALUE_REGEX, "value hanya huruf kecil, angka, '-' atau '_'"),
  label: z.string().trim().min(1, "label wajib diisi").max(60),
});

function serialize(t: typeof knowledgeTypesTable.$inferSelect) {
  return {
    id: t.id,
    value: t.value,
    label: t.label,
    createdAt: t.createdAt.toISOString(),
  };
}

const DEFAULT_TYPES: { value: string; label: string }[] = [
  { value: "product", label: "Product" },
  { value: "faq", label: "FAQ" },
  { value: "script", label: "Sales Script" },
  { value: "testimonial", label: "Testimonial" },
  { value: "website", label: "Website" },
];

// Per-owner seed: each WhatsApp account gets its own copy of the default
// knowledge types the first time they connect, so operators can immediately
// start categorizing entries. Tracked in-memory per ownerPhone to avoid
// repeated existence checks once seeded.
const seededOwners = new Set<string>();
export async function ensureKnowledgeTypesSeed(ownerPhone: string): Promise<void> {
  if (seededOwners.has(ownerPhone)) return;
  const existing = await db
    .select({ id: knowledgeTypesTable.id })
    .from(knowledgeTypesTable)
    .where(eq(knowledgeTypesTable.ownerPhone, ownerPhone))
    .limit(1);
  if (existing.length === 0) {
    await db
      .insert(knowledgeTypesTable)
      .values(DEFAULT_TYPES.map((d) => ({ ...d, ownerPhone })))
      .onConflictDoNothing();
  }
  seededOwners.add(ownerPhone);
}

router.get("/", async (req, res) => {
  try {
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) return res.json([]);
    await ensureKnowledgeTypesSeed(ownerPhone);
    const rows = await db
      .select()
      .from(knowledgeTypesTable)
      .where(eq(knowledgeTypesTable.ownerPhone, ownerPhone))
      .orderBy(asc(knowledgeTypesTable.id));
    res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "Failed to list knowledge types");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid body" });
    }
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menambah type." });
    }
    const value = parsed.data.value.toLowerCase();
    const label = parsed.data.label;

    const inserted = await db
      .insert(knowledgeTypesTable)
      .values({ ownerPhone, value, label })
      .onConflictDoNothing({
        target: [knowledgeTypesTable.ownerPhone, knowledgeTypesTable.value],
      })
      .returning();

    if (inserted.length === 0) {
      return res.status(409).json({ error: `Type "${value}" sudah ada` });
    }
    res.status(201).json(serialize(inserted[0]));
  } catch (err) {
    req.log.error({ err }, "Failed to create knowledge type");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const ownerPhone = await getCurrentOwnerPhone(req.session.userId!);
    if (!ownerPhone) {
      return res
        .status(503)
        .json({ error: "Hubungkan WhatsApp dulu sebelum menghapus type." });
    }
    const result = await db.transaction(async (tx) => {
      const [type] = await tx
        .select()
        .from(knowledgeTypesTable)
        .where(and(eq(knowledgeTypesTable.id, id), eq(knowledgeTypesTable.ownerPhone, ownerPhone)))
        .for("update")
        .limit(1);
      if (!type) return { status: 404 as const, error: "Type tidak ditemukan" };

      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(knowledgeTable)
        .where(
          and(
            eq(knowledgeTable.type, type.value),
            eq(knowledgeTable.ownerPhone, ownerPhone)
          )
        );
      if (count > 0) {
        return {
          status: 409 as const,
          error: `Tidak bisa hapus: masih ada ${count} entry dengan type "${type.value}". Hapus atau ubah entry-nya dulu.`,
        };
      }

      await tx
        .delete(knowledgeTypesTable)
        .where(
          and(eq(knowledgeTypesTable.id, id), eq(knowledgeTypesTable.ownerPhone, ownerPhone))
        );
      return { status: 200 as const };
    });

    if (result.status !== 200) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete knowledge type");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
