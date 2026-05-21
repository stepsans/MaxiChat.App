// Shared helpers for Google Sheet -> CSV sync flows (Knowledge Base, Products).

// Strictly allow only docs.google.com spreadsheets URLs to prevent SSRF.
// Accepts the three common shapes and always rebuilds the final fetch URL
// from validated components — never returns the user's input verbatim.
export function normalizeSheetUrlToCsv(input: string): string | null {
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

  // Published-to-web: /spreadsheets/d/e/{PUB_ID}/pub?output=csv[&gid=GID]
  const pubMatch = parsed.pathname.match(
    /^\/spreadsheets\/d\/e\/([a-zA-Z0-9_-]+)\/pub\b/
  );
  if (pubMatch) {
    const pubId = pubMatch[1];
    const gid = parsed.searchParams.get("gid");
    const gidPart = gid && /^\d+$/.test(gid) ? `&gid=${gid}` : "";
    return `https://docs.google.com/spreadsheets/d/e/${pubId}/pub?output=csv${gidPart}`;
  }

  // Regular sheet: /spreadsheets/d/{ID}/...
  const idMatch = parsed.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(\/|$)/);
  if (idMatch) {
    const id = idMatch[1];
    let gid = parsed.searchParams.get("gid");
    if (!gid) {
      const hashMatch = parsed.hash.match(/gid=(\d+)/);
      gid = hashMatch ? hashMatch[1] : null;
    }
    const gidPart = gid && /^\d+$/.test(gid) ? `&gid=${gid}` : "";
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${gidPart}`;
  }

  return null;
}

// Minimal RFC4180 CSV parser. Handles quoted fields, escaped quotes, CRLF.
export function parseCsv(text: string): string[][] {
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

export async function fetchSheetCsv(csvUrl: string): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(csvUrl, { redirect: "follow", signal: controller.signal });
    if (!resp.ok) {
      throw new Error(
        `HTTP ${resp.status} — pastikan sheet di-publish atau "Anyone with link"`
      );
    }
    const csvText = await resp.text();
    if (csvText.startsWith("<!DOCTYPE") || csvText.startsWith("<html")) {
      throw new Error(
        'Sheet tidak public. Set "Anyone with the link" atau Publish to web sebagai CSV.'
      );
    }
    return csvText;
  } finally {
    clearTimeout(t);
  }
}
