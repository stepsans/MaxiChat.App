import { Router } from "express";
import { getSessionUserId } from "../lib/auth";
import {
  registerDeviceToken,
  removeDeviceToken,
  isExpoPushToken,
} from "../lib/push";

const router = Router();

// Register (or refresh) this device's Expo push token for the signed-in user.
router.post("/register", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const token = String(req.body?.token ?? "").trim();
  if (!isExpoPushToken(token)) {
    res.status(400).json({ error: "Token push tidak valid" });
    return;
  }
  const platformRaw = req.body?.platform;
  const platform =
    platformRaw === "ios" || platformRaw === "android" || platformRaw === "web"
      ? platformRaw
      : null;
  try {
    await registerDeviceToken(userId, token, platform);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "push register failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Unregister a device token (logout / token rotation).
router.post("/unregister", async (req, res): Promise<void> => {
  const userId = getSessionUserId(req);
  if (userId == null) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const token = String(req.body?.token ?? "").trim();
  if (!token) {
    res.status(400).json({ error: "Token wajib diisi" });
    return;
  }
  try {
    await removeDeviceToken(userId, token);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "push unregister failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
