import { Router, type IRouter, type Request, type Response } from "express";
import path from "path";
import { Readable } from "stream";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { getSessionUserId } from "../lib/auth";
import { resolveOwnerUserId } from "../lib/seed";

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();

// Serve tenant media stored in Object Storage. Mounted under the authenticated
// `/api` router, so every request already has a session. Access is scoped to the
// requester's tenant: a file lives at `tenants/<ownerUserId>/...`, and we only
// serve it when that owner matches the caller's resolved owner. This keeps one
// tenant from reading another tenant's files even if they guess the path.
//
// Unsafe (non image/video/audio) types are forced to download to prevent
// stored-XSS from HTML/SVG/JS served on the app origin (mirrors the legacy
// /api/media static handler).
router.get("/storage/objects/*path", async (req: Request, res: Response) => {
  try {
    const userId = getSessionUserId(req);
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const raw = (req.params as Record<string, unknown>).path;
    const wildcardPath = Array.isArray(raw) ? raw.join("/") : String(raw ?? "");
    const segments = wildcardPath.split("/");
    if (segments[0] !== "tenants" || segments.length < 2) {
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const ownerUserId = await resolveOwnerUserId(userId);
    if (Number(segments[1]) !== ownerUserId) {
      // Don't reveal existence of another tenant's object.
      res.status(404).json({ error: "Object not found" });
      return;
    }

    const objectFile = await objectStorageService.getObjectEntityFile(
      `/objects/${wildcardPath}`
    );
    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    const ct = String(res.getHeader("Content-Type") || "").toLowerCase();
    const safeInline =
      (ct.startsWith("image/") && !ct.includes("svg")) ||
      ct.startsWith("video/") ||
      ct.startsWith("audio/");
    if (!safeInline) {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(wildcardPath)}"`
      );
    }
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Object not found" });
      return;
    }
    req.log.error({ err: error }, "Error serving tenant object");
    res.status(500).json({ error: "Failed to serve object" });
  }
});

export default router;
