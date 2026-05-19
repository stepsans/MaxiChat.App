import { Router, type IRouter } from "express";
import healthRouter from "./health";
import whatsappRouter from "./whatsapp";
import chatsRouter from "./chats";
import knowledgeRouter from "./knowledge";
import settingsRouter from "./settings";
import analyticsRouter from "./analytics";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/whatsapp", whatsappRouter);
router.use("/chats", chatsRouter);
router.use("/knowledge", knowledgeRouter);
router.use("/settings", settingsRouter);
router.use("/analytics", analyticsRouter);

export default router;
