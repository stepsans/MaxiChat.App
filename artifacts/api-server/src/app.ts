import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "node:path";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import cookieParser from "cookie-parser";
import type { RequestHandler } from "express";
import router from "./routes";
import { logger } from "./lib/logger";
import { TokenQuotaExceededError } from "./lib/ai-quota";
import { resolveMobileToken, touchMobileToken } from "./lib/mobile-auth";

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
// CORS. By default (dev / unconfigured) we reflect any Origin — unchanged
// behaviour. In production set ALLOWED_ORIGINS to a comma-separated allow-list
// (e.g. "https://app.maxichat.app,https://admin.maxichat.app") to lock the
// credentialed cookie API down to known web origins. Requests with no Origin
// header (native mobile, curl, server-to-server) are always allowed — the
// mobile app authenticates with a Bearer token, not a cross-site cookie.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    credentials: true,
    origin:
      allowedOrigins.length === 0
        ? true
        : (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin)) cb(null, true);
            else cb(new Error("Origin not allowed by CORS"));
          },
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
// Parse cookies so the trusted-device cookie (mc_td) is readable in auth routes.
app.use(cookieParser());

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
const sessionMiddleware: RequestHandler = session({
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
    // Flag the cookie Secure in production (served over HTTPS behind the proxy;
    // `trust proxy` above makes this work). Stays false in dev (plain HTTP).
    // Override explicitly with COOKIE_SECURE=true|false if the deploy differs.
    secure:
      process.env.COOKIE_SECURE != null
        ? process.env.COOKIE_SECURE === "true"
        : process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
});

// Bearer-token auth for the mobile app. The mobile client has no cookie jar,
// so it sends `Authorization: Bearer <token>`. When a valid token is present
// we attach a SYNTHETIC in-memory session (no DB row, no Set-Cookie) carrying
// the resolved user, so every handler that reads `req.session.userId` works
// unchanged. Requests without a bearer token fall through to the real
// cookie-backed express-session middleware, leaving web auth untouched.
const bearerAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    const raw = header.slice(7).trim();
    resolveMobileToken(raw)
      .then((user) => {
        if (user) {
          touchMobileToken(raw);
          // Minimal Session-shaped object: only the fields handlers read plus
          // no-op lifecycle methods so code paths that call save/destroy/etc.
          // don't crash. We never persist it.
          const synthetic = {
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            teamRole: user.teamRole,
            id: "mobile-bearer",
            cookie: {} as session.Cookie,
            regenerate: (cb: (err?: unknown) => void) => {
              cb();
              return synthetic;
            },
            destroy: (cb: (err?: unknown) => void) => {
              cb();
              return synthetic;
            },
            reload: (cb: (err?: unknown) => void) => {
              cb();
              return synthetic;
            },
            save: (cb?: (err?: unknown) => void) => {
              cb?.();
              return synthetic;
            },
            touch: () => synthetic,
          };
          (req as unknown as { session: typeof synthetic }).session = synthetic;
          next();
          return;
        }
        // Invalid/expired bearer token → fall through unauthenticated. We
        // still attach a session so downstream code has the object shape;
        // requireAuth will then reject with 401.
        sessionMiddleware(req, res, next);
      })
      .catch((err) => {
        req.log?.error?.({ err }, "bearer auth resolution failed");
        res.status(500).json({ error: "Internal server error" });
      });
    return;
  }
  sessionMiddleware(req, res, next);
};
app.use(bearerAuth);

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

// Readiness gate: the server binds its port immediately on startup so the
// deployment healthcheck passes within seconds, but DB seed operations run
// in the background. Until `setReady()` is called, every route EXCEPT
// /api/healthz returns 503 so clients know to retry rather than seeing a
// broken response.
let _ready = false;
export function setReady() {
  _ready = true;
}

app.use((req, _res, next) => {
  // Always let the liveness/readiness probe through.
  if (_ready || req.path === "/api/healthz" || req.path === "/healthz") {
    return next();
  }
  _res.status(503).json({ error: "Server is starting up, please retry shortly" });
});

app.use("/api", router);

// Token hard-block → HTTP 402 for any request-time AI route that lets the error
// propagate (Express 5 auto-forwards async throws here). Background jobs catch
// TokenQuotaExceededError themselves to defer; the WA/Telegram auto-reply path
// swallows it and sends the static fallback. This is the catch-all for the rest.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (err instanceof TokenQuotaExceededError) {
      if (res.headersSent) return next(err);
      res.status(402).json({
        error:
          "Kuota token AI habis. Tambah kuota atau beli booster untuk melanjutkan.",
        code: "token_quota_exceeded",
      });
      return;
    }
    next(err);
  }
);

export default app;
