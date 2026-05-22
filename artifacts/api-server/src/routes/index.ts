import { Router, type IRouter } from "express";
import healthRouter from "./health";
import whatsappRouter from "./whatsapp";
import chatsRouter from "./chats";
import knowledgeRouter from "./knowledge";
import knowledgeTypesRouter from "./knowledge-types";
import settingsRouter from "./settings";
import analyticsRouter from "./analytics";
import productsRouter from "./products";
import statusesRouter from "./statuses";
import shortcutsRouter from "./shortcuts";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/whatsapp", whatsappRouter);
router.use("/chats", chatsRouter);
router.use("/knowledge-types", knowledgeTypesRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/settings", settingsRouter);
router.use("/analytics", analyticsRouter);
router.use("/products", productsRouter);
router.use("/statuses", statusesRouter);
router.use("/shortcuts", shortcutsRouter);

export default router;
