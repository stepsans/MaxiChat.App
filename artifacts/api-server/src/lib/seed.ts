import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  usersTable,
  userWhatsappTable,
  whatsappSessionTable,
  channelsTable,
} from "@workspace/db";
import { logger } from "./logger";

// Default presentation for the user's first WhatsApp channel created during
// the multi-channel migration. WhatsApp brand green + icon slug consumed by
// the frontend channel switcher.
// Matches the T001 SQL migration backfill so channels created at runtime
// look identical to ones backfilled from user_whatsapp.
const DEFAULT_WA_COLOR = "#25D366";
const DEFAULT_WA_ICON = "whatsapp";

// Fixed allowlist — only these three accounts may sign in. Passwords are
// hashed at startup; bcrypt comparison is constant-time per-hash so plain
// equality of the cleartext password between accounts is fine.
const SEED_USERS: ReadonlyArray<{
  email: string;
  password: string;
  role: "admin" | "user";
  ownerPhone?: string;
}> = [
  {
    email: "stephensan86@gmail.com",
    password: "AdminMaxipro$",
    // Sole super admin. Owns the pre-existing 628111198000 data (474 chats),
    // pinned so it survives the auth migration.
    role: "admin",
    ownerPhone: "628111198000",
  },
  { email: "jc171088@gmail.com", password: "AdminMaxipro$", role: "user" },
  { email: "test@maxipro.co.id", password: "AdminMaxipro$", role: "user" },
];

const AUTH_ROOT = path.join(process.cwd(), ".whatsapp-auth");

// One-time migration: the pre-auth code kept Baileys creds at
// `.whatsapp-auth/*`. After auth, each user gets their own subdir
// `.whatsapp-auth/<userId>/`. If the legacy files are still at the root and
// Stephen has no per-user dir yet, move them in.
function migrateLegacyAuthDir(userId: number): void {
  try {
    if (!fs.existsSync(AUTH_ROOT)) return;
    const userDir = path.join(AUTH_ROOT, String(userId));
    if (fs.existsSync(userDir)) return; // Already migrated.
    const entries = fs
      .readdirSync(AUTH_ROOT, { withFileTypes: true })
      .filter(
        (e) =>
          e.isFile() ||
          // Any directory whose name isn't a numeric user id (pre-existing
          // Baileys subdirs like "session-*" etc).
          (e.isDirectory() && !/^\d+$/.test(e.name))
      );
    if (entries.length === 0) return;
    fs.mkdirSync(userDir, { recursive: true });
    for (const e of entries) {
      fs.renameSync(path.join(AUTH_ROOT, e.name), path.join(userDir, e.name));
    }
    logger.info(
      { userId, moved: entries.length },
      "Migrated legacy WhatsApp auth dir to per-user subdir"
    );
  } catch (err) {
    logger.error(
      { err, userId },
      "Failed to migrate legacy WhatsApp auth dir; manual cleanup may be needed"
    );
  }
}

