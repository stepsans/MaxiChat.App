// Platform AI engine config — owner-only (mounted under /admin + requireAdmin).
// The centralized 4-engine failover chain all tenants ride; API keys are
// encrypted at rest and only ever returned masked.

import { Router } from "express";
import {
  AdminUpdatePlatformAiBody,
  AdminTestPlatformAiBody,
  AdminUpdatePlatformAiEngineBody,
  AdminTestPlatformAiEngineBody,
  AdminReorderPlatformAiEnginesBody,
} from "@workspace/api-zod";
import { getSessionUserId } from "../lib/auth";
import {
  getPlatformAiConfigView,
  updatePlatformAiConfig,
  testPlatformAiConnection,
  PlatformAiConfigError,
  type PlatformEngine,
} from "../lib/platform-ai-config";
import {
  getEnginesView,
  updateEngine,
  reorderEngines,
  testEngineConnection,
  PlatformAiEngineError,
} from "../lib/platform-ai-engine";
import { getPlatformAiMarginSafe } from "../lib/platform-ai-margin";

const router: Router = Router();

// GET /admin/platform-ai — global config (failover knobs, markup, min-stop) plus
// the four engines (priority-ordered, masked credentials).
router.get("/platform-ai", async (req, res): Promise<void> => {
  try {
    const [config, engines] = await Promise.all([getPlatformAiConfigView(), getEnginesView()]);
    res.json({ ...config, engines });
  } catch (err) {
    req.log.error({ err }, "adminGetPlatformAi failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /admin/platform-ai — update the GLOBAL knobs only (per-engine credentials
// go through PUT /platform-ai/engine/:engine).
router.put("/platform-ai", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdatePlatformAiBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const b = parsed.data;
    // Credits/markup/min-stop/minutes are whole integers (the generated
    // validator only checks number/min) — enforce the integer rule here.
    const ints = [b.markupBps, b.creditPer1kTokenAnthropic, b.creditPer1kTokenGemini, b.minStopCredits, b.unhealthyMinutes];
    if (ints.some((v) => v != null && !Number.isInteger(v))) {
      res.status(400).json({ error: "Markup, kredit & menit harus bilangan bulat" });
      return;
    }
    const adminId = getSessionUserId(req) ?? null;
    await updatePlatformAiConfig(
      {
        engine: b.engine as PlatformEngine | undefined,
        model: b.model,
        baseUrl: b.baseUrl,
        apiKey: b.apiKey,
        isActive: b.isActive,
        markupBps: b.markupBps,
        creditPer1kTokenAnthropic: b.creditPer1kTokenAnthropic,
        creditPer1kTokenGemini: b.creditPer1kTokenGemini,
        minStopCredits: b.minStopCredits,
        autoFailover: b.autoFailover,
        autoFailback: b.autoFailback,
        unhealthyMinutes: b.unhealthyMinutes,
        bothFailedRetry: b.bothFailedRetry,
      },
      adminId,
    );
    const [config, engines] = await Promise.all([getPlatformAiConfigView(), getEnginesView()]);
    res.json({ ...config, engines });
  } catch (err) {
    if (err instanceof PlatformAiConfigError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "adminUpdatePlatformAi failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/platform-ai/test — DEPRECATED single-engine connectivity test.
router.post("/platform-ai/test", async (req, res): Promise<void> => {
  try {
    const parsed = AdminTestPlatformAiBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const b = parsed.data;
    res.json(
      await testPlatformAiConnection({
        engine: b.engine as PlatformEngine,
        apiKey: b.apiKey,
        baseUrl: b.baseUrl,
        model: b.model,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "adminTestPlatformAi failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /admin/platform-ai/engine/:engine — upsert one engine's credentials/config.
router.put("/platform-ai/engine/:engine", async (req, res): Promise<void> => {
  try {
    const parsed = AdminUpdatePlatformAiEngineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const b = parsed.data;
    if (b.creditPer1kToken != null && !Number.isInteger(b.creditPer1kToken)) {
      res.status(400).json({ error: "Kredit / 1k token harus bilangan bulat" });
      return;
    }
    const engines = await updateEngine(req.params.engine, {
      baseUrl: b.baseUrl,
      model: b.model,
      apiKey: b.apiKey,
      isEnabled: b.isEnabled,
      creditPer1kToken: b.creditPer1kToken,
    });
    res.json(engines);
  } catch (err) {
    if (err instanceof PlatformAiEngineError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "adminUpdatePlatformAiEngine failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/platform-ai/engine/:engine/test — live connectivity test for one engine.
router.post("/platform-ai/engine/:engine/test", async (req, res): Promise<void> => {
  try {
    const parsed = AdminTestPlatformAiEngineBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const b = parsed.data;
    res.json(
      await testEngineConnection(req.params.engine, {
        apiKey: b.apiKey,
        baseUrl: b.baseUrl,
        model: b.model,
      }),
    );
  } catch (err) {
    req.log.error({ err }, "adminTestPlatformAiEngine failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /admin/platform-ai/margin — revenue vs COGS per engine + reconciliation.
router.get("/platform-ai/margin", async (req, res): Promise<void> => {
  try {
    res.json(await getPlatformAiMarginSafe());
  } catch (err) {
    req.log.error({ err }, "adminGetPlatformAiMargin failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /admin/platform-ai/reorder — set the failover priority order (#1..#4).
router.post("/platform-ai/reorder", async (req, res): Promise<void> => {
  try {
    const parsed = AdminReorderPlatformAiEnginesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const engines = await reorderEngines(parsed.data.order);
    res.json(engines);
  } catch (err) {
    if (err instanceof PlatformAiEngineError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "adminReorderPlatformAiEngines failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
