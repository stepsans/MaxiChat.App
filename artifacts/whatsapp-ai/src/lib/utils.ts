import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Format a byte count into a human-readable size (e.g. "12.3 MB").
 * Uses binary units (1 KB = 1024 B). Non-positive / invalid inputs => "0 B".
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Convert a Google Drive share/view URL (or iframe embed src) into a direct
 * image URL usable in <img src>. Non-Drive URLs are returned as-is. Falsy
 * inputs return null.
 *
 * Handles:
 *   https://drive.google.com/file/d/<id>/view?...
 *   https://drive.google.com/open?id=<id>
 *   https://drive.google.com/uc?id=<id>
 *   https://drive.google.com/thumbnail?id=<id>
 *   <iframe src="https://drive.google.com/file/d/<id>/preview" ...>
 */
export function resolveImageSrc(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim();
  if (!raw) return null;

  // Pull src from iframe embed if present
  let candidate = raw;
  const iframeMatch = raw.match(/<iframe[^>]*\bsrc=["']([^"']+)["']/i);
  if (iframeMatch) candidate = iframeMatch[1];

  if (!/^https?:\/\//i.test(candidate)) return candidate;

  try {
    const u = new URL(candidate);
    const host = u.hostname.toLowerCase();
    const isDrive =
      host === "drive.google.com" ||
      host === "docs.google.com" ||
      host.endsWith(".drive.google.com") ||
      host.endsWith(".docs.google.com");
    if (!isDrive) return candidate;

    let id = u.searchParams.get("id");
    if (!id) {
      const m = u.pathname.match(/\/(?:file|d)\/(?:d\/)?([a-zA-Z0-9_-]{10,})/);
      if (m) id = m[1];
    }
    if (!id) return candidate;
    return `https://drive.google.com/thumbnail?id=${id}&sz=w2000`;
  } catch {
    return candidate;
  }
}
