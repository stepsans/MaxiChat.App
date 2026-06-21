import { db } from "@workspace/db";
import { settingsTable, tenantSettingsTable, channelsTable } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import type { ChannelRow } from "./channel-context";
import { AI_HARD_GUARDRAILS } from "./ai-guardrails";

export const DEFAULT_SYSTEM_PROMPT = `Kamu adalah customer service profesional yang ramah, cepat, dan membantu closing.

Gunakan gaya bahasa:
- Santai tapi sopan
- Gunakan emoji secukupnya
- Jawaban singkat, jelas, dan tidak bertele-tele
- Maksimal 2-4 kalimat

Tugas kamu:
- Jawab pertanyaan dengan jelas berdasarkan knowledge base
- Jika memungkinkan, arahkan ke pembelian
- Gunakan bahasa natural seperti manusia
- Jangan jawab di luar knowledge
- Jika tidak tahu, sampaikan dengan sopan bahwa admin akan membantu`;

export const DEFAULT_FALLBACK =
  "Aku bantu cek dulu ya kak, nanti admin kami bantu jawab lebih detail 🙏";

export type TenantSettingsRow = typeof tenantSettingsTable.$inferSelect;

// Business-wide ("general") AI settings — one row per tenant, keyed on the
// owner user id (= channelsTable.userId, always the effective tenant owner).
// On first read we seed from any existing per-channel settings row for this
// owner so a tenant that configured its prompt before this split keeps it;
// otherwise we fall back to the defaults.
export async function getOrCreateTenantSettings(
  ownerUserId: number
): Promise<TenantSettingsRow> {
  const existing = await db
    .select()
    .from(tenantSettingsTable)
    .where(eq(tenantSettingsTable.ownerUserId, ownerUserId))
    .limit(1);
  if (existing.length > 0) return existing[0];

  // Seed from a legacy per-channel settings row (oldest channel first) so we
  // preserve any previously-configured general settings for this tenant.
  const [legacy] = await db
    .select({
      systemPrompt: settingsTable.systemPrompt,
      replyDelayMin: settingsTable.replyDelayMin,
      replyDelayMax: settingsTable.replyDelayMax,
      fallbackMessage: settingsTable.fallbackMessage,
      flowCooldownMinutes: settingsTable.flowCooldownMinutes,
    })
    .from(settingsTable)
    // join through channels to find rows belonging to this owner
    // (settingsTable has no userId; channel.userId is the owner).
    .innerJoin(channelsTable, eq(settingsTable.channelId, channelsTable.id))
    .where(eq(channelsTable.userId, ownerUserId))
    .orderBy(asc(settingsTable.channelId))
    .limit(1);

  const seed = {
    ownerUserId,
    systemPrompt: legacy?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    replyDelayMin: legacy?.replyDelayMin ?? 1,
    replyDelayMax: legacy?.replyDelayMax ?? 3,
    fallbackMessage: legacy?.fallbackMessage ?? DEFAULT_FALLBACK,
    flowCooldownMinutes: legacy?.flowCooldownMinutes ?? 5,
  };

  const [created] = await db
    .insert(tenantSettingsTable)
    .values(seed)
    .onConflictDoNothing({ target: tenantSettingsTable.ownerUserId })
    .returning();
  if (created) return created;

  const [row] = await db
    .select()
    .from(tenantSettingsTable)
    .where(eq(tenantSettingsTable.ownerUserId, ownerUserId))
    .limit(1);
  return row;
}

// Per-channel settings row — now only `autoReplyEnabled` is read from here.
// The other columns remain for back-compat but are superseded by the tenant
// row for general settings.
export async function getOrCreateChannelSettings(
  channel: ChannelRow
): Promise<typeof settingsTable.$inferSelect> {
  const rows = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.channelId, channel.id))
    .limit(1);
  if (rows.length > 0) return rows[0];

  const [created] = await db
    .insert(settingsTable)
    .values({
      channelId: channel.id,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      autoReplyEnabled: true,
      replyDelayMin: 1,
      replyDelayMax: 3,
      fallbackMessage: DEFAULT_FALLBACK,
      flowCooldownMinutes: 5,
    })
    .onConflictDoNothing({ target: settingsTable.channelId })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.channelId, channel.id))
    .limit(1);
  return existing;
}

// The merged Settings view the API returns: per-channel auto-reply + the
// tenant-wide general fields. `id` echoes the channel settings row id.
export interface MergedSettings {
  id: number;
  systemPrompt: string;
  autoReplyEnabled: boolean;
  replyDelayMin: number;
  replyDelayMax: number;
  fallbackMessage: string;
  flowCooldownMinutes: number;
  updatedAt: string;
  // Persona-unification surface for AI Studio:
  // 'default' | 'wizard' | 'manual' — provenance of the current systemPrompt.
  aiPromptSource: string;
  // True when a single-step "restore previous version" is available.
  hasPreviousPrompt: boolean;
  // The locked Lapis C guardrails (read-only), shown so the owner knows they are
  // always active even though they aren't part of the editable systemPrompt.
  hardGuardrails: string;
}

export async function getMergedSettings(
  channel: ChannelRow
): Promise<MergedSettings> {
  const [channelSettings, tenant] = await Promise.all([
    getOrCreateChannelSettings(channel),
    getOrCreateTenantSettings(channel.userId),
  ]);
  // Most-recent change across the two rows drives updatedAt.
  const updatedAt =
    tenant.updatedAt > channelSettings.updatedAt
      ? tenant.updatedAt
      : channelSettings.updatedAt;
  return {
    id: channelSettings.id,
    autoReplyEnabled: channelSettings.autoReplyEnabled,
    systemPrompt: tenant.systemPrompt,
    replyDelayMin: tenant.replyDelayMin,
    replyDelayMax: tenant.replyDelayMax,
    fallbackMessage: tenant.fallbackMessage,
    flowCooldownMinutes: tenant.flowCooldownMinutes,
    updatedAt: updatedAt.toISOString(),
    aiPromptSource: tenant.aiPromptSource,
    hasPreviousPrompt: !!tenant.systemPromptPrevious,
    hardGuardrails: AI_HARD_GUARDRAILS,
  };
}
