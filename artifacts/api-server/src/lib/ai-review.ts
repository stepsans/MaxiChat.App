import { Readable } from "node:stream";
import { and, asc, eq, gt, lte, isNotNull } from "drizzle-orm";
import { google } from "googleapis";
import {
  db,
  aiReviewConfigTable,
  chatsTable,
  chatMessagesTable,
  channelsTable,
  credentialsTable,
  type AiReviewConfig,
  type AiReviewColumn,
  type Credential,
} from "@workspace/db";
import { buildAiReviewSystemPrompt } from "./ai-review-prompt";
import { resolveAiClient } from "./ai-provider";
import { recordAiUsage } from "./ai-usage";
import { scanDocument } from "./scanner";
import { getAuthorizedOAuthClient } from "../routes/credentials";
import { loadImageBuffer } from "../routes/whatsapp";
import { logger } from "./logger";

// ---- Timezone helpers ------------------------------------------------------

// UTC instant for a local wall-clock time in an IANA timezone. Used to derive
// "local midnight today" so the recap window matches what the cashier sees.
function zonedWallToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  tz: string
): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const asUtc = new Date(guess);
  const localMs = new Date(asUtc.toLocaleString("en-US", { timeZone: tz })).getTime();
  const utcMs = new Date(asUtc.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess - (localMs - utcMs));
}

