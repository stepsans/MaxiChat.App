import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, aiProviderConfigTable, type AiProviderConfig } from "@workspace/db";
import { UpdateAiProviderBody, TestAiProviderBody } from "@workspace/api-zod";
import { encryptString, decryptString } from "../lib/crypto";
import { requireSuperAdmin } from "../lib/team-permissions";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";
import {
  AI_MODES,
  AI_PROVIDERS,
  PROVIDER_DEFAULTS,
  getAiProviderConfig,
  testAiConnection,
  validateBaseUrl,
  type AiProvider,
} from "../lib/ai-provider";

const router = Router();

// Only the tenant Super Admin may view or edit the AI provider config — it
// holds a billing-sensitive API key for the whole tenant.
router.use(requireSuperAdmin);

// Mask a decrypted key for display: keep a short prefix + suffix, hide the
// middle. Never returns the full key.
function maskApiKey(enc: string | null): string | null {
  if (!enc) return null;
  let plain: string;
  try {
    plain = decryptString(enc);
  } catch {
    return "••••";
  }
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 3)}…${plain.slice(-4)}`;
}

function toPublic(row: AiProviderConfig | null) {
  return {
    mode: (row?.mode === "byok" ? "byok" : "replit") as "replit" | "byok",
    provider: ((AI_PROVIDERS as readonly string[]).includes(row?.provider ?? "")
      ? row!.provider
      : "openai") as AiProvider,
    model: row?.model ?? null,
    baseUrl: row?.baseUrl ?? null,
    hasApiKey: !!row?.apiKeyEnc,
    maskedApiKey: maskApiKey(row?.apiKeyEnc ?? null),
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

router.get("/", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req)!;
    const row = await getAiProviderConfig(userId);
    res.json(toPublic(row));
  } catch (err) {
    req.log.error({ err }, "get ai provider config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req)!;
    const ownerUserId = await resolveOwnerUserId(userId);
    const parsed = UpdateAiProviderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const body = parsed.data;
    const mode = (AI_MODES as readonly string[]).includes(body.mode)
      ? body.mode
      : "replit";
    const provider = ((AI_PROVIDERS as readonly string[]).includes(
      body.provider ?? ""
    )
      ? body.provider
      : "openai") as AiProvider;

    // Validate a supplied base URL (SSRF guard) before persisting it.
    const trimmedBaseUrl = body.baseUrl?.trim();
    if (trimmedBaseUrl) {
      const v = validateBaseUrl(trimmedBaseUrl);
      if (!v.ok) {
        res.status(400).json({ error: v.reason });
        return;
      }
    }

    const existing = await getAiProviderConfig(ownerUserId);

    // apiKey is optional on update: only re-encrypt when a non-empty key is
    // supplied; otherwise keep whatever is already stored.
    let apiKeyEnc: string | null = existing?.apiKeyEnc ?? null;
    if (typeof body.apiKey === "string" && body.apiKey.trim().length > 0) {
      apiKeyEnc = encryptString(body.apiKey.trim());
    }

    const values = {
      ownerUserId,
      mode,
      provider,
      model: body.model?.trim() ? body.model.trim() : null,
      baseUrl: body.baseUrl?.trim() ? body.baseUrl.trim() : null,
      apiKeyEnc,
      updatedAt: new Date(),
    };

    await db
      .insert(aiProviderConfigTable)
      .values(values)
      .onConflictDoUpdate({
        target: aiProviderConfigTable.ownerUserId,
        set: {
          mode: values.mode,
          provider: values.provider,
          model: values.model,
          baseUrl: values.baseUrl,
          apiKeyEnc: values.apiKeyEnc,
          updatedAt: values.updatedAt,
        },
      });

    const [row] = await db
      .select()
      .from(aiProviderConfigTable)
      .where(eq(aiProviderConfigTable.ownerUserId, ownerUserId))
      .limit(1);
    res.json(toPublic(row ?? null));
  } catch (err) {
    req.log.error({ err }, "update ai provider config failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/test", async (req, res): Promise<void> => {
  try {
    const userId = getSessionUserId(req)!;
    const parsed = TestAiProviderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const body = parsed.data;
    const provider = ((AI_PROVIDERS as readonly string[]).includes(body.provider)
      ? body.provider
      : "openai") as AiProvider;

    // Validate a supplied base URL (SSRF guard) before testing it.
    const trimmedBaseUrl = body.baseUrl?.trim();
    if (trimmedBaseUrl) {
      const v = validateBaseUrl(trimmedBaseUrl);
      if (!v.ok) {
        res.json({ ok: false, message: v.reason });
        return;
      }
    }

    // Use the supplied key if present, else fall back to the stored key.
    let apiKey = body.apiKey?.trim() ?? "";
    if (!apiKey) {
      const existing = await getAiProviderConfig(userId);
      if (existing?.apiKeyEnc) {
        try {
          apiKey = decryptString(existing.apiKeyEnc);
        } catch {
          apiKey = "";
        }
      }
    }
    if (!apiKey) {
      res.json({
        ok: false,
        message: "Belum ada API key untuk diuji. Masukkan API key dulu.",
      });
      return;
    }

    const result = await testAiConnection({
      provider,
      apiKey,
      baseUrl: body.baseUrl ?? PROVIDER_DEFAULTS[provider].baseUrl ?? null,
      model: body.model ?? null,
    });
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "test ai provider failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
