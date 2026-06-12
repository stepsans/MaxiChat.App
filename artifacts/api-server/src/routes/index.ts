import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import whatsappRouter from "./whatsapp";
import chatsRouter from "./chats";
import groupsRouter from "./groups";
import knowledgeRouter from "./knowledge";
import knowledgeTypesRouter from "./knowledge-types";
import settingsRouter from "./settings";
import analyticsRouter from "./analytics";
import productsRouter from "./products";
import statusesRouter from "./statuses";
import shortcutsRouter from "./shortcuts";
import flowsRouter from "./flows";
import adminRouter from "./admin";
import plansAdminRouter from "./plans";
import paymentConfigAdminRouter from "./payment-config";
import taxConfigAdminRouter from "./tax-config";
import storageConfigAdminRouter from "./storage-config";
import overageRatesAdminRouter from "./overage-rates";
import dunningSettingsAdminRouter from "./dunning-settings";
import finopsAdminRouter from "./finops";
import credentialsRouter from "./credentials";
import productsSyncRouter from "./products-sync";
import salesOrdersRouter from "./sales-orders";
import knowledgeSyncRouter from "./knowledge-sync";
import shortcutsSyncRouter from "./shortcuts-sync";
import agentsRouter from "./agents";
import permissionsRouter from "./permissions";
import channelsRouter from "./channels";
import aiProviderRouter from "./ai-provider";
import aiUsageRouter from "./ai-usage";
import aiReviewRouter from "./ai-review";
import customerLabelsRouter from "./customer-labels";
import linkPreviewRouter from "./link-preview";
import telegramWebhookRouter from "./webhooks-telegram";
import xenditWebhookRouter from "./webhooks-xendit";
import billingRouter from "./billing";
import retentionRouter from "./retention";
import databaseRouter from "./database";
import pushRouter from "./push";
import storageRouter from "./storage";
import salesRouter from "./sales";
import aiPipelineRouter from "./ai-pipeline";
import acrRouter from "./acr";
import workboardRouter from "./workboard";
import chatClassifierRouter from "./chat-classifier";
import waOtpRouter from "./wa-otp";
import onboardingRouter from "./onboarding";
import { requireAuth, requireAdmin } from "../lib/auth";
import { enforceSubscription } from "../lib/enforce-subscription";

const router: IRouter = Router();

// Public routes (no auth required).
router.use(healthRouter);
router.use("/auth", authRouter);
// Telegram webhook receiver — authenticated by the per-channel secret in
// the X-Telegram-Bot-Api-Secret-Token header rather than by session.
router.use("/webhooks/telegram", telegramWebhookRouter);
// Xendit payment webhook — authenticated by the static x-callback-token header
// (XENDIT_CALLBACK_TOKEN) rather than by session.
router.use("/webhooks/xendit", xenditWebhookRouter);
// WA OTP — public (used before signup, no session required).
router.use("/auth/wa-otp", waOtpRouter);

// Everything below requires a signed-in session.
router.use(requireAuth);

// Read-only enforcement for impersonate mode: blocks writes when mode=read_only.
router.use((req, res, next) => {
  const imp = (req.session as any)?.impersonating;
  if (imp?.mode === "read_only" && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const allowed = ["/auth/logout", "/admin/impersonate/stop"];
    if (!allowed.some((p) => req.path.startsWith(p))) {
      res.status(403).json({ error: "Mode read-only: perubahan data tidak diizinkan." });
      return;
    }
  }
  next();
});

// Read-only enforcement for expired/suspended tenants: blocks writes (the
// operator namespace /admin and read-only /billing are exempt; admins always
// pass). Mounted before the resource routers so a single gate covers them all.
router.use(enforceSubscription);

router.use("/whatsapp", whatsappRouter);
router.use("/chats", chatsRouter);
router.use("/groups", groupsRouter);
router.use("/knowledge-types", knowledgeTypesRouter);
// knowledge-sync mounted BEFORE knowledgeRouter so explicit /sync-* paths
// take priority over the generic /:id CRUD route.
router.use("/knowledge", knowledgeSyncRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/settings", settingsRouter);
router.use("/analytics", analyticsRouter);
// products-sync is mounted under /products so its routes (/products/sync-config,
// /products/sync-run) sit alongside the existing product CRUD. Mounted BEFORE
// productsRouter so the explicit /sync-* paths take priority over a CRUD
// fallthrough that might otherwise treat "sync-config" as an id.
router.use("/products", productsSyncRouter);
router.use("/products", productsRouter);
router.use("/sales-orders", salesOrdersRouter);
router.use("/credentials", credentialsRouter);
router.use("/agents", agentsRouter);
router.use("/permissions", permissionsRouter);
router.use("/statuses", statusesRouter);
// shortcuts-sync mounted BEFORE shortcutsRouter so /sync-* paths win over /:id.
router.use("/shortcuts", shortcutsSyncRouter);
router.use("/shortcuts", shortcutsRouter);
router.use("/flows", flowsRouter);
router.use("/channels", channelsRouter);
router.use("/ai-provider", aiProviderRouter);
router.use("/ai-usage", aiUsageRouter);
router.use("/ai-review", aiReviewRouter);
router.use("/customer-labels", customerLabelsRouter);
router.use("/link-preview", linkPreviewRouter);
// AI Sales Assistant (Enterprise-only; the router self-gates on
// requireSalesAssistant + per-route opportunity permissions).
router.use("/sales", salesRouter);
router.use("/ai-pipelines", aiPipelineRouter);
// AI Chat Report: AI-driven CS performance evaluation.
router.use("/acr", acrRouter);
router.use("/workboard", workboardRouter);
router.use("/chat-classifier", chatClassifierRouter);
router.use("/billing", billingRouter);
router.use("/retention", retentionRouter);
router.use("/database", databaseRouter);
router.use("/push", pushRouter);
router.use("/onboarding", onboardingRouter);
// Tenant-scoped Object Storage serving (GET /storage/objects/tenants/<owner>/...).
router.use(storageRouter);

// Super-admin only. requireAdmin re-checks the DB so a user demoted
// mid-session loses admin access on their next /admin/* call.
router.use("/admin", requireAdmin, adminRouter);
router.use("/admin", requireAdmin, plansAdminRouter);
router.use("/admin", requireAdmin, paymentConfigAdminRouter);
router.use("/admin", requireAdmin, taxConfigAdminRouter);
router.use("/admin", requireAdmin, storageConfigAdminRouter);
router.use("/admin", requireAdmin, overageRatesAdminRouter);
router.use("/admin", requireAdmin, dunningSettingsAdminRouter);
router.use("/admin", requireAdmin, finopsAdminRouter);

export default router;