export async function runSeed(): Promise<void> {
  // Must run before any request hits the session middleware, since the
  // express-session store assumes the table exists.
  await ensureSessionTable();
  await ensureWhatsappSessionUniqueUser();

  const userIdsByEmail = new Map<string, number>();
  for (const seed of SEED_USERS) {
    // Bootstrap-only: insert if the seed account is missing, but NEVER
    // overwrite an existing user's password / role / status. Once the
    // super admin has rotated their password or made admin decisions
    // (disable/demote/delete), a server restart must not undo them.
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, seed.email))
      .limit(1);
    if (existing) {
      userIdsByEmail.set(seed.email, existing.id);
      continue;
    }
    const passwordHash = await bcrypt.hash(seed.password, 12);
    const [row] = await db
      .insert(usersTable)
      .values({
        email: seed.email,
        passwordHash,
        role: seed.role,
        status: "active",
        approvedAt: new Date(),
      })
      // Defend against a concurrent insert (two boots racing) — fall back
      // to reading the row that won.
      .onConflictDoNothing({ target: usersTable.email })
      .returning();
    if (row) {
      userIdsByEmail.set(seed.email, row.id);
    } else {
      const [winner] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, seed.email))
        .limit(1);
      if (winner) userIdsByEmail.set(seed.email, winner.id);
    }
  }

  // Pin Stephen to the pre-existing WhatsApp number so historical data stays
  // with him. Other users start unmapped; their phone is recorded the first
  // time they pair a device.
  const stephen = SEED_USERS.find((u) => u.ownerPhone);
  if (stephen) {
    const userId = userIdsByEmail.get(stephen.email)!;
    await db
      .insert(userWhatsappTable)
      .values({ userId, ownerPhone: stephen.ownerPhone! })
      .onConflictDoNothing({ target: userWhatsappTable.userId });

    // Backfill any pre-auth whatsapp_session row that has no userId set yet.
    await db
      .update(whatsappSessionTable)
      .set({ userId })
      .where(sql`${whatsappSessionTable.userId} IS NULL`);

    migrateLegacyAuthDir(userId);
  }

  // T001/T004 — guarantee every known user has a primary WA channel row
  // before any request can hit a channel-aware route. The T001 SQL
  // migration already inserted rows for users that had a user_whatsapp
  // binding; this catches the rest (newly-created seed users and any
  // users created in flight before runSeed re-ran).
  for (const userId of userIdsByEmail.values()) {
    try {
      await ensurePrimaryWhatsappChannelForUser(userId);
    } catch (err) {
      logger.error(
        { err, userId },
        "Failed to ensure primary WhatsApp channel for user"
      );
    }
  }

  logger.info(
    { users: userIdsByEmail.size },
    "Auth seed complete"
  );
}

// connect-pg-simple ships a `table.sql` it reads at runtime when
// `createTableIfMissing: true`. esbuild bundles the JS but not the .sql, so
// in production builds that auto-create fails with ENOENT. We create the
// table ourselves at boot using the upstream schema (verbatim) and then turn
// `createTableIfMissing` off.
// Source: https://github.com/voxpelli/node-connect-pg-simple/blob/main/table.sql
export async function ensureSessionTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL
    ) WITH (OIDS=FALSE);
  `);
  await db.execute(sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_pkey'
      ) THEN
        ALTER TABLE "user_sessions"
          ADD CONSTRAINT "user_sessions_pkey"
          PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;
      END IF;
    END $$;
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire"
      ON "user_sessions" ("expire");
  `);
}

// Enforce "one whatsapp_session row per user" at the DB layer so concurrent
// `getOrCreateSession()` calls can't race into duplicate rows. We dedupe
// any pre-existing duplicates first (keep the lowest id per user) so index
// creation can't fail.
//
// We use a NON-partial unique index because `ON CONFLICT (user_id)` will
// only match an index whose predicate is provably true for the inserted
// row, and Drizzle's onConflictDoUpdate API doesn't expose a way to attach
// the WHERE clause. Postgres treats NULLs as distinct in a regular unique
// index, so the legacy null-userId case (if any survives) still inserts.
export async function ensureWhatsappSessionUniqueUser(): Promise<void> {
  await db.execute(sql`
    DELETE FROM "whatsapp_session" a
    USING "whatsapp_session" b
    WHERE a.user_id IS NOT NULL
      AND a.user_id = b.user_id
      AND a.id > b.id;
  `);
  // Drop the older partial index if a prior boot installed it.
  await db.execute(sql`
    DROP INDEX IF EXISTS "whatsapp_session_user_id_unique";
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_session_user_id_key"
      ON "whatsapp_session" ("user_id");
  `);
}

// Helper used elsewhere — resolve a user's pinned WhatsApp owner phone, if any.
// For invited team members (supervisor / agent) the phone is on the
// super_admin parent row, so we fall back to parent_user_id when the user
// itself has no direct binding. Single LEFT JOIN to keep this on the hot path.
export async function getOwnerPhoneForUser(
  userId: number
): Promise<string | null> {
  const result = await db.execute<{ owner_phone: string | null }>(sql`
    SELECT COALESCE(uw_self.owner_phone, uw_parent.owner_phone) AS owner_phone
    FROM users u
    LEFT JOIN user_whatsapp uw_self ON uw_self.user_id = u.id
    LEFT JOIN user_whatsapp uw_parent ON uw_parent.user_id = u.parent_user_id
    WHERE u.id = ${userId}
    LIMIT 1
  `);
  const row = (result as any).rows?.[0] ?? (result as any)[0];
  return row?.owner_phone ?? null;
}

