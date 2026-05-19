import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve uploaded/downloaded media files. Force download for anything that
// isn't a safe inline-displayable type to prevent stored-XSS from uploaded
// HTML/SVG/JS files being served on the same origin.
const MEDIA_DIR = path.join(process.cwd(), "media");
app.use(
  "/api/media",
  express.static(MEDIA_DIR, {
    maxAge: "1d",
    setHeaders: (res, filePath) => {
      const ct = res.getHeader("Content-Type");
      const ctStr = typeof ct === "string" ? ct.toLowerCase() : "";
      const isImage = ctStr.startsWith("image/") && !ctStr.includes("svg");
      const isVideo = ctStr.startsWith("video/");
      const isAudio = ctStr.startsWith("audio/");
      const safeInline = isImage || isVideo || isAudio;
      if (!safeInline) {
        // Force download for documents, SVGs, HTML, scripts, etc.
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${path.basename(filePath)}"`
        );
      }
      // Defense in depth — never let the browser sniff a different content type
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);

app.use("/api", router);

export default app;
