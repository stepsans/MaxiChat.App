import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  onboardingChecklistTable,
  tenantSettingsTable,
  knowledgeTable,
  productsTable,
} from "@workspace/db";
import { getSessionUserId, getEffectiveOwnerUserId } from "../lib/auth";
import { refreshChecklist, getOrCreateChecklist } from "../lib/onboarding";
import { getOrCreateTenantSettings } from "../lib/settings-store";
import { composeSystemPrompt } from "../lib/compose-system-prompt";
import { buildProductCatalogText } from "../lib/product-catalog";
import { resolveAiClient } from "../lib/ai-provider";

const router = Router();

const VALID_TONES = new Set(["formal", "santai", "profesional"]);

// GET /onboarding/checklist
// Fetch the logged-in owner's checklist progress.
router.get("/checklist", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await getEffectiveOwnerUserId(userId);

    // Refresh from actual data first.
    await refreshChecklist(ownerUserId);

    const [row] = await db
      .select()
      .from(onboardingChecklistTable)
      .where(eq(onboardingChecklistTable.ownerUserId, ownerUserId))
      .limit(1);

    res.json({
      waConnected: row?.waConnected ?? false,
      productAdded: row?.productAdded ?? false,
      teamMemberAdded: row?.teamMemberAdded ?? false,
      firstMessageAt: row?.firstMessageAt?.toISOString() ?? null,
      aiTriedAt: row?.aiTriedAt?.toISOString() ?? null,
      flowActivated: row?.flowActivated ?? false,
      healthScore: row?.healthScore ?? 0,
      riskLevel: row?.riskLevel ?? "high",
    });
  } catch (err) {
    req.log.error({ err }, "GET /onboarding/checklist failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /onboarding/refresh
// Force-refresh the checklist from actual data.
router.post("/refresh", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const ownerUserId = await getEffectiveOwnerUserId(userId);
    await refreshChecklist(ownerUserId);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/refresh failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /onboarding/ai-profile — save the first-run "AI-feeding" profile and
// (re)compose the system prompt from it, unless the owner has hand-edited the
// raw prompt. Super-admin (owner) only.
router.put("/ai-profile", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const ownerUserId = await getEffectiveOwnerUserId(userId);
    // Owner-only: a member resolves to a different ownerUserId than their own id.
    if (ownerUserId !== userId) {
      res.status(403).json({ error: "Hanya super admin yang dapat mengubah profil AI" });
      return;
    }

    const businessDescription = typeof req.body?.businessDescription === "string"
      ? req.body.businessDescription.trim().slice(0, 2000) || null : null;
    const aiToneRaw = String(req.body?.aiTone ?? "profesional");
    const aiTone = VALID_TONES.has(aiToneRaw) ? aiToneRaw : "profesional";
    const operatingHours = typeof req.body?.operatingHours === "string"
      ? req.body.operatingHours.trim().slice(0, 200) || null : null;

    // Ensure a tenant_settings row exists, then patch.
    const current = await getOrCreateTenantSettings(ownerUserId);
    const patch: Partial<typeof tenantSettingsTable.$inferInsert> = {
      businessDescription,
      aiTone,
      operatingHours,
      updatedAt: new Date(),
    };
    // Only auto-compose if the owner hasn't taken manual control of the prompt.
    if (!current.systemPromptCustomized) {
      patch.systemPrompt = composeSystemPrompt({ businessDescription, aiTone, operatingHours });
    }
    await db.update(tenantSettingsTable).set(patch).where(eq(tenantSettingsTable.ownerUserId, ownerUserId));

    await refreshChecklist(ownerUserId).catch(() => { /* best-effort */ });
    res.json({ ok: true, systemPrompt: patch.systemPrompt ?? current.systemPrompt });
  } catch (err) {
    req.log.error({ err }, "PUT /onboarding/ai-profile failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /onboarding/ai-sandbox — run the tenant's AI on a test message WITHOUT
// sending anything to WhatsApp. The aha moment of first-run. Uses the tenant's
// composed system prompt + resolved AI client; no chat row is created.
router.post("/ai-sandbox", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const ownerUserId = await getEffectiveOwnerUserId(userId);
    // Owner-only: a member resolves to a different ownerUserId than their own id.
    if (ownerUserId !== userId) {
      res.status(403).json({ error: "Hanya super admin yang dapat mencoba AI" });
      return;
    }

    const message = String(req.body?.message ?? "").trim().slice(0, 1000);
    if (!message) { res.status(400).json({ error: "Pesan wajib diisi" }); return; }

    const settings = await getOrCreateTenantSettings(ownerUserId);

    // Feed the SAME context the production auto-reply uses (generateAiReply):
    // the tenant's knowledge base + live product catalog. generateAiReply itself
    // is bound to a real channel + chat (per-channel autoReplyEnabled + history),
    // which doesn't exist during first-run, so we inject the same sources here.
    const knowledgeEntries = await db
      .select()
      .from(knowledgeTable)
      .where(eq(knowledgeTable.userId, ownerUserId));
    const knowledgeContext = knowledgeEntries
      .map((e) => `[${e.type.toUpperCase()}] ${e.title}:\n${e.content}`)
      .join("\n\n");
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.userId, ownerUserId))
      .orderBy(productsTable.id);
    const productCatalog = buildProductCatalogText(products);

    const systemPrompt = [
      settings.systemPrompt,
      productCatalog ? `\n--- KATALOG PRODUK ---\n${productCatalog}` : "",
      knowledgeContext ? `\n--- KNOWLEDGE BASE ---\n${knowledgeContext}` : "",
    ].join("");

    // resolveAiClient records usage against the owner on the platform path.
    const { client, model } = await resolveAiClient(ownerUserId);

    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      max_tokens: 500,
    });
    const reply = completion.choices?.[0]?.message?.content?.trim() || "(AI tidak memberi balasan)";

    // Mark "AI tried" once (the first sandbox use lights up the checklist item).
    try {
      await getOrCreateChecklist(ownerUserId);
      await db
        .update(onboardingChecklistTable)
        .set({ aiTriedAt: new Date() })
        .where(and(
          eq(onboardingChecklistTable.ownerUserId, ownerUserId),
          isNull(onboardingChecklistTable.aiTriedAt)
        ));
    } catch (err) { req.log.error({ err }, "Failed to stamp aiTriedAt"); }

    res.json({ reply });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/ai-sandbox failed");
    res.status(500).json({ error: "Gagal menjalankan AI. Coba lagi." });
  }
});

export default router;
