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
import { requireAuth, requireAdmin } from "../lib/auth";

const router: IRouter = Router();

// Public routes (no auth required).
router.use(healthRouter);
router.use("/auth", authRouter);

// Everything below requires a signed-in session.
router.use(requireAuth);

router.use("/whatsapp", whatsappRouter);
router.use("/chats", chatsRouter);
router.use("/knowledge-types", knowledgeTypesRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/settings", settingsRouter);
router.use("/analytics", analyticsRouter);
router.use("/products", productsRouter);
router.use("/statuses", statusesRouter);
router.use("/shortcuts", shortcutsRouter);
router.use("/flows", flowsRouter);

// Super-admin only. requireAdmin re-checks the DB so a user demoted
// mid-session loses admin access on their next /admin/* call.
router.use("/admin", requireAdmin, adminRouter);

export default router;