// YYYY-MM-DD for `date` rendered in `tz` (en-CA gives ISO-style date).
export function localDateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// HH:mm for `date` rendered in `tz` (24h).
export function localHHmm(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// UTC Date of local midnight (start of today) in `tz`.
function localDayStartUtc(now: Date, tz: string): Date {
  const ymd = localDateStr(now, tz).split("-").map((n) => parseInt(n, 10));
  return zonedWallToUtc(ymd[0]!, ymd[1]!, ymd[2]!, 0, 0, tz);
}

// UTC instant of today's local cut-off (scheduleTime "HH:mm") in `tz`.
function todayCutoffUtc(now: Date, tz: string, hhmm: string): Date {
  const ymd = localDateStr(now, tz).split("-").map((n) => parseInt(n, 10));
  const [h, min] = hhmm.split(":").map((n) => parseInt(n, 10));
  return zonedWallToUtc(ymd[0]!, ymd[1]!, ymd[2]!, h!, min!, tz);
}

// ---- JSON parsing ----------------------------------------------------------

// Models sometimes wrap JSON in ``` fences or prose. Extract the first JSON
// object defensively so a stray character doesn't drop a whole receipt.
function parseJsonObject(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    // fall through to substring extraction
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(trimmed.slice(start, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) {
        return v as Record<string, unknown>;
      }
    } catch {
      // give up
    }
  }
  return null;
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

// ---- Sheet writing ---------------------------------------------------------

// Ensure row 1 of the tab holds exactly the configured column names. If the
// header is missing or differs we rewrite it (kept in lock-step with columns).
async function ensureHeader(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  tab: string,
  headers: string[]
): Promise<void> {
  let existing: string[] = [];
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!1:1`,
    });
    existing = (resp.data.values?.[0] ?? []).map((c) => String(c ?? ""));
  } catch {
    existing = [];
  }
  const same =
    existing.length === headers.length &&
    headers.every((h, i) => existing[i] === h);
  if (same) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });
}

// ---- Credential loading ----------------------------------------------------

async function loadConnectedCredential(
  userId: number,
  credentialId: number
): Promise<Credential | null> {
  const [row] = await db
    .select()
    .from(credentialsTable)
    .where(
      and(eq(credentialsTable.id, credentialId), eq(credentialsTable.userId, userId))
    )
    .limit(1);
  if (!row || row.status !== "connected") return null;
  return row;
}

// ---- Core run --------------------------------------------------------------

export interface ReviewRunResult {
  processed: number;
  appended: number;
  uploaded: number;
  errors: number;
}

// Receipt recap for one group config: OCR every new receipt photo received
// since the previous successful run (or local midnight on first ever run),
// append a row per receipt to the bound Sheet, and (optionally) upload each
// photo to the Drive folder. `runAt` is the window-end / watermark instant —
// the caller persists it as lastRunAt so the next run starts exactly here,
// giving a complete daily cycle (incl. receipts posted after the cut-off) and
// per-message idempotency (no row is OCR'd or appended twice).
export async function runReviewForConfig(
  configId: number,
  runAt?: Date
): Promise<ReviewRunResult> {
  const [cfg] = await db
    .select()
    .from(aiReviewConfigTable)
    .where(eq(aiReviewConfigTable.id, configId))
    .limit(1);
  if (!cfg) throw new Error("Konfigurasi AI Review tidak ditemukan.");

  const columns = (cfg.columns as AiReviewColumn[]) ?? [];
  if (columns.length === 0) {
    throw new Error("Tentukan minimal satu kolom output dulu.");
  }

  // Re-assert the channel still belongs to the config owner — a channel
  // reassignment must not let a prior tenant's binding write to this sheet.
  const [channel] = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.id, cfg.channelId))
    .limit(1);
  if (!channel || channel.userId !== cfg.userId) {
    throw new Error("Channel grup ini bukan milik akun yang sama lagi. Atur ulang.");
  }

  const sheetCred = await loadConnectedCredential(cfg.userId, cfg.sheetCredentialId);
  if (!sheetCred) {
    throw new Error("Credential Google Sheets belum terhubung. Reconnect dulu.");
  }
  const driveCred =
    cfg.driveCredentialId != null
      ? await loadConnectedCredential(cfg.userId, cfg.driveCredentialId)
      : null;

  // Locate the group chat row, then this run's receipt photos.
  const [chat] = await db
    .select({ id: chatsTable.id })
    .from(chatsTable)
    .where(
      and(
        eq(chatsTable.channelId, cfg.channelId),
        eq(chatsTable.phoneNumber, cfg.groupJid)
      )
    )
    .limit(1);

  const now = runAt ?? new Date();
  // Window start is the previous successful run's watermark; on the very first
  // run there is none, so fall back to local midnight today. We use `gt` (not
  // `gte`) so a message landing exactly on the prior watermark — already
  // processed last run — is never re-OCR'd.
  const windowStart = cfg.lastRunAt ?? localDayStartUtc(now, cfg.timezone);

  const messages = chat
    ? await db
        .select({
          id: chatMessagesTable.id,
          mediaUrl: chatMessagesTable.mediaUrl,
          mediaMimeType: chatMessagesTable.mediaMimeType,
          senderName: chatMessagesTable.senderName,
          createdAt: chatMessagesTable.createdAt,
        })
        .from(chatMessagesTable)
        .where(
          and(
            eq(chatMessagesTable.chatId, chat.id),
            eq(chatMessagesTable.direction, "inbound"),
            eq(chatMessagesTable.mediaType, "image"),
            isNotNull(chatMessagesTable.mediaUrl),
            gt(chatMessagesTable.createdAt, windowStart),
            lte(chatMessagesTable.createdAt, now)
          )
        )
        .orderBy(asc(chatMessagesTable.createdAt))
    : [];

  // Instruction is required: without it the module must do nothing. Guard here
  // so legacy rows (or any row missing a prompt) don't silently fall back.
  if (!(cfg.prompt ?? "").trim()) {
    throw new Error(
      "Instruksi AI belum diisi. Isi 'Instruksi AI' pada konfigurasi grup agar AI Review berjalan."
    );
  }

  const { client, model, provider, ownerUserId } = await resolveAiClient(cfg.userId);

  const systemPrompt = buildAiReviewSystemPrompt(cfg.prompt!, columns);

  const rows: string[][] = [];
  const uploads: { buf: Buffer; mime: string; name: string }[] = [];
  let errors = 0;

  for (const msg of messages) {
    if (!msg.mediaUrl) continue;
    try {
      const buf = await loadImageBuffer(msg.mediaUrl);
      const mime = msg.mediaMimeType ?? "image/jpeg";
      const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
      const resp = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: [
              { type: "text", text: "Proses gambar berikut sesuai instruksi dan balas HANYA dengan JSON." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 600,
        temperature: 0,
      });
      void recordAiUsage({
        ownerUserId,
        channelId: cfg.channelId,
        provider,
        model,
        usage: resp.usage,
      });
      const content = resp.choices[0]?.message?.content ?? "";
      const parsed = parseJsonObject(content);
      if (!parsed) {
        errors++;
        continue;
      }
      rows.push(columns.map((c) => cellToString(parsed[c.name])));
      if (driveCred && cfg.driveFolderId) {
        const ext = mime.split("/")[1]?.split(";")[0] || "jpg";
        const safeSender = (msg.senderName ?? "nota").replace(/[^\w.-]+/g, "_").slice(0, 40);
        uploads.push({
          buf,
          mime,
          name: `${localDateStr(msg.createdAt, cfg.timezone)}_${safeSender}_${msg.id}.${ext}`,
        });
      }
    } catch (err) {
      errors++;
      logger.warn(
        { err: (err as Error)?.message, configId, msgId: msg.id },
        "ai-review: OCR failed for message"
      );
    }
  }

  // Append rows to the Sheet (one row per receipt).
  let appended = 0;
  if (rows.length > 0) {
    const auth = await getAuthorizedOAuthClient(sheetCred);
    const sheets = google.sheets({ version: "v4", auth });
    await ensureHeader(
      sheets,
      cfg.spreadsheetId,
      cfg.sheetTab,
      columns.map((c) => c.name)
    );
    await sheets.spreadsheets.values.append({
      spreadsheetId: cfg.spreadsheetId,
      range: cfg.sheetTab,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    appended = rows.length;
  }

  // Upload photos to Drive (best-effort; never fails the recap).
  let uploaded = 0;
  if (driveCred && cfg.driveFolderId && uploads.length > 0) {
    try {
      const auth = await getAuthorizedOAuthClient(driveCred);
      const drive = google.drive({ version: "v3", auth });
      for (const up of uploads) {
        try {
          let body = up.buf;
          let mimeType = up.mime;
          let name = up.name;
          // Scanner AI: clean up the photo (detect → deskew → enhance) before
          // archiving. scanDocument never throws — on detection failure it
          // returns a lightly-enhanced original — so uploads still proceed.
          if (cfg.scannerAi) {
            const scan = await scanDocument({ buf: up.buf, client, model });
            void recordAiUsage({
              ownerUserId,
              channelId: cfg.channelId,
              provider,
              model,
              usage: scan.usage,
            });
            body = scan.buf;
            mimeType = scan.mime;
            name = name.replace(/\.[^.]+$/, ".jpg");
          }
          await drive.files.create({
            requestBody: { name, parents: [cfg.driveFolderId] },
            media: { mimeType, body: Readable.from(body) },
            fields: "id",
          });
          uploaded++;
        } catch (err) {
          logger.warn(
            { err: (err as Error)?.message, configId },
            "ai-review: drive upload failed for one file"
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message, configId },
        "ai-review: drive auth failed; skipping uploads"
      );
    }
  }

  return { processed: messages.length, appended, uploaded, errors };
}

// Wrapper that records the run outcome on the config row. Used by both the
// manual "Run now" route and the scheduler so status is always persisted.
export async function runAndRecord(cfg: AiReviewConfig): Promise<ReviewRunResult> {
  // `now` is both the window-end passed into the run AND the watermark we
  // persist on success, so the two are byte-identical and the next run picks
  // up exactly where this one stopped.
  const now = new Date();
  const dateStr = localDateStr(now, cfg.timezone);
  try {
    const result = await runReviewForConfig(cfg.id, now);
    // Advance the watermark only on success — a failed run leaves lastRunAt
    // untouched so the same window is retried (no receipts silently dropped).
    await db
      .update(aiReviewConfigTable)
      .set({
        lastRunAt: now,
        lastRunDate: dateStr,
        lastRunStatus: "ok",
        lastRunError: null,
        lastRunCount: result.appended,
        updatedAt: new Date(),
      })
      .where(eq(aiReviewConfigTable.id, cfg.id));
    return result;
  } catch (err) {
    await db
      .update(aiReviewConfigTable)
      .set({
        lastRunStatus: "error",
        lastRunError: (err as Error)?.message?.slice(0, 500) || "Run gagal",
        updatedAt: new Date(),
      })
      .where(eq(aiReviewConfigTable.id, cfg.id));
    throw err;
  }
}

// ---- Scheduler -------------------------------------------------------------

// One in-process tick per minute. Runs each enabled config once per local day
// when the local clock reaches scheduleTime. lastRunDate is the "already ran
// today" guard so a run can't double-fire within the matching minute.
const inFlight = new Set<number>();

async function tickScheduler(): Promise<void> {
  let configs: AiReviewConfig[];
  try {
    configs = await db
      .select()
      .from(aiReviewConfigTable)
      .where(eq(aiReviewConfigTable.enabled, true));
  } catch (err) {
    logger.error({ err }, "ai-review scheduler: db read failed");
    return;
  }
  const now = new Date();
  for (const cfg of configs) {
    const tz = cfg.timezone;
    if (localHHmm(now, tz) !== cfg.scheduleTime) continue;
    // Skip if we already ran at/after today's cut-off instant. Comparing the
    // watermark to the cut-off (not lastRunDate) means an earlier manual run
    // the same day does NOT suppress the scheduled run, while a second tick
    // within the matching minute is still de-duped.
    const cutoff = todayCutoffUtc(now, tz, cfg.scheduleTime);
    if (cfg.lastRunAt && cfg.lastRunAt >= cutoff) continue;
    if (inFlight.has(cfg.id)) continue;
    inFlight.add(cfg.id);
    void (async () => {
      try {
        const r = await runAndRecord(cfg);
        logger.info({ configId: cfg.id, ...r }, "ai-review scheduler: ok");
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, configId: cfg.id },
          "ai-review scheduler: failed"
        );
      } finally {
        inFlight.delete(cfg.id);
      }
    })();
  }
}

let schedulerStarted = false;
export function startAiReviewScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  setTimeout(() => {
    void tickScheduler();
    setInterval(() => void tickScheduler(), 60_000);
  }, 60_000);
  logger.info("ai-review scheduler started");
}
