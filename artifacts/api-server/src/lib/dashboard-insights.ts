import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  db,
  channelsTable,
  chatsTable,
  chatMessagesTable,
  dashboardTopQuestionsTable,
  type TopQuestion,
} from "@workspace/db";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { runScheduledJob } from "./job-runs";
import { logger } from "./logger";

// "Pertanyaan tersering" (spec A.3 / 3.4): cluster recent inbound customer
// messages into top intents with an AI pass, on a schedule (NOT real-time, to
// keep token cost bounded). Cached one-row-per-owner in dashboard_top_questions.

const WINDOW_DAYS = 30;
const SAMPLE_LIMIT = 200; // newest inbound messages fed to the model
const MIN_SAMPLE = 5; // below this there's nothing meaningful to cluster
const MAX_INTENTS = 10;

type Completion = {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

function buildPrompt(messages: string[]): string {
  const numbered = messages.map((m, i) => `${i + 1}. ${m}`).join("\n");
  return `Berikut daftar pesan masuk dari pelanggan (apa adanya, bahasa Indonesia).
Kelompokkan menjadi PERTANYAAN / INTENT yang paling sering ditanyakan pelanggan,
pakai label ringkas & netral (mis. "tanya harga", "tanya stok", "cara pemesanan",
"lokasi toko", "status pengiriman", "komplain produk"). Hitung berapa banyak pesan
yang masuk ke tiap intent. Abaikan sapaan/terima kasih/basa-basi yang bukan
pertanyaan atau permintaan.

PESAN:
${numbered}

Balas HANYA JSON valid (tanpa markdown):
{"questions":[{"intent":"<ringkas>","count":<integer>}]}
Maksimal ${MAX_INTENTS} intent, urut dari count terbesar.`;
}

function parseQuestions(content: string): TopQuestion[] {
  let parsed: unknown;
  try {
    const jsonStr = content.replace(/^```json\s*|\s*```$/g, "").trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  const arr = (parsed as { questions?: unknown })?.questions;
  if (!Array.isArray(arr)) return [];
  return arr
    .map((q) => {
      const intent = typeof (q as TopQuestion)?.intent === "string" ? (q as TopQuestion).intent.trim() : "";
      const count = Number((q as TopQuestion)?.count);
      return { intent, count: Number.isFinite(count) ? Math.max(0, Math.round(count)) : 0 };
    })
    .filter((q) => q.intent.length > 0 && q.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_INTENTS);
}

// Compute + cache the top questions for one owner. Best-effort; returns the
// number of intents stored (0 = skipped / no data).
export async function computeTopQuestionsForOwner(ownerUserId: number): Promise<number> {
  const channels = await db
    .select({ id: channelsTable.id })
    .from(channelsTable)
    .where(eq(channelsTable.userId, ownerUserId));
  if (channels.length === 0) return 0;
  const channelIds = channels.map((c) => c.id);

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ content: chatMessagesTable.content })
    .from(chatMessagesTable)
    .innerJoin(chatsTable, eq(chatMessagesTable.chatId, chatsTable.id))
    .where(
      and(
        inArray(chatsTable.channelId, channelIds),
        eq(chatMessagesTable.direction, "inbound"),
        gte(chatMessagesTable.createdAt, since),
        sql`${chatMessagesTable.content} is not null and length(trim(${chatMessagesTable.content})) > 1`
      )
    )
    .orderBy(desc(chatMessagesTable.createdAt))
    .limit(SAMPLE_LIMIT);

  const messages = rows
    .map((r) => (r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200))
    .filter((m) => m.length > 1);
  if (messages.length < MIN_SAMPLE) return 0;

  const { client, model, provider } = await resolveAiClient(ownerUserId);
  let completion: Completion | null = null;
  try {
    completion = (await (client.chat.completions.create as Function)({
      model,
      messages: [{ role: "user", content: buildPrompt(messages) }],
      max_tokens: 800,
      temperature: 0.2,
    })) as Completion;
  } catch (err) {
    logger.warn({ err, ownerUserId }, "[dashboard-insights] AI clustering failed");
    return 0;
  }

  // Record token usage against the owner (member usage rolls up).
  try {
    await recordAiUsage({
      ownerUserId,
      channelId: null,
      provider,
      model,
      usage: completion.usage ?? null,
    });
  } catch {
    /* non-fatal */
  }

  const questions = parseQuestions(completion.choices?.[0]?.message?.content ?? "");

  await db
    .insert(dashboardTopQuestionsTable)
    .values({
      ownerUserId,
      payload: { questions },
      sampleCount: messages.length,
      windowDays: WINDOW_DAYS,
      computedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: dashboardTopQuestionsTable.ownerUserId,
      set: {
        payload: { questions },
        sampleCount: messages.length,
        windowDays: WINDOW_DAYS,
        computedAt: new Date(),
      },
    });

  return questions.length;
}

// Cached snapshot read by the endpoint (no AI call).
export async function getCachedTopQuestions(ownerUserId: number): Promise<{
  questions: TopQuestion[];
  windowDays: number;
  computedAt: string | null;
}> {
  const [row] = await db
    .select()
    .from(dashboardTopQuestionsTable)
    .where(eq(dashboardTopQuestionsTable.ownerUserId, ownerUserId))
    .limit(1);
  if (!row) return { questions: [], windowDays: WINDOW_DAYS, computedAt: null };
  return {
    questions: row.payload?.questions ?? [],
    windowDays: row.windowDays,
    computedAt: row.computedAt ? row.computedAt.toISOString() : null,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────
let schedulerStarted = false;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    // Owners = distinct channel owners (every tenant that has a channel).
    const owners = await db
      .selectDistinct({ ownerUserId: channelsTable.userId })
      .from(channelsTable);
    for (const { ownerUserId } of owners) {
      try {
        await runScheduledJob("dashboard_top_questions", ownerUserId, () =>
          computeTopQuestionsForOwner(ownerUserId)
        );
      } catch (err) {
        logger.warn({ err, ownerUserId }, "[dashboard-insights] owner compute failed");
      }
    }
  } catch (err) {
    logger.error({ err }, "[dashboard-insights] tick failed");
  } finally {
    inFlight = false;
  }
}

// Recompute every 6 hours; first run 5 min after boot. Best-effort.
export function startDashboardInsightsScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => void tick(), 5 * 60_000);
  const timer = setInterval(() => void tick(), 6 * 60 * 60_000);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("dashboard-insights scheduler started");
}
