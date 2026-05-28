import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { google } from "googleapis";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  db,
  credentialsTable,
  productSyncConfigTable,
  type Credential,
} from "@workspace/db";
import { encryptString, decryptString } from "../lib/crypto";
import { requirePermission } from "../lib/role-permissions";

const router = Router();

// Matrix gates layered onto the credentials CRUD. OAuth callback is a
// public browser GET (no session) so it stays unguarded; the other paths
// all require an authenticated user already (mounted under requireAuth).
router.get("/", requirePermission("credentials", "view"));
router.post("/", requirePermission("credentials", "create"));
router.patch("/:id", requirePermission("credentials", "edit"));
router.delete("/:id", requirePermission("credentials", "delete"));
router.post("/:id/oauth/start", requirePermission("credentials", "edit"));
router.get("/:id/spreadsheets", requirePermission("credentials", "view"));
router.get("/:id/spreadsheets/:spreadsheetId/tabs", requirePermission("credentials", "view"));

// Re-declare the session shape we touch so TS knows about our OAuth state
// bag. We can't widen the type globally without colliding with auth.ts.
declare module "express-session" {
  interface SessionData {
    oauthState?: {
      credentialId: number;
      nonce: string;
      createdAt: number;
    };
  }
}

const SCOPES_BY_TYPE: Record<string, string[]> = {
  // Drive readonly so we can list the user's spreadsheets in the picker.
  googleSheetsOAuth2Api: [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
  googleSheetsTriggerOAuth2Api: [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/userinfo.email",
  ],
};

const CREDENTIAL_TYPES = new Set(Object.keys(SCOPES_BY_TYPE));

function buildRedirectUri(req: import("express").Request): string {
  // The exact URL Google redirects back to after consent. The user must paste
  // THIS string into the Authorized redirect URIs list in Google Cloud Console.
  // We build it from the request host + protocol so it matches the public
  // domain the user is browsing (Replit dev domain, custom domain, etc.).
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = req.get("host");
  return `${proto}://${host}/api/credentials/oauth/callback`;
}

function toPublicCredential(row: Credential) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    clientId: row.clientId,
    scopes: row.scopes,
    accountEmail: row.accountEmail ?? null,
    status: row.status as "disconnected" | "connected" | "error",
    tokenExpiresAt: row.tokenExpiresAt ? row.tokenExpiresAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const rows = await db
      .select()
      .from(credentialsTable)
      .where(eq(credentialsTable.userId, userId))
      .orderBy(credentialsTable.id);
    res.json(rows.map(toPublicCredential));
  } catch (err) {
    req.log.error({ err }, "list credentials failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  type: z.string().refine((v) => CREDENTIAL_TYPES.has(v), "invalid type"),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

router.post("/", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const { name, type, clientId, clientSecret } = parsed.data;
    const inserted = await db
      .insert(credentialsTable)
      .values({
        userId,
        name: name.trim(),
        type,
        clientId: clientId.trim(),
        clientSecretEnc: encryptString(clientSecret),
        scopes: SCOPES_BY_TYPE[type] ?? [],
      })
      .onConflictDoNothing({
        target: [credentialsTable.userId, credentialsTable.name],
      })
      .returning();
    if (inserted.length === 0) {
      res.status(409).json({ error: "Nama credential sudah dipakai" });
      return;
    }
    res.status(201).json(toPublicCredential(inserted[0]!));
  } catch (err) {
    req.log.error({ err }, "create credential failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
});

router.patch("/:id", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = UpdateBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Input tidak valid" });
      return;
    }
    const patch: Partial<typeof credentialsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (parsed.data.name) patch.name = parsed.data.name.trim();
    if (parsed.data.clientId) patch.clientId = parsed.data.clientId.trim();
    // Rotating the client secret invalidates the existing tokens — clear them
    // so the UI shows "disconnected" and the user has to reconnect.
    if (parsed.data.clientSecret) {
      patch.clientSecretEnc = encryptString(parsed.data.clientSecret);
      patch.accessTokenEnc = null;
      patch.refreshTokenEnc = null;
      patch.tokenExpiresAt = null;
      patch.accountEmail = null;
      patch.status = "disconnected";
    }
    const updated = await db
      .update(credentialsTable)
      .set(patch)
      .where(
        and(eq(credentialsTable.id, id), eq(credentialsTable.userId, userId))
      )
      .returning();
    if (updated.length === 0) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    res.json(toPublicCredential(updated[0]!));
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "Nama credential sudah dipakai" });
      return;
    }
    req.log.error({ err }, "update credential failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const deleted = await db
      .delete(credentialsTable)
      .where(
        and(eq(credentialsTable.id, id), eq(credentialsTable.userId, userId))
      )
      .returning({ id: credentialsTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "delete credential failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Load a credential row scoped to the signed-in user, or 404. Used by the
// OAuth + spreadsheets/tabs/sync routes that need the encrypted secrets back.
async function loadOwnedCredential(
  userId: number,
  id: number
): Promise<Credential | null> {
  const [row] = await db
    .select()
    .from(credentialsTable)
    .where(
      and(eq(credentialsTable.id, id), eq(credentialsTable.userId, userId))
    )
    .limit(1);
  return row ?? null;
}

router.post("/:id/oauth/start", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? await loadOwnedCredential(userId, id) : null;
    if (!row) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    const clientSecret = decryptString(row.clientSecretEnc);
    const redirectUri = buildRedirectUri(req);
    const oauth2 = new google.auth.OAuth2(row.clientId, clientSecret, redirectUri);
    // Always re-read scopes from the type's canonical list so credentials
    // created before a scope was added pick it up on the next reconnect.
    const scopes = SCOPES_BY_TYPE[row.type] ?? row.scopes;
    if (scopes !== row.scopes) {
      await db
        .update(credentialsTable)
        .set({ scopes, updatedAt: new Date() })
        .where(eq(credentialsTable.id, row.id));
    }
    const nonce = randomBytes(16).toString("hex");
    // We bind the state ↔ session to prevent CSRF: the callback must arrive
    // on the same browser session that started the flow AND echo back the
    // exact nonce we generated. Anything else is rejected.
    req.session.oauthState = {
      credentialId: row.id,
      nonce,
      createdAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );
    const url = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent", // force a refresh_token even on re-consent
      scope: scopes,
      state: nonce,
      include_granted_scopes: true,
    });
    res.json({ url });
  } catch (err) {
    req.log.error({ err }, "oauth start failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/oauth/callback", async (req, res): Promise<void> => {
  // Render a tiny HTML page in all cases — this URL is opened in the
  // browser after Google's consent screen, so JSON would just look broken.
  const respondHtml = (
    title: string,
    message: string,
    ok: boolean,
    credId: number | null
  ): void => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0b0b;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{max-width:480px;padding:32px;border:1px solid #333;border-radius:12px;text-align:center}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${ok ? "#22c55e" : "#ef4444"};margin-right:8px}
a{color:#60a5fa}</style></head>
<body><div class="card"><h2><span class="dot"></span>${title}</h2><p>${message}</p>
<p><a href="/credentials">Kembali ke Credentials</a></p>
<script>try{window.opener&&window.opener.postMessage({type:"vjchat:oauth",ok:${ok ? "true" : "false"},credentialId:${credId ?? "null"}},"*");setTimeout(function(){window.close()},800)}catch(e){}</script>
</div></body></html>`);
  };

  try {
    const userId = req.session.userId;
    if (typeof userId !== "number") {
      respondHtml("Sesi tidak ditemukan", "Silakan login dulu lalu coba lagi.", false, null);
      return;
    }
    const stateParam = String(req.query["state"] ?? "");
    const code = String(req.query["code"] ?? "");
    const errParam = String(req.query["error"] ?? "");
    const saved = req.session.oauthState;
    // Wipe state regardless of outcome so it can't be replayed.
    delete req.session.oauthState;
    if (errParam) {
      respondHtml("Login dibatalkan", `Google: ${errParam}`, false, saved?.credentialId ?? null);
      return;
    }
    if (!saved || !stateParam || saved.nonce !== stateParam) {
      respondHtml("State tidak cocok", "Mulai ulang proses dari halaman Credentials.", false, saved?.credentialId ?? null);
      return;
    }
    if (!code) {
      respondHtml("Tidak ada code", "Google tidak mengembalikan authorization code.", false, saved.credentialId);
      return;
    }
    const row = await loadOwnedCredential(userId, saved.credentialId);
    if (!row) {
      respondHtml("Credential tidak ditemukan", "Mungkin sudah dihapus.", false, saved.credentialId);
      return;
    }
    const clientSecret = decryptString(row.clientSecretEnc);
    const redirectUri = buildRedirectUri(req);
    const oauth2 = new google.auth.OAuth2(row.clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.access_token) {
      respondHtml("Token kosong", "Google tidak mengembalikan access token.", false, saved.credentialId);
      return;
    }
    oauth2.setCredentials(tokens);
    // Resolve which Google account this is by hitting the userinfo endpoint.
    let accountEmail: string | null = null;
    try {
      const ui = await google.oauth2({ version: "v2", auth: oauth2 }).userinfo.get();
      accountEmail = ui.data.email ?? null;
    } catch {
      // Not fatal — UI just won't show the email.
    }
    await db
      .update(credentialsTable)
      .set({
        accessTokenEnc: encryptString(tokens.access_token),
        refreshTokenEnc: tokens.refresh_token
          ? encryptString(tokens.refresh_token)
          : row.refreshTokenEnc, // keep the previous refresh token if Google omitted a fresh one
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        accountEmail,
        status: "connected",
        updatedAt: new Date(),
      })
      .where(eq(credentialsTable.id, row.id));
    respondHtml(
      "Akun terhubung",
      accountEmail ? `Tersambung sebagai <b>${accountEmail}</b>.` : "Tersambung.",
      true,
      saved.credentialId
    );
  } catch (err) {
    req.log.error({ err }, "oauth callback failed");
    const detail =
      (err as { response?: { data?: { error_description?: string; error?: string } } })
        ?.response?.data?.error_description ||
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
      (err as Error)?.message ||
      "Unknown error";
    respondHtml(
      "Gagal menyelesaikan login Google",
      `Google menolak: <code>${String(detail).replace(/</g, "&lt;")}</code>`,
      false,
      null
    );
  }
});

// Build an authenticated OAuth2 client for a credential, refreshing the
// access token if needed. Persists any refreshed token back to the DB so the
// next call reuses it. Throws if the credential isn't connected.
export async function getAuthorizedOAuthClient(
  cred: Credential
): Promise<InstanceType<typeof google.auth.OAuth2>> {
  if (!cred.accessTokenEnc) {
    throw new Error("Credential not connected");
  }
  const clientSecret = decryptString(cred.clientSecretEnc);
  // No redirect URI needed for refresh; pass undefined to skip building one.
  const oauth2 = new google.auth.OAuth2(cred.clientId, clientSecret);
  oauth2.setCredentials({
    access_token: decryptString(cred.accessTokenEnc),
    refresh_token: cred.refreshTokenEnc ? decryptString(cred.refreshTokenEnc) : undefined,
    expiry_date: cred.tokenExpiresAt ? cred.tokenExpiresAt.getTime() : undefined,
  });
  // Listen for googleapis' auto-refresh and persist the new token back.
  oauth2.on("tokens", (t) => {
    void (async () => {
      try {
        const patch: Partial<typeof credentialsTable.$inferInsert> = {
          updatedAt: new Date(),
          status: "connected",
        };
        if (t.access_token) patch.accessTokenEnc = encryptString(t.access_token);
        if (t.refresh_token) patch.refreshTokenEnc = encryptString(t.refresh_token);
        if (t.expiry_date) patch.tokenExpiresAt = new Date(t.expiry_date);
        await db
          .update(credentialsTable)
          .set(patch)
          .where(eq(credentialsTable.id, cred.id));
      } catch {
        // Best-effort — refresh succeeded for this call regardless.
      }
    })();
  });
  return oauth2;
}

// Mark a credential as in "error" status when an API call rejects with an
// auth-related failure. The UI shows a "Reconnect" pill.
async function markCredentialErrored(credId: number): Promise<void> {
  await db
    .update(credentialsTable)
    .set({ status: "error", updatedAt: new Date() })
    .where(eq(credentialsTable.id, credId));
}

router.get("/:id/spreadsheets", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? await loadOwnedCredential(userId, id) : null;
    if (!row) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    if (row.status !== "connected") {
      res.status(400).json({ error: "Credential belum terhubung. Klik Sign in with Google dulu." });
      return;
    }
    const auth = await getAuthorizedOAuthClient(row);
    const drive = google.drive({ version: "v3", auth });
    const out: { id: string; name: string; modifiedTime?: string | null }[] = [];
    let pageToken: string | undefined;
    // Cap at 200 spreadsheets — covers the realistic case while protecting us
    // from accounts with thousands of files in Drive.
    while (out.length < 200) {
      const resp: { data: { files?: { id?: string | null; name?: string | null; modifiedTime?: string | null }[]; nextPageToken?: string | null } } =
        await drive.files.list({
          q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
          fields: "nextPageToken, files(id,name,modifiedTime)",
          pageSize: 100,
          orderBy: "modifiedTime desc",
          pageToken,
        });
      for (const f of resp.data.files ?? []) {
        if (f.id && f.name) {
          out.push({ id: f.id, name: f.name, modifiedTime: f.modifiedTime ?? null });
        }
      }
      pageToken = resp.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    res.json(out);
  } catch (err: unknown) {
    const e = err as { code?: number; response?: { status?: number } };
    const status = e?.response?.status ?? e?.code;
    if (status === 401 || status === 403) {
      const id = Number(req.params.id);
      if (Number.isInteger(id)) await markCredentialErrored(id);
      res.status(400).json({ error: "Sesi Google kadaluarsa. Reconnect credential." });
      return;
    }
    req.log.error({ err }, "list spreadsheets failed");
    res.status(500).json({ error: "Gagal memuat daftar spreadsheet" });
  }
});

router.get("/:id/spreadsheets/:spreadsheetId/tabs", async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const id = Number(req.params.id);
    const row = Number.isInteger(id) ? await loadOwnedCredential(userId, id) : null;
    if (!row) {
      res.status(404).json({ error: "Credential tidak ditemukan" });
      return;
    }
    if (row.status !== "connected") {
      res.status(400).json({ error: "Credential belum terhubung." });
      return;
    }
    const auth = await getAuthorizedOAuthClient(row);
    const sheets = google.sheets({ version: "v4", auth });
    const resp = await sheets.spreadsheets.get({
      spreadsheetId: String(req.params.spreadsheetId),
      fields: "sheets(properties(title))",
    });
    const titles = (resp.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter((t): t is string => typeof t === "string");
    res.json(titles);
  } catch (err: unknown) {
    const e = err as { code?: number; response?: { status?: number } };
    const status = e?.response?.status ?? e?.code;
    if (status === 401 || status === 403) {
      const id = Number(req.params.id);
      if (Number.isInteger(id)) await markCredentialErrored(id);
      res.status(400).json({ error: "Akses ke spreadsheet ditolak atau sesi kadaluarsa." });
      return;
    }
    if (status === 404) {
      res.status(404).json({ error: "Spreadsheet tidak ditemukan" });
      return;
    }
    req.log.error({ err }, "list tabs failed");
    res.status(500).json({ error: "Gagal memuat daftar tab" });
  }
});

// Convenience used by products-sync to fetch the credential with its
// encrypted secrets, scoped to the WhatsApp account's owning user.
export async function loadCredentialForOwner(
  ownerPhone: string,
  credentialId: number
): Promise<Credential | null> {
  // We resolve userId from the user_whatsapp mapping rather than scoping by
  // userId directly, since products-sync paths are owner-scoped.
  const { userWhatsappTable } = await import("@workspace/db");
  const [link] = await db
    .select({ userId: userWhatsappTable.userId })
    .from(userWhatsappTable)
    .where(eq(userWhatsappTable.ownerPhone, ownerPhone))
    .limit(1);
  if (!link) return null;
  return loadOwnedCredential(link.userId, credentialId);
}

// Re-export the productSyncConfigTable for routes/products-sync.ts use.
export { productSyncConfigTable };

export default router;
