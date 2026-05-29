import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage } from "pdf-lib";
import sharp from "sharp";
import { loadImageBuffer } from "../routes/whatsapp";

export interface QuotationItem {
  name: string;
  code: string;
  price: number;
  imageUrl: string | null;
}

const IDR = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

// Mirror of the frontend resolveImageSrc: turn a Google Drive share/view URL
// (or iframe embed) into a direct thumbnail URL the server can fetch. Non-Drive
// inputs are returned unchanged.
function resolveDriveImageUrl(input: string): string {
  const raw = input.trim();
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

// Load a product image and normalise it to a PNG buffer pdf-lib can embed.
// sharp handles webp/gif/jpeg/etc. uniformly; we downscale to keep the PDF
// small. Returns null on any failure so the row still renders without a photo.
async function loadPngThumbnail(imageUrl: string | null): Promise<Uint8Array | null> {
  if (!imageUrl) return null;
  try {
    const resolved = resolveDriveImageUrl(imageUrl);
    const raw = await loadImageBuffer(resolved);
    const png = await sharp(raw)
      .resize(120, 120, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
    return new Uint8Array(png);
  } catch {
    return null;
  }
}

// Greedily wrap `text` into lines no wider than maxWidth at the given size.
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      // Hard-break a single word that's too long on its own.
      if (font.widthOfTextAtSize(w, size) > maxWidth) {
        let chunk = "";
        for (const ch of w) {
          if (font.widthOfTextAtSize(chunk + ch, size) <= maxWidth) {
            chunk += ch;
          } else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        line = chunk;
      } else {
        line = w;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

const dateFmt = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "numeric",
  month: "long",
  year: "numeric",
});

export async function buildQuotationPdf(
  items: QuotationItem[],
  opts: { businessName?: string } = {}
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Preload thumbnails with bounded concurrency so a large selection doesn't
  // fire hundreds of simultaneous external fetches + sharp conversions.
  const CONCURRENCY = 8;
  const thumbs: (Uint8Array | null)[] = new Array(items.length).fill(null);
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const slice = items.slice(i, i + CONCURRENCY);
    const loaded = await Promise.all(slice.map((it) => loadPngThumbnail(it.imageUrl)));
    loaded.forEach((t, j) => {
      thumbs[i + j] = t;
    });
  }
  const embedded: (PDFImage | null)[] = [];
  for (const t of thumbs) {
    if (!t) {
      embedded.push(null);
      continue;
    }
    try {
      embedded.push(await doc.embedPng(t));
    } catch {
      embedded.push(null);
    }
  }

  // A4 portrait.
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 48;
  const contentW = PAGE_W - MARGIN * 2;

  // Column layout (x offsets within the content area).
  const COL_NO = MARGIN;
  const COL_FOTO = MARGIN + 34;
  const COL_NAMA = MARGIN + 34 + 78;
  const PRICE_RIGHT = PAGE_W - MARGIN;
  const nameWidth = PRICE_RIGHT - COL_NAMA - 110;

  const ROW_PAD = 10;
  const IMG_SIZE = 56;
  const HEADER_FONT = 9;
  const BODY_FONT = 10;

  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.45, 0.5, 0.55);
  const line = rgb(0.85, 0.87, 0.9);
  const accent = rgb(0.12, 0.45, 0.95);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const drawTitleBlock = () => {
    page.drawText(opts.businessName?.trim() || "Penawaran Harga", {
      x: MARGIN,
      y: y - 18,
      size: 18,
      font: fontBold,
      color: ink,
    });
    page.drawText("PENAWARAN HARGA / QUOTATION", {
      x: MARGIN,
      y: y - 36,
      size: 9,
      font,
      color: accent,
    });
    const dateStr = `Tanggal: ${dateFmt.format(new Date())}`;
    page.drawText(dateStr, {
      x: PRICE_RIGHT - font.widthOfTextAtSize(dateStr, 9),
      y: y - 18,
      size: 9,
      font,
      color: muted,
    });
    const countStr = `${items.length} item`;
    page.drawText(countStr, {
      x: PRICE_RIGHT - font.widthOfTextAtSize(countStr, 9),
      y: y - 32,
      size: 9,
      font,
      color: muted,
    });
    y -= 56;
  };

  const drawColumnHeader = () => {
    page.drawRectangle({
      x: MARGIN,
      y: y - 20,
      width: contentW,
      height: 20,
      color: rgb(0.96, 0.97, 0.98),
    });
    const ty = y - 14;
    page.drawText("NO", { x: COL_NO + 2, y: ty, size: HEADER_FONT, font: fontBold, color: muted });
    page.drawText("FOTO", { x: COL_FOTO, y: ty, size: HEADER_FONT, font: fontBold, color: muted });
    page.drawText("NAMA PRODUK", { x: COL_NAMA, y: ty, size: HEADER_FONT, font: fontBold, color: muted });
    const ph = "HARGA";
    page.drawText(ph, {
      x: PRICE_RIGHT - fontBold.widthOfTextAtSize(ph, HEADER_FONT),
      y: ty,
      size: HEADER_FONT,
      font: fontBold,
      color: muted,
    });
    y -= 24;
  };

  drawTitleBlock();
  drawColumnHeader();

  let total = 0;
  items.forEach((it, idx) => {
    const img = embedded[idx];
    const nameLines = wrapText(it.name || "-", font, BODY_FONT, nameWidth);
    const textBlockH = nameLines.length * (BODY_FONT + 3) + (it.code ? BODY_FONT + 2 : 0);
    const rowH = Math.max(IMG_SIZE, textBlockH) + ROW_PAD * 2;

    // Page break if the row won't fit.
    if (y - rowH < MARGIN + 40) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      drawColumnHeader();
    }

    const rowTop = y;
    const rowCenter = rowTop - rowH / 2;

    // Row number.
    page.drawText(String(idx + 1), {
      x: COL_NO + 2,
      y: rowCenter - BODY_FONT / 2,
      size: BODY_FONT,
      font,
      color: muted,
    });

    // Photo (vertically centered) or placeholder box.
    const imgY = rowCenter - IMG_SIZE / 2;
    if (img) {
      const scale = Math.min(IMG_SIZE / img.width, IMG_SIZE / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawImage(img, {
        x: COL_FOTO + (IMG_SIZE - w) / 2,
        y: imgY + (IMG_SIZE - h) / 2,
        width: w,
        height: h,
      });
    } else {
      page.drawRectangle({
        x: COL_FOTO,
        y: imgY,
        width: IMG_SIZE,
        height: IMG_SIZE,
        borderColor: line,
        borderWidth: 1,
        color: rgb(0.97, 0.97, 0.98),
      });
    }

    // Name (+ code) block, vertically centered.
    let ty = rowCenter + textBlockH / 2 - BODY_FONT;
    for (const ln of nameLines) {
      page.drawText(ln, { x: COL_NAMA, y: ty, size: BODY_FONT, font, color: ink });
      ty -= BODY_FONT + 3;
    }
    if (it.code) {
      page.drawText(`Kode: ${it.code}`, {
        x: COL_NAMA,
        y: ty,
        size: BODY_FONT - 2,
        font,
        color: muted,
      });
    }

    // Price, right-aligned and vertically centered.
    const priceStr = IDR.format(it.price);
    page.drawText(priceStr, {
      x: PRICE_RIGHT - fontBold.widthOfTextAtSize(priceStr, BODY_FONT),
      y: rowCenter - BODY_FONT / 2,
      size: BODY_FONT,
      font: fontBold,
      color: ink,
    });

    total += it.price;

    // Bottom divider.
    page.drawLine({
      start: { x: MARGIN, y: rowTop - rowH },
      end: { x: PRICE_RIGHT, y: rowTop - rowH },
      thickness: 0.5,
      color: line,
    });

    y = rowTop - rowH;
  });

  // Total row.
  if (y - 40 < MARGIN) {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - MARGIN;
  }
  y -= 12;
  const totalLabel = "TOTAL";
  const totalStr = IDR.format(total);
  page.drawText(totalLabel, {
    x: COL_NAMA,
    y: y - 12,
    size: 11,
    font: fontBold,
    color: ink,
  });
  page.drawText(totalStr, {
    x: PRICE_RIGHT - fontBold.widthOfTextAtSize(totalStr, 13),
    y: y - 13,
    size: 13,
    font: fontBold,
    color: accent,
  });
  page.drawLine({
    start: { x: MARGIN, y: y - 22 },
    end: { x: PRICE_RIGHT, y: y - 22 },
    thickness: 1,
    color: ink,
  });

  return await doc.save();
}
