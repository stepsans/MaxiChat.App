import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { logger } from "./logger";

// AI Chat Report narrative (spec A.3 / 4.3). One short AI pass per owner per day
// turns the day's aggregates into a human summary + recommendations. Generated
// inside the snapshot scheduler (once/day, carried forward) — never per request.

export interface DailyNarrative {
  ringkasan: string;
  sorotan: string[];
  rekomendasi: string[];
}

type Completion = {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function buildDailyNarrative(
  ownerUserId: number,
  agg: {
    percakapan: number;
    tidak_puas: number;
    lead_panas: number;
    ai_handled_percent: number | null;
    won: { count: number; value: number };
  }
): Promise<DailyNarrative | null> {
  const prompt = `Kamu analis customer service untuk bisnis Indonesia. Berdasarkan angka
hari ini, tulis ringkasan singkat + rekomendasi yang spesifik & dapat ditindak untuk
pemilik bisnis. Gunakan Bahasa Indonesia yang ringkas.

ANGKA HARI INI:
- Percakapan: ${agg.percakapan}
- Customer tidak puas: ${agg.tidak_puas}
- Lead panas (skor >= 80): ${agg.lead_panas}
- Ditangani AI: ${agg.ai_handled_percent ?? "-"}%
- Won: ${agg.won.count} (nilai Rp${agg.won.value})

Balas HANYA JSON valid (tanpa markdown):
{"ringkasan":"<2-3 kalimat>","sorotan":["poin penting"],"rekomendasi":["aksi spesifik & terukur"]}`;

  try {
    const { client, model, provider } = await resolveAiClient(ownerUserId);
    const completion = (await (client.chat.completions.create as Function)({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.4,
    })) as Completion;

    await recordAiUsage({
      ownerUserId,
      channelId: null,
      provider,
      model,
      usage: completion.usage ?? null,
    }).catch(() => {});

    const content = completion.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(content.replace(/^```json\s*|\s*```$/g, "").trim());
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 5) : [];
    return {
      ringkasan: typeof parsed.ringkasan === "string" ? parsed.ringkasan : "",
      sorotan: arr(parsed.sorotan),
      rekomendasi: arr(parsed.rekomendasi),
    };
  } catch (err) {
    logger.warn({ err, ownerUserId }, "[dashboard-narrative] generation failed");
    return null;
  }
}
