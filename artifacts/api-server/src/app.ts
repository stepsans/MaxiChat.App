import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
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
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const SESSION_SECRET = process.env["SESSION_SECRET"];
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET env var is required");
}
const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL env var is required");
}

// We run behind Replit's reverse proxy, so trust the first hop so secure
// cookies and `req.protocol` work correctly when we're served over HTTPS.
app.set("trust proxy", 1);

const PgStore = connectPgSimple(session);
app.use(
  session({
    name: "vjchat.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    store: new PgStore({
      conString: DATABASE_URL,
      tableName: "user_sessions",
      // The session table is created at boot by `ensureSessionTable()` in
      // seed.ts. We can't use connect-pg-simple's built-in auto-create here
      // because esbuild bundles the JS but not the .sql resource it ships.
      createTableIfMissing: false,
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // Replit's proxy terminates TLS; the cookie still rides on HTTPS to the browser.
      maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
    },
  })
);

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
