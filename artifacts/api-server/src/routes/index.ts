import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import whatsappRouter from "./whatsapp";
import chatsRouter from "./chats";
import knowledgeRouter from "./knowledge";
import knowledgeTypesRouter from "./knowledge-types";
import settingsRouter from "./settings";
import analyticsRouter from "./analytics";
import productsRouter from "./products";
import statusesRouter from "./statuses";
import shortcutsRouter from "./shortcuts";
import flowsRouter from "./flows";
import adminRouter from "./admin";
import credentialsRouter from "./credentials";
import productsSyncRouter from "./products-sync";
import knowledgeSyncRouter from "./knowledge-sync";
import shortcutsSyncRouter from "./shortcuts-sync";
import agentsRouter from "./agents";
import permissionsRouter from "./permissions";
import channelsRouter from "./channels";
import telegramWebhookRouter from "./webhooks-telegram";
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

// Public routes (no auth required).
router.use(healthRouter);
router.use("/auth", authRouter);
// Telegram webhook receiver — authenticated by the per-channel secret in
// the X-Telegram-Bot-Api-Secret-Token header rather than by session.
router.use("/webhooks/telegram", telegramWebhookRouter);

// Everything below requires a signed-in session.
router.use(requireAuth);

router.use("/whatsapp", whatsappRouter);
router.use("/chats", chatsRouter);
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
router.use("/credentials", credentialsRouter);
router.use("/agents", agentsRouter);
router.use("/permissions", permissionsRouter);
router.use("/statuses", statusesRouter);
// shortcuts-sync mounted BEFORE shortcutsRouter so /sync-* paths win over /:id.
router.use("/shortcuts", shortcutsSyncRouter);
router.use("/shortcuts", shortcutsRouter);
router.use("/flows", flowsRouter);
router.use("/channels", channelsRouter);

// Super-admin only. requireAdmin re-checks the DB so a user demoted
// mid-session loses admin access on their next /admin/* call.
router.use("/admin", requireAdmin, adminRouter);

export default router;
