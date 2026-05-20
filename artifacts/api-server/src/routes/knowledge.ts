import { Router } from "express";
import { db } from "@workspace/db";
import { knowledgeTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  CreateKnowledgeBody,
  UpdateKnowledgeBody,
  UpdateKnowledgeParams,
  DeleteKnowledgeParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const entries = await db.select().from(knowledgeTable).orderBy(knowledgeTable.createdAt);
    res.json(
      entries.map((e) => ({
        ...e,
        createdAt: e.createdAt.toISOString(),
        updatedAt: e.updatedAt.toISOString(),
      }))
    );
  } catch (err) {
    req.log.error({ err }, "Failed to list knowledge");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", async (req, res) => {
  try {
    const parsed = CreateKnowledgeBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid body" });

    const [entry] = await db
      .insert(knowledgeTable)
      .values(parsed.data)
      .returning();

    res.status(201).json({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to create knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const idParsed = UpdateKnowledgeParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const bodyParsed = UpdateKnowledgeBody.safeParse(req.body);
    if (!bodyParsed.success) return res.status(400).json({ error: "Invalid body" });

    const [updated] = await db
      .update(knowledgeTable)
      .set({ ...bodyParsed.data, updatedAt: new Date() })
      .where(eq(knowledgeTable.id, idParsed.data.id))
      .returning();

    if (!updated) return res.status(404).json({ error: "Entry not found" });

    res.json({
      ...updated,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to update knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const idParsed = DeleteKnowledgeParams.safeParse({ id: Number(req.params.id) });
    if (!idParsed.success) return res.status(400).json({ error: "Invalid id" });

    const deleted = await db
      .delete(knowledgeTable)
      .where(eq(knowledgeTable.id, idParsed.data.id))
      .returning();

    if (deleted.length === 0) return res.status(404).json({ error: "Entry not found" });

    res.json({ success: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete knowledge entry");
    res.status(500).json({ error: "Internal server error" });
  }
});

// --- Google Sheet sync ---

const VALID_TYPES = new Set(["product", "faq", "script", "testimonial", "website"]);

// Strictly allow only docs.google.com spreadsheets URLs to prevent SSRF.
// Returns the validated sheet identity ({ kind, id, defaultGid }) and the
// caller rebuilds final fetch URLs from these components — we never reuse
// the raw user-supplied URL for outbound requests.
type SheetId =
  | { kind: "regular"; id: string; defaultGid: string | null }
  | { kind: "published"; id: string; defaultGid: string | null };

function parseSheetUrl(input: string): SheetId | null {
  const raw = input.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.hostname !== "docs.google.com") return null;

  // Published-to-web: /spreadsheets/d/e/{PUB_ID}/pub
  const pubMatch = parsed.pathname.match(
    /^\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)\/pub\b/
  );
  if (pubMatch) {
    const gid = parsed.searchParams.get("gid");
    return {
      kind: "published",
      id: pubMatch[1],
      defaultGid: gid && /^\d+$/.test(gid) ? gid : null,
    };
  }

  // Regular sheet: /spreadsheets/d/{ID}/...
  const idMatch = parsed.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(\/|$)/);
  if (idMatch) {
    let gid = parsed.searchParams.get("gid");
    if (!gid) {
      const hashMatch = parsed.hash.match(/gid=(\d+)/);
      gid = hashMatch ? hashMatch[1] : null;
    }
    return {
      kind: "regular",
      id: idMatch[1],
      defaultGid: gid && /^\d+$/.test(gid) ? gid : null,
    };
  }

  return null;
}

function buildCsvUrl(sheet: SheetId, gidOverride: string | null): string {
  const gid = gidOverride && /^\d+$/.test(gidOverride) ? gidOverride : sheet.defaultGid;
  const gidPart = gid ? `&gid=${gid}` : "";
  if (sheet.kind === "published") {
    return `https://docs.google.com/spreadsheets/d/e/${sheet.id}/pub?output=csv${gidPart}`;
  }
  return `https://docs.google.com/spreadsheets/d/${sheet.id}/export?format=csv${gidPart}`;
}

// Fetch the public-facing HTML view of the sheet and extract { gid, name }
// pairs for every tab. Works for both "Anyone with link" sheets (/htmlview)
// and "Publish to web" sheets (/pubhtml). All outbound requests are bound to
// docs.google.com only (SSRF-safe).
async function fetchSheetTabs(
  sheet: SheetId
): Promise<{ gid: string; name: string }[]> {
  const urls =
    sheet.kind === "published"
      ? [`https://docs.google.com/spreadsheets/d/e/${sheet.id}/pubhtml`]
      : [
          `https://docs.google.com/spreadsheets/d/${sheet.id}/htmlview`,
          `https://docs.google.com/spreadsheets/d/${sheet.id}/pubhtml`,
        ];

  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, { redirect: "follow", signal: controller.signal });
      clearTimeout(t);
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status} dari ${url.includes("htmlview") ? "htmlview" : "pubhtml"}`);
        continue;
      }
      const html = await resp.text();
      const tabs = parseTabsFromHtml(html);
      if (tabs.length > 0) return tabs;
      lastErr = new Error("Tidak menemukan daftar tab di halaman sheet.");
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error("Gagal mengambil daftar tab");
    }
  }
  throw lastErr ?? new Error("Gagal mengambil daftar tab");
}

function parseTabsFromHtml(html: string): { gid: string; name: string }[] {
  const found = new Map<string, string>();

  const addTab = (gid: string, rawName: string) => {
    // Strip any nested tags inside the anchor (Google sometimes wraps the
    // sheet name in spans/divs) and decode HTML entities.
    const name = decodeEntities(rawName.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (gid && name && !found.has(gid)) found.set(gid, name);
  };

  // Pattern A (both /htmlview and /pubhtml). Accept single or double quotes
  // on the id attribute and any nested markup inside the <a>.
  //   <li id="sheet-button-{GID}" ...> ... <a ...>...{NAME}...</a> ... </li>
  const reA =
    /id\s*=\s*['"]sheet-button-(\d+)['"][\s\S]*?<a\b[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = reA.exec(html)) !== null) {
    addTab(m[1], m[2]);
  }

  // Pattern B (fallback for pages rendering a <select> with options):
  //   <option value="{GID}">{NAME}</option>
  if (found.size === 0) {
    const reB =
      /<option\b[^>]*\bvalue\s*=\s*['"](\d+)['"][^>]*>([\s\S]*?)<\/option>/g;
    while ((m = reB.exec(html)) !== null) {
      addTab(m[1], m[2]);
    }
  }

  return Array.from(found.entries()).map(([gid, name]) => ({ gid, name }));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Minimal RFC4180 CSV parser. Handles quoted fields, escaped quotes, CRLF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

router.get("/google-sheet-tabs", async (req, res) => {
  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    const sheetUrl = settings?.googleSheetCsvUrl?.trim();
    if (!sheetUrl) {
      return res
        .status(400)
        .json({ success: false, tabs: [], error: "Google Sheet URL belum diatur di Settings" });
    }
    const sheet = parseSheetUrl(sheetUrl);
    if (!sheet) {
      return res
        .status(400)
        .json({ success: false, tabs: [], error: "Format URL Google Sheet tidak dikenali" });
    }
    try {
      const tabs = await fetchSheetTabs(sheet);
      if (tabs.length === 0) {
        return res.status(400).json({
          success: false,
          tabs: [],
          error:
            'Tidak bisa membaca daftar tab. Pastikan sheet di-share "Anyone with the link" atau di-publish.',
        });
      }
      return res.json({ success: true, tabs });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gagal mengambil daftar tab";
      return res.status(400).json({ success: false, tabs: [], error: msg });
    }
  } catch (err) {
    req.log.error({ err }, "Failed to list google sheet tabs");
    res.status(500).json({ success: false, tabs: [], error: "Internal server error" });
  }
});

// Simple in-process single-flight lock to prevent concurrent syncs racing on
// delete+insert (which would otherwise produce duplicate or partial rows).
let syncInFlight = false;

router.post("/sync-google-sheet", async (req, res) => {
  if (syncInFlight) {
    return res
      .status(409)
      .json({ success: false, count: 0, error: "Sync sedang berjalan, tunggu sebentar." });
  }
  syncInFlight = true;
  try {
    // Optional gid from request body picks a specific tab. If the caller
    // provided a gid, it MUST be numeric — reject explicitly rather than
    // silently falling back to the default tab.
    const rawGidUnknown =
      req.body && typeof req.body === "object"
        ? (req.body as { gid?: unknown }).gid
        : undefined;
    let gidOverride: string | null = null;
    if (rawGidUnknown !== undefined && rawGidUnknown !== null && rawGidUnknown !== "") {
      if (typeof rawGidUnknown !== "string" || !/^\d+$/.test(rawGidUnknown)) {
        return res.status(400).json({
          success: false,
          count: 0,
          error: "Parameter 'gid' tidak valid (harus angka).",
        });
      }
      gidOverride = rawGidUnknown;
    }

    const [settings] = await db.select().from(settingsTable).limit(1);
    const sheetUrl = settings?.googleSheetCsvUrl?.trim();
    if (!sheetUrl) {
      return res
        .status(400)
        .json({ success: false, count: 0, error: "Google Sheet URL belum diatur di Settings" });
    }

    const sheet = parseSheetUrl(sheetUrl);
    if (!sheet) {
      const errMsg = "Format URL Google Sheet tidak dikenali";
      if (settings) {
        await db
          .update(settingsTable)
          .set({
            googleSheetLastSyncAt: new Date(),
            googleSheetLastSyncError: errMsg,
            googleSheetLastSyncCount: 0,
            updatedAt: new Date(),
          })
          .where(eq(settingsTable.id, settings.id));
      }
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }
    const csvUrl = buildCsvUrl(sheet, gidOverride);

    let csvText: string;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(csvUrl, { redirect: "follow", signal: controller.signal });
      clearTimeout(t);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} — pastikan sheet di-publish atau "Anyone with link"`);
      }
      csvText = await resp.text();
      // Detect if Google returned an HTML login page instead of CSV
      if (csvText.startsWith("<!DOCTYPE") || csvText.startsWith("<html")) {
        throw new Error(
          'Sheet tidak public. Set "Anyone with the link" atau Publish to web sebagai CSV.'
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Gagal mengambil sheet";
      await db
        .update(settingsTable)
        .set({
          googleSheetLastSyncAt: new Date(),
          googleSheetLastSyncError: msg,
          googleSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings!.id));
      return res.status(400).json({ success: false, count: 0, error: msg });
    }

    const rows = parseCsv(csvText);
    if (rows.length < 2) {
      const errMsg = "Sheet kosong atau tidak punya data (selain header)";
      await db
        .update(settingsTable)
        .set({
          googleSheetLastSyncAt: new Date(),
          googleSheetLastSyncError: errMsg,
          googleSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings!.id));
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    // Skip header row
    const dataRows = rows.slice(1);
    const entries: { type: string; title: string; content: string; source: string }[] = [];
    for (const r of dataRows) {
      const rawType = (r[0] ?? "").trim().toLowerCase();
      const title = (r[1] ?? "").trim();
      const content = (r[2] ?? "").trim();
      if (!title || !content) continue;
      const type = VALID_TYPES.has(rawType) ? rawType : "faq";
      entries.push({ type, title, content, source: "google_sheet" });
    }

    if (entries.length === 0) {
      const errMsg =
        "Tidak ada baris valid. Format kolom: A=type, B=title, C=content (baris 1 = header)";
      await db
        .update(settingsTable)
        .set({
          googleSheetLastSyncAt: new Date(),
          googleSheetLastSyncError: errMsg,
          googleSheetLastSyncCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(settingsTable.id, settings!.id));
      return res.status(400).json({ success: false, count: 0, error: errMsg });
    }

    // Replace all prior sheet-synced entries, keep manual entries untouched
    await db.transaction(async (tx) => {
      await tx.delete(knowledgeTable).where(eq(knowledgeTable.source, "google_sheet"));
      await tx.insert(knowledgeTable).values(entries);
    });

    await db
      .update(settingsTable)
      .set({
        googleSheetLastSyncAt: new Date(),
        googleSheetLastSyncError: null,
        googleSheetLastSyncCount: entries.length,
        updatedAt: new Date(),
      })
      .where(eq(settingsTable.id, settings!.id));

    res.json({ success: true, count: entries.length });
  } catch (err) {
    req.log.error({ err }, "Failed to sync google sheet");
    res.status(500).json({ success: false, count: 0, error: "Internal server error" });
  } finally {
    syncInFlight = false;
  }
});

export default router;
