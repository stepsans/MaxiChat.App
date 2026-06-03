import { Router, type IRouter } from "express";
import dnsCallback from "node:dns";
import net from "node:net";
import dns from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import ipaddr from "ipaddr.js";
import { GetLinkPreviewQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

// Reject any non-public IP. Mirrors the guard used for remote image fetches in
// chats.ts: only globally-routable unicast addresses are allowed, and
// IPv4-mapped IPv6 is re-checked against the IPv4 ranges.
function isPrivateIp(ip: string): boolean {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (parsed.kind() === "ipv6") {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isPrivateIp(v6.toIPv4Address().toString());
    }
  }
  return parsed.range() !== "unicast";
}

// Undici dispatcher that re-validates the resolved IP at connect time so a
// DNS-rebinding answer that flips to a private IP after the pre-check is still
// rejected by the socket connect itself.
const safeDispatcher = new Agent({
  connect: {
    lookup: (hostname: string, optsOrCb: any, maybeCb?: any) => {
      const cb: (err: NodeJS.ErrnoException | null, ...rest: any[]) => void =
        typeof optsOrCb === "function" ? optsOrCb : maybeCb;
      const opts =
        typeof optsOrCb === "function" || optsOrCb == null ? {} : optsOrCb;
      const wantAll = opts.all === true;
      dnsCallback.lookup(
        hostname,
        {
          family: typeof opts.family === "number" ? opts.family : 0,
          hints: opts.hints,
          verbatim: true,
          all: true,
        },
        (err, addresses) => {
          if (err) return cb(err);
          const list = Array.isArray(addresses) ? addresses : [];
          if (list.length === 0) {
            return cb(new Error(`DNS lookup returned no address for ${hostname}`));
          }
          const safe = list.filter((a) => !isPrivateIp(a.address));
          if (safe.length === 0) {
            return cb(
              new Error(`Host resolves only to private IPs at connect time: ${hostname}`)
            );
          }
          if (wantAll) cb(null, safe);
          else cb(null, safe[0].address, safe[0].family);
        }
      );
    },
  },
});

// HTML-entity decode for the small subset that shows up in OG/title text.
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ");
}

// Pull a single <meta property="og:x" content="..."> (or name="x") value.
function metaContent(html: string, key: string): string | null {
  // property/name may appear before OR after content, and quotes vary.
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`,
      "i"
    ),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return null;
}

// GET /link-preview?url= — fetch a page and extract OpenGraph metadata so the
// client can render a link-preview card. SSRF-guarded (no private IPs), size-
// and time-bounded, and only follows http(s). Returns nulls (never errors) for
// pages that simply have no usable metadata, so the UI degrades to a plain link.
router.get("/", async (req, res): Promise<void> => {
  const parsed = GetLinkPreviewQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid url" });
    return;
  }

  let url: URL;
  try {
    url = new URL(parsed.data.url);
  } catch {
    res.status(400).json({ error: "Invalid url" });
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    res.status(400).json({ error: "Unsupported protocol" });
    return;
  }

  // Pre-check the literal/resolved host before connecting.
  try {
    const host = url.hostname;
    if (net.isIP(host)) {
      if (isPrivateIp(host)) throw new Error("private ip");
    } else {
      const records = await dns.lookup(host, { all: true, verbatim: true });
      if (records.length === 0 || records.every((r) => isPrivateIp(r.address))) {
        throw new Error("private ip");
      }
    }
  } catch {
    res.status(400).json({ error: "Host not allowed" });
    return;
  }

  const MAX_BYTES = 1024 * 1024; // 1 MiB of HTML is plenty for <head> metadata
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await undiciFetch(url.toString(), {
      dispatcher: safeDispatcher,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        // Identify as a link-preview bot; many sites serve OG tags to crawlers.
        "user-agent": "MaxiChatBot/1.0 (+link-preview)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    const contentType = resp.headers.get("content-type") ?? "";
    if (!resp.ok || !contentType.includes("text/html")) {
      res.json({ url: url.toString(), title: null, description: null, image: null, siteName: null });
      return;
    }

    // Read at most MAX_BYTES so a giant/streamed page can't exhaust memory.
    const reader = resp.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        html += decoder.decode(value, { stream: true });
        if (total >= MAX_BYTES) {
          await reader.cancel();
          break;
        }
      }
    }

    const title =
      metaContent(html, "og:title") ||
      (() => {
        const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        return m?.[1] ? decodeEntities(m[1].trim()) : null;
      })();
    const description =
      metaContent(html, "og:description") || metaContent(html, "description");
    let image = metaContent(html, "og:image") || metaContent(html, "og:image:url");
    const siteName = metaContent(html, "og:site_name");

    // Resolve a relative og:image against the page URL so the client gets an
    // absolute, loadable src.
    if (image) {
      try {
        image = new URL(image, url.toString()).toString();
      } catch {
        image = null;
      }
    }

    res.json({
      url: url.toString(),
      title: title || null,
      description: description || null,
      image: image || null,
      siteName: siteName || null,
    });
  } catch (err) {
    req.log.error({ err, url: url.toString() }, "link preview fetch failed");
    // Soft-fail: return a bare entry so the UI still renders a plain link.
    res.json({ url: url.toString(), title: null, description: null, image: null, siteName: null });
  } finally {
    clearTimeout(timer);
  }
});

export default router;
