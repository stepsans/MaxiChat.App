import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import mime from "mime-types";
import { db } from "@workspace/db";
import { productsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateProductBody,
  UpdateProductBody,
  UpdateProductParams,
  DeleteProductParams,
} from "@workspace/api-zod";
import { MEDIA_DIR } from "./whatsapp";

const router = Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fs.mkdir(MEDIA_DIR, { recursive: true });
      } catch {}
      cb(null, MEDIA_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = mime.extension(file.mimetype || "");
      cb(null, `${randomUUID()}${ext ? "." + ext : ""}`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
  limits: { fileSize: 16 * 1024 * 1024 },
});

function serialize(p: typeof productsTable.$inferSelect) {
  return {
    ...p,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(productsTable).orderBy(productsTable.createdAt);
    res.json(rows.map(serialize));
  } catch (err) {
    req.log.error({ err }, "Failed to list products");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateProductBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });
    if (!Number.isInteger(parsed.data.price)) {
      return res.status(400).json({ error: "Harga harus berupa bilangan bulat" });
    }

    try {
      const [created] = await db
        .insert(productsTable)
        .values({
          code: parsed.data.code.trim(),
          name: parsed.data.name.trim(),
          price: parsed.data.price,
          imageUrl: parsed.data.imageUrl ?? null,
          description: parsed.data.description ?? null,
        })
        .returning();
      res.status(201).json(serialize(created));
    } catch (e: any) {
      if (e?.code === "23505") {
        return res.status(409).json({ error: "Kode produk sudah dipakai" });
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to create product");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const idP = UpdateProductParams.safeParse({ id: Number(req.params.id) });
    if (!idP.success) return res.status(400).json({ error: "Invalid id" });

    const bodyP = UpdateProductBody.safeParse(req.body);
    if (!bodyP.success) return res.status(400).json({ error: "Invalid body" });
    if (!Number.isInteger(bodyP.data.price)) {
      return res.status(400).json({ error: "Harga harus berupa bilangan bulat" });
    }

    try {
      const [updated] = await db
        .update(productsTable)
        .set({
          code: bodyP.data.code.trim(),
          name: bodyP.data.name.trim(),
          price: bodyP.data.price,
          imageUrl: bodyP.data.imageUrl ?? null,
          description: bodyP.data.description ?? null,
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, idP.data.id))
        .returning();

      if (!updated) return res.status(404).json({ error: "Product not found" });
      res.json(serialize(updated));
    } catch (e: any) {
      if (e?.code === "23505") {
        return res.status(409).json({ error: "Kode produk sudah dipakai" });
      }
      throw e;
    }
  } catch (err) {
    req.log.error({ err }, "Failed to update product");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const idP = DeleteProductParams.safeParse({ id: Number(req.params.id) });
    if (!idP.success) return res.status(400).json({ error: "Invalid id" });

    const deleted = await db
      .delete(productsTable)
      .where(eq(productsTable.id, idP.data.id))
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete product");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Image upload endpoint — returns the public URL the frontend can attach
// to a product when creating/updating.
router.post("/upload-image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });
    const url = `/api/media/${path.basename(req.file.path)}`;
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "Failed to upload product image");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
