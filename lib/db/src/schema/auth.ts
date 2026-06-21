import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// Application users. Self-signup is allowed but new accounts land in
// `status = "pending"` and cannot sign in until a super admin approves them.
// The fixed seed users (Stephen + the two test accounts) are inserted at
// boot in `status = "active"`. Stephen is the sole `role = "admin"` and is
// the only account that can call the /admin/* endpoints.
//
// status values: "pending" (awaiting admin approval), "active" (can log in),
// "disabled" (sign-in blocked, data preserved).
// role values:   "user" (default), "admin" (super admin).
export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique(),
  // Canonical form of `email` (lowercase, +alias stripped, Gmail dots removed).
  // ONLY an anti-abuse trial key — login lookups still use raw `email`. Indexed
  // via `users_email_canonical_idx` (see table index below). Nullable for legacy rows.
  emailCanonical: text("email_canonical"),
  passwordHash: text("password_hash"),
  role: text("role").notNull().default("user"),
  status: text("status").notNull().default("pending"),
  // Display name shown in the UI (nullable for backward-compat with pre-name accounts).
  name: text("name"),
  // Mobile phone (E.164 or local format). Required for new invites; nullable
  // on seed/pre-feature rows for backward-compat.
  mobilePhone: text("mobile_phone"),
  // URL (under /api/media/…) for the user's avatar. Null = no photo set.
  profilePhotoUrl: text("profile_photo_url"),
  // Team hierarchy: when an "owner" user invites CS staff, the invitee's
  // parentUserId points at the owner. NULL = top-level account (super_admin).
  // Self-FK with ON DELETE CASCADE so deleting a super_admin auto-removes
  // their entire invited team (and transitively everything else owned at
  // the user level via cascading FKs on user_id columns).
  parentUserId: integer("parent_user_id").references(
    (): AnyPgColumn => usersTable.id,
    { onDelete: "cascade" }
  ),
  // Role inside the WhatsApp team. "super_admin" is the owner (parent_user_id
  // NULL). Invited members are "supervisor" (sees all chats, can assign) or
  // "agent" (sees only chats assigned to them).
  teamRole: text("team_role").notNull().default("super_admin"),
  // SaaS plan that caps how many invited team members the super_admin can
  // create. Hard-coded limits: basic=2, pro=5, business=15. Inherited from
  // parent for invited members but only the parent's value is used.
  plan: text("plan").notNull().default("basic"),
  // RBAC override granting an "Owner Infinity Plan": unlimited users/channels/
  // AI tokens/database/storage, never read-only, never billed. Scoped strictly
  // to the individual account row (default false) so no other tenant is
  // affected. Resolved everywhere through the single `isInfinityOwner` helper.
  isInfinityOwner: boolean("is_infinity_owner").notNull().default(false),
  // === TRIAL & ONBOARDING FIELDS ===
  // WhatsApp number used during OTP signup (format 628xxx, no + or spaces).
  // Stored permanently as an anti-abuse trial fingerprint.
  trialWhatsapp: text("trial_whatsapp"),
  // Whether this account has ever used a trial. Once used (even before
  // expiry) this is true and the account cannot trial again unless an admin
  // overrides via trialGrantedBy.
  trialUsed: boolean("trial_used").notNull().default(false),
  // When an admin manually grants a fresh trial, record who and when.
  trialGrantedBy: integer("trial_granted_by"),
  trialGrantedAt: timestamp("trial_granted_at", { withTimezone: true }),
  // Current onboarding step: 'wa_otp' | 'business_profile' | 'complete'.
  onboardingStep: text("onboarding_step").notNull().default("wa_otp"),
  // Signup routing answers.
  // volume: 'lt50' | '50to200' | '200to500' | 'gt500'
  businessVolume: text("business_volume"),
  // teamSize: 'solo' | '2to5' | '6to20' | 'gt20'
  businessTeamSize: text("business_team_size"),
  // When the user first successfully connected a WhatsApp channel.
  // Null = never connected.
  firstWaConnectedAt: timestamp("first_wa_connected_at", { withTimezone: true }),
  // Updated by a frontend heartbeat (every ~30s while the tab is active).
  // Used as the "online" signal for round-robin chat assignment: an agent
  // counts as online if lastSeenAt > now - 2 minutes.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // How incoming chats are routed to agents. Only the super_admin row's
  // value is used (per-tenant setting); invited rows mirror the default.
  //   "manual"      → new chats land unassigned; supervisor must assign.
  //   "round_robin" → new chats are auto-assigned to the next online agent.
  assignmentMode: text("assignment_mode").notNull().default("manual"),
  // Cursor for round-robin: the users.id of the most recently auto-assigned
  // agent. The next pick is the smallest id > cursor (wrapping). Only the
  // super_admin row uses it.
  roundRobinCursor: integer("round_robin_cursor").notNull().default(0),
  // Optional company name captured at self-signup. Used in the email
  // verification message and the eventual onboarding flow.
  companyName: text("company_name"),
  // Set when the user clicks the verification link in their email. Until
  // this is non-null, /auth/login rejects the account with a "verify your
  // email" message even if the password matches.
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
}, (t) => [
  // Non-unique index for the anti-abuse trial gate lookup in /auth/signup.
  index("users_email_canonical_idx").on(t.emailCanonical),
]);

// One row per outstanding email-verification link. We store a SHA-256
// hash of the token so a DB leak doesn't expose live links. Rows are
// short-lived (24h) — the most recent un-used row per user is the one
// we treat as canonical; older ones are invalidated when a new link is
// requested via /auth/resend-verification.
export const emailVerificationTokensTable = pgTable("email_verification_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// Per-user binding to a WhatsApp account. The connected WhatsApp number is
// the `ownerPhone` we already use everywhere as the data-isolation key; this
// mapping pins each app user to exactly one WhatsApp account so different
// users never see each other's chats.
export const userWhatsappTable = pgTable("user_whatsapp", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  ownerPhone: text("owner_phone").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type UserRow = typeof usersTable.$inferSelect;
export type UserWhatsappRow = typeof userWhatsappTable.$inferSelect;
