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
import {
  buildPersonaPrompt,
  normalizeWizardAnswers,
  REFINE_PERSONA_INSTRUCTION,
} from "../lib/ai-prompt-builder";
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

// ─── AI Setup Wizard (Step 2 "Beri makan AI-mu") ──────────────────────────────
// Generate → Review → Setuju. Assembles LAPIS A + B-bisnis only; LAPIS C
// (AI_HARD_GUARDRAILS) is appended at runtime by each AI path, never stored.

// Owner-only guard shared by the wizard write paths.
async function requireWizardOwner(
  req: Parameters<typeof getSessionUserId>[0],
  res: import("express").Response
): Promise<number | null> {
  const userId = getSessionUserId(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return null; }
  const ownerUserId = await getEffectiveOwnerUserId(userId);
  if (ownerUserId !== userId) {
    res.status(403).json({ error: "Hanya super admin yang dapat mengatur AI" });
    return null;
  }
  return ownerUserId;
}

// GET /onboarding/ai-wizard — visibility + prefill. aiWizardCompletedAt is the
// SOLE source of truth for whether the wizard auto-surfaces.
router.get("/ai-wizard", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const ownerUserId = await getEffectiveOwnerUserId(userId);
    const current = await getOrCreateTenantSettings(ownerUserId);
    res.json({
      completed: !!current.aiWizardCompletedAt,
      aiPromptSource: current.aiPromptSource,
      answers: current.wizardAnswers ?? null,
    });
  } catch (err) {
    req.log.error({ err }, "GET /onboarding/ai-wizard failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /onboarding/ai-wizard/generate — deterministic persona build (no AI).
router.post("/ai-wizard/generate", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
    const answers = normalizeWizardAnswers(req.body);
    if (!answers) { res.status(400).json({ error: "Nama bisnis dan deskripsi wajib diisi." }); return; }
    res.json({ systemPrompt: buildPersonaPrompt(answers) });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/ai-wizard/generate failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /onboarding/ai-wizard/refine — optional "Perhalus dengan AI". Touches ONLY
// the persona (Lapis A+B); guardrails (Lapis C) are never sent here.
router.post("/ai-wizard/refine", async (req, res): Promise<void> => {
  const ownerUserId = await requireWizardOwner(req, res);
  if (ownerUserId == null) return;
  const persona = String(req.body?.persona ?? "").trim().slice(0, 8000);
  if (!persona) { res.status(400).json({ error: "Tidak ada teks untuk diperhalus." }); return; }
  try {
    const { client, model } = await resolveAiClient(ownerUserId);
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: REFINE_PERSONA_INSTRUCTION },
        { role: "user", content: persona },
      ],
      max_tokens: 1500,
      temperature: 0.7,
    });
    const refined = completion.choices?.[0]?.message?.content?.trim();
    res.json({ refined: refined || persona });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/ai-wizard/refine failed");
    // Token exhausted / engine down → tell the client so it keeps the template.
    res.status(503).json({ reason: "ai_unavailable", error: "AI sedang tidak tersedia. Template tetap bisa dipakai tanpa diperhalus." });
  }
});

// POST /onboarding/ai-wizard/save — persist the reviewed persona as the tenant
// system_prompt. 409 needs_confirmation when overwriting a manual AI Studio edit.
router.post("/ai-wizard/save", async (req, res): Promise<void> => {
  const ownerUserId = await requireWizardOwner(req, res);
  if (ownerUserId == null) return;
  try {
    const answers = normalizeWizardAnswers(req.body?.answers ?? req.body);
    if (!answers) { res.status(400).json({ error: "Nama bisnis dan deskripsi wajib diisi." }); return; }

    // The reviewed/edited text wins; fall back to a fresh build if absent.
    const reviewed = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt.trim().slice(0, 8000) : "";
    const systemPrompt = reviewed || buildPersonaPrompt(answers);

    const current = await getOrCreateTenantSettings(ownerUserId);
    const overwrite = req.body?.overwrite === true;
    if (current.aiPromptSource === "manual" && !overwrite) {
      res.status(409).json({
        reason: "needs_confirmation",
        message: "Prompt AI-mu di AI Studio sudah pernah diubah manual. Timpa dengan hasil wizard ini?",
      });
      return;
    }

    await db
      .update(tenantSettingsTable)
      .set({
        systemPromptPrevious: current.systemPrompt, // snapshot for single-step undo
        systemPrompt,
        wizardAnswers: answers,
        aiPromptSource: "wizard",
        // Lock out the legacy composeSystemPrompt path so it never clobbers this.
        systemPromptCustomized: true,
        aiWizardCompletedAt: current.aiWizardCompletedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tenantSettingsTable.ownerUserId, ownerUserId));

    await refreshChecklist(ownerUserId).catch(() => { /* best-effort */ });
    res.json({ ok: true, systemPrompt });
  } catch (err) {
    req.log.error({ err }, "POST /onboarding/ai-wizard/save failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
