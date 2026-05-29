import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

// Per-tenant AI provider configuration, keyed on the effective tenant owner
// (= channelsTable.userId / resolveOwnerUserId). One row per tenant.
//
// `mode`:
//   - "replit" (default): use Replit's managed OpenAI integration (env-based).
//     No API key needed; absence of a row is treated identically to this.
//   - "byok":   use the tenant's OWN API key (billed directly to the provider).
//
// `provider` only matters when mode = "byok": "openai" | "gemini" | "openrouter".
// All three are reached through the OpenAI-compatible SDK (Gemini and OpenRouter
// via their OpenAI-compatible base URLs).
//
// SECURITY: `apiKeyEnc` holds the base64(iv|ciphertext|tag) envelope produced by
// encryptString() (AES-256-GCM, see api-server/src/lib/crypto.ts). It is NEVER
// returned to the API client — reads are masked. Decryption happens only at AI
// call time on the server.
export const aiProviderConfigTable = pgTable(
  "ai_provider_config",
  {
    id: serial("id").primaryKey(),
    ownerUserId: integer("owner_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    mode: text("mode").notNull().default("replit"),
    provider: text("provider").notNull().default("openai"),
    model: text("model"),
    apiKeyEnc: text("api_key_enc"),
    baseUrl: text("base_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    aiProviderOwnerUnique: uniqueIndex("ai_provider_owner_unique").on(
      t.ownerUserId
    ),
  })
);

export type AiProviderConfig = typeof aiProviderConfigTable.$inferSelect;