// For an invited team member (supervisor / agent) the WhatsApp socket,
// auth dir and whatsapp_session row all live under the *super_admin* parent
// account — they don't pair their own number. This helper returns that
// "operational" userId: parent_user_id for invited members, else the id
// itself. Cached process-wide because parent_user_id is immutable per row
// under current app behavior (only set at invite-accept, never reassigned).
// IF a re-parent / team-transfer feature is ever added, invalidate this
// cache (or drop caching) — otherwise stale entries would route a moved
// user's WhatsApp traffic to the wrong owner until the process restarts.
const ownerUserIdCache = new Map<number, number>();
export async function resolveOwnerUserId(userId: number): Promise<number> {
  const cached = ownerUserIdCache.get(userId);
  if (cached !== undefined) return cached;
  const result = await db.execute<{ owner_user_id: number }>(sql`
    SELECT COALESCE(u.parent_user_id, u.id)::int AS owner_user_id
    FROM users u WHERE u.id = ${userId} LIMIT 1
  `);
  const row = (result as any).rows?.[0] ?? (result as any)[0];
  const ownerId = Number(row?.owner_user_id ?? userId);
  ownerUserIdCache.set(userId, ownerId);
  return ownerId;
}

// Helper used by whatsapp.ts when a user finishes pairing — persist the
// userId↔ownerPhone binding (or update it if they re-paired a new number).
export async function setOwnerPhoneForUser(
  userId: number,
  ownerPhone: string
): Promise<void> {
  await db
    .insert(userWhatsappTable)
    .values({ userId, ownerPhone })
    .onConflictDoUpdate({
      target: userWhatsappTable.userId,
      set: { ownerPhone, updatedAt: new Date() },
    });
}

// Multi-channel migration: every user that exists in the system gets a
// "primary" WhatsApp channel row so the runtime has a stable channelId to
// key off. Idempotent — returns the existing row's id if one is already
// there. Returns the channel id of the user's oldest/primary WA channel.
//
// The pre-migration `user_whatsapp` table is still the legacy source of
// truth for pairing status and is read here as a fallback so a freshly-
// seeded user whose row predates T001 still gets a populated channel.
export async function ensurePrimaryWhatsappChannelForUser(
  userId: number
): Promise<number> {
  const existing = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(
      and(eq(channelsTable.userId, userId), eq(channelsTable.kind, "whatsapp"))
    )
    .orderBy(channelsTable.createdAt)
    .limit(1);
  if (existing[0]) return existing[0].id;
  // Backfill owner_phone + status from the legacy user_whatsapp row so the
  // first channel reflects the historical pairing state without a re-scan.
  const [uw] = await db
    .select()
    .from(userWhatsappTable)
    .where(eq(userWhatsappTable.userId, userId))
    .limit(1);
  const [row] = await db
    .insert(channelsTable)
    .values({
      userId,
      kind: "whatsapp",
      label: "WhatsApp 1",
      color: DEFAULT_WA_COLOR,
      icon: DEFAULT_WA_ICON,
      // Always start 'disconnected'. The boot-time auto-reconnect loop in
      // whatsapp.ts will pull this to 'connected' via syncChannelStatus
      // ONLY if the socket actually comes back up. Don't optimistically
      // claim 'connected' just because a legacy owner_phone binding
      // exists — that would paint a green dot in the UI for a dead
      // socket while the server is still booting. ownerPhone is still
      // backfilled so the binding (which number owns this channel)
      // survives, matching the persistence behavior of user_whatsapp.
      status: "disconnected",
      ownerPhone: uw?.ownerPhone ?? null,
    })
    .returning({ id: channelsTable.id });
  return row.id;
}

// Convenience read-only accessor. Returns null if the user has no WA
// channel yet (should not happen for seeded users after runSeed, but cheap
// to defend).
export async function getPrimaryWhatsappChannelId(
  userId: number
): Promise<number | null> {
  const [row] = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(
      and(eq(channelsTable.userId, userId), eq(channelsTable.kind, "whatsapp"))
    )
    .orderBy(channelsTable.createdAt)
    .limit(1);
  return row?.id ?? null;
}
