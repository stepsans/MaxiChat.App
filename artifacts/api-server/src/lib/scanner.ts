import sharp from "sharp";
import type { ResolvedAiClient } from "./ai-provider";
import type { CompletionUsage } from "./ai-usage";

// Scanner AI: turn a casually-taken receipt photo into a clean "scanned"
// document — detect the document's four corners (via the AI vision model),
// perspective-warp it to a deskewed rectangle, and apply scanner-style
// finishing (illumination flattening + contrast + sharpen) the way Adobe Scan /
// Microsoft Lens do. All image math is done in-process in pure JS (homography
// warp + pixel ops on raw buffers) so there is no native/WASM dependency to
// bundle; `sharp` handles decode, blur, enhancement and re-encode.
//
// Straightness depends entirely on corner accuracy (the warp output is always a
// perfect rectangle), and vision models are imprecise at absolute coordinates.
// So detection runs COARSE-TO-FINE: a first pass locates the receipt roughly,
// then we crop tightly around it and re-detect — in the zoomed crop the receipt
// fills the frame, so the same relative model error maps to far fewer pixels and
// the corners land much closer to the true paper edges.

export interface ScanResult {
  buf: Buffer;
  mime: string;
  // True when a document was detected and the image was perspective-corrected.
  // False when we fell back to a light enhancement of the original framing.
  detected: boolean;
  // Combined token usage from the corner-detection vision call(s).
  usage?: CompletionUsage | null;
}

interface Pt {
  x: number;
  y: number;
}

// Cap the working resolution: the warp is O(width*height) in JS, and receipts
// don't need more than this to stay legible. Output is bounded the same way.
const MAX_DIM = 2000;

const DETECT_PROMPT = `Anda adalah pendeteksi tepi dokumen untuk aplikasi pemindai (scanner) sekelas Adobe Scan. Pada foto berikut terdapat sebuah nota/struk/dokumen kertas. Tentukan posisi KEEMPAT sudut lembar dokumen tersebut SETEPAT mungkin, tepat di pojok kertas (titik pertemuan dua tepi), bukan di tepi objek lain.

Balas HANYA dengan satu objek JSON, tanpa teks lain, dengan bentuk:
{"found": true, "corners": [{"x":0.0,"y":0.0},{"x":1.0,"y":0.0},{"x":1.0,"y":1.0},{"x":0.0,"y":1.0}]}

Aturan:
- "x" dan "y" adalah pecahan posisi relatif terhadap ukuran gambar: x=0 kiri, x=1 kanan, y=0 atas, y=1 bawah. Gunakan desimal teliti (mis. 0.137).
- Berikan tepat 4 titik, masing-masing pada satu sudut kertas (boleh urutan apa saja).
- Letakkan titik PERSIS di pojok kertas walaupun sedikit miring/terangkat; ikuti garis tepi kertas.
- Jika tidak ada dokumen yang jelas, atau keempat sudutnya tidak terlihat (terpotong), balas {"found": false}.`;

// Extract the first {...} JSON object from a model reply and parse it.
function parseJson(content: string): Record<string, unknown> | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(content.slice(start, end + 1));
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Pull 4 normalized corner points from the model's parsed reply, or null when
// it reported no document / gave an unusable shape.
function readCorners(obj: Record<string, unknown> | null): Pt[] | null {
  if (!obj) return null;
  if (obj.found === false) return null;
  const raw = obj.corners;
  if (!Array.isArray(raw) || raw.length !== 4) return null;
  const pts: Pt[] = [];
  for (const c of raw) {
    const x = Number((c as Pt)?.x);
    const y = Number((c as Pt)?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Clamp into [0,1] — the model occasionally overshoots slightly.
    pts.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
  }
  return pts;
}

// Order an unordered set of 4 points into [top-left, top-right, bottom-right,
// bottom-left] using the classic sum/diff trick (robust to model ordering).
function orderCorners(pts: Pt[]): { tl: Pt; tr: Pt; br: Pt; bl: Pt } {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => a.x - a.y - (b.x - b.y));
  return {
    tl: bySum[0]!, // smallest x+y
    br: bySum[3]!, // largest x+y
    tr: byDiff[3]!, // largest x-y
    bl: byDiff[0]!, // smallest x-y
  };
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Sum token usage across the (up to two) detection calls.
function addUsage(
  a: CompletionUsage | null,
  b: CompletionUsage | null
): CompletionUsage | null {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number | null, y?: number | null) => (x ?? 0) + (y ?? 0);
  return {
    prompt_tokens: sum(a.prompt_tokens, b.prompt_tokens),
    completion_tokens: sum(a.completion_tokens, b.completion_tokens),
    total_tokens: sum(a.total_tokens, b.total_tokens),
  };
}

// Validate an ordered quad [tl,tr,br,bl] before trusting it for a warp: corners
// must be distinct and the polygon must enclose a meaningful area relative to
// the image. Guards against the sum/diff ordering mis-assigning near-degenerate
// or near-collinear corner sets (which would otherwise warp to garbage).
// `minAreaFrac` is the minimum share of the image the quad must cover.
function isValidQuad(q: Pt[], imgW: number, imgH: number, minAreaFrac: number): boolean {
  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j < q.length; j++) {
      if (dist(q[i]!, q[j]!) < Math.min(imgW, imgH) * 0.02) return false;
    }
  }
  // Shoelace area of the ordered polygon.
  let area = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  return area >= imgW * imgH * minAreaFrac;
}

// Solve the 8 projective parameters (a..h) of the homography mapping the four
// `from` points to the four `to` points, via an 8x8 linear system + Gaussian
// elimination with partial pivoting. Returns [a,b,c,d,e,f,g,h] or null if the
// system is degenerate.
function solveHomography(from: Pt[], to: Pt[]): number[] | null {
  const A: number[][] = [];
  const B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: X, y: Y } = to[i]!;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    B.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    B.push(Y);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    }
    if (Math.abs(A[piv]![col]!) < 1e-9) return null;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    [B[col], B[piv]] = [B[piv]!, B[col]!];
    const pv = A[col]![col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = A[r]![col]! / pv;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) {
        A[r]![c] = A[r]![c]! - factor * A[col]![c]!;
      }
      B[r] = B[r]! - factor * B[col]!;
    }
  }
  const h: number[] = new Array(n);
  for (let i = 0; i < n; i++) h[i] = B[i]! / A[i]![i]!;
  return h;
}

// Perspective-warp a raw RGB image given an inverse-mapping homography (output
// coords -> source coords). Bilinear sampling; out-of-bounds reads return white.
function warp(
  src: Buffer,
  sw: number,
  sh: number,
  ow: number,
  oh: number,
  h: number[]
): Buffer {
  const [a, b, c, d, e, f, g, i] = h as [
    number, number, number, number, number, number, number, number,
  ];
  const out = Buffer.alloc(ow * oh * 3, 255);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const denom = g * x + i * y + 1;
      if (denom === 0) continue;
      const u = (a * x + b * y + c) / denom;
      const v = (d * x + e * y + f) / denom;
      if (u < 0 || v < 0 || u > sw - 1 || v > sh - 1) continue;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const fx = u - x0;
      const fy = v - y0;
      const oIdx = (y * ow + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = src[(y0 * sw + x0) * 3 + ch]!;
        const p10 = src[(y0 * sw + x1) * 3 + ch]!;
        const p01 = src[(y1 * sw + x0) * 3 + ch]!;
        const p11 = src[(y1 * sw + x1) * 3 + ch]!;
        const top = p00 + (p10 - p00) * fx;
        const bot = p01 + (p11 - p01) * fx;
        out[oIdx + ch] = Math.round(top + (bot - top) * fy);
      }
    }
  }
  return out;
}

// Flatten uneven lighting / drop shadows: estimate the smooth background
// illumination (heavy downscale → blur → upscale) and divide the image by it,
// per channel. Paper (≈ its local illumination) goes to white; shadows and
// gradients are removed; dark ink stays dark. This is the core of the "looks
// like a real scan, background gone" effect.
async function illuminationFlatten(rawBuf: Buffer, w: number, h: number): Promise<Buffer> {
  const dw = Math.max(2, Math.round(w / 16));
  const dh = Math.max(2, Math.round(h / 16));
  const bg = await sharp(rawBuf, { raw: { width: w, height: h, channels: 3 } })
    .resize(dw, dh, { fit: "fill" })
    .blur(2)
    .resize(w, h, { fit: "fill" })
    .raw()
    .toBuffer();
  const out = Buffer.alloc(w * h * 3);
  for (let i = 0; i < out.length; i++) {
    const b = bg[i]!;
    const s = rawBuf[i]!;
    let v = b > 0 ? (s / b) * 255 : 255;
    if (v > 255) v = 255;
    out[i] = v;
  }
  return out;
}

// Scanner-style finishing for a warped raw RGB document: flatten illumination,
// then a gentle contrast lift + sharpen + JPEG encode.
async function scanFinish(rawBuf: Buffer, w: number, h: number): Promise<Buffer> {
  const flat = await illuminationFlatten(rawBuf, w, h);
  return sharp(flat, { raw: { width: w, height: h, channels: 3 } })
    .linear(1.15, -12) // mild contrast: deepen ink, keep paper white
    .normalize()
    .sharpen()
    .jpeg({ quality: 92 })
    .toBuffer();
}

// Light-enhance the original image (no geometry change) — used when no document
// could be detected, so we still upload something cleaner than the raw photo.
async function lightEnhance(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .rotate()
    .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
    .normalize()
    .sharpen()
    .jpeg({ quality: 92 })
    .toBuffer();
}

// Otsu's method: pick the grayscale threshold that maximizes between-class
// variance (separates bright paper from a darker background).
function otsuThreshold(hist: number[], total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0;
  let wB = 0;
  let max = 0;
  let thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      thr = t;
    }
  }
  return thr;
}

// Classical document detection: segment the bright page from a darker
// background and take the four extreme corners of the largest bright blob. This
// is deterministic and pixel-precise (no model imprecision) and is the ideal
// path for the common "receipt on a table" shot. Returns normalized corners or
// null when it can't cleanly segment a page (cluttered / low-contrast scenes).
async function detectByEdges(
  work: Buffer,
  W: number,
  H: number
): Promise<Pt[] | null> {
  const scale = Math.min(1, 480 / Math.max(W, H));
  const dw = Math.max(16, Math.round(W * scale));
  const dh = Math.max(16, Math.round(H * scale));
  const gray = await sharp(work)
    .resize(dw, dh, { fit: "fill" })
    .grayscale()
    .blur(1)
    .raw()
    .toBuffer();
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i]!]++;
  const thr = otsuThreshold(hist, gray.length);
  // Require a real brightness gap between page and background; otherwise this is
  // a low-contrast scene the threshold can't trust → let the AI handle it.
  if (thr < 40) return null;
  const fg = new Uint8Array(dw * dh);
  for (let i = 0; i < gray.length; i++) fg[i] = gray[i]! > thr ? 1 : 0;

  // Largest 4-connected bright component (flood fill).
  const labels = new Int32Array(dw * dh);
  const stack: number[] = [];
  let cur = 0;
  let best = 0;
  let bestSize = 0;
  for (let p = 0; p < fg.length; p++) {
    if (!fg[p] || labels[p] !== 0) continue;
    cur++;
    let size = 0;
    stack.length = 0;
    stack.push(p);
    labels[p] = cur;
    while (stack.length) {
      const q = stack.pop()!;
      size++;
      const x = q % dw;
      const y = (q - x) / dw;
      if (x > 0 && fg[q - 1] && labels[q - 1] === 0) {
        labels[q - 1] = cur;
        stack.push(q - 1);
      }
      if (x < dw - 1 && fg[q + 1] && labels[q + 1] === 0) {
        labels[q + 1] = cur;
        stack.push(q + 1);
      }
      if (y > 0 && fg[q - dw] && labels[q - dw] === 0) {
        labels[q - dw] = cur;
        stack.push(q - dw);
      }
      if (y < dh - 1 && fg[q + dw] && labels[q + dw] === 0) {
        labels[q + dw] = cur;
        stack.push(q + dw);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = cur;
    }
  }
  if (best === 0) return null;
  const frac = bestSize / (dw * dh);
  // Too small = not the page; too large = the threshold caught the background.
  if (frac < 0.08 || frac > 0.95) return null;

  // Four extreme corners of the blob (TL=min x+y, BR=max x+y, TR=max x-y,
  // BL=min x-y) — the corners of a (possibly perspective-skewed) quad.
  let minS = Infinity;
  let maxS = -Infinity;
  let minD = Infinity;
  let maxD = -Infinity;
  let tl: Pt = { x: 0, y: 0 };
  let br: Pt = { x: 0, y: 0 };
  let tr: Pt = { x: 0, y: 0 };
  let bl: Pt = { x: 0, y: 0 };
  for (let p = 0; p < labels.length; p++) {
    if (labels[p] !== best) continue;
    const x = p % dw;
    const y = (p - x) / dw;
    const s = x + y;
    const d = x - y;
    if (s < minS) {
      minS = s;
      tl = { x, y };
    }
    if (s > maxS) {
      maxS = s;
      br = { x, y };
    }
    if (d > maxD) {
      maxD = d;
      tr = { x, y };
    }
    if (d < minD) {
      minD = d;
      bl = { x, y };
    }
  }
  return [tl, tr, br, bl].map((c) => ({ x: c.x / dw, y: c.y / dh }));
}

// Run one vision corner-detection call on a JPEG-encoded view of `imgBuf`.
async function detectCorners(
  imgBuf: Buffer,
  client: ResolvedAiClient["client"],
  model: string
): Promise<{ corners: Pt[] | null; usage: CompletionUsage | null }> {
  const dataUrl = `data:image/jpeg;base64,${(
    await sharp(imgBuf).jpeg({ quality: 85 }).toBuffer()
  ).toString("base64")}`;
  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: DETECT_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: "Deteksi sudut dokumen pada foto ini setepat mungkin." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    max_tokens: 200,
    temperature: 0,
  });
  return {
    corners: readCorners(parseJson(resp.choices[0]?.message?.content ?? "")),
    usage: resp.usage ?? null,
  };
}

// Run the full scan: detect corners (coarse-to-fine) with the vision model,
// deskew + enhance. Never throws — any failure falls back to a lightly-enhanced
// original so the archive step always gets a usable image.
export async function scanDocument(opts: {
  buf: Buffer;
  client: ResolvedAiClient["client"];
  model: string;
}): Promise<ScanResult> {
  const { buf, client, model } = opts;
  let usage: CompletionUsage | null = null;
  try {
    // Bake EXIF orientation and bound the working resolution once, so every
    // coordinate below is in the same (W x H) space.
    const work = await sharp(buf)
      .rotate()
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true })
      .toBuffer();
    const wm = await sharp(work).metadata();
    const W = wm.width ?? 0;
    const H = wm.height ?? 0;
    if (W < 32 || H < 32) {
      return { buf: await lightEnhance(buf), mime: "image/jpeg", detected: false, usage };
    }

    // Primary: classical edge/contrast segmentation — deterministic and
    // pixel-precise on the common high-contrast "page on a table" shot, with no
    // AI cost and no model coordinate imprecision.
    let corners: Pt[] | null = null; // normalized to work (W x H)
    try {
      const edged = await detectByEdges(work, W, H);
      if (edged) {
        // isValidQuad works in pixel space; edged is normalized.
        const pxq = edged.map((c) => ({ x: c.x * W, y: c.y * H }));
        const o = orderCorners(pxq);
        if (isValidQuad([o.tl, o.tr, o.br, o.bl], W, H, 0.1)) corners = edged;
      }
    } catch {
      corners = null;
    }

    // Fallback: vision model (coarse-to-fine) when segmentation can't isolate
    // the page (cluttered / low-contrast background).
    if (!corners) {
      const pass1 = await detectCorners(work, client, model);
      usage = pass1.usage;
      corners = pass1.corners;
      if (!corners) {
        return { buf: await lightEnhance(buf), mime: "image/jpeg", detected: false, usage };
      }
      // Pass 2 (fine): crop tightly around the coarse quad (with margin) and
      // re-detect so the receipt fills the frame and corners land precisely.
      try {
        const xs = corners.map((c) => c.x);
        const ys = corners.map((c) => c.y);
        const m = 0.06; // margin around the coarse box
        const minX = Math.max(0, Math.min(...xs) - m);
        const minY = Math.max(0, Math.min(...ys) - m);
        const maxX = Math.min(1, Math.max(...xs) + m);
        const maxY = Math.min(1, Math.max(...ys) + m);
        const left = Math.round(minX * W);
        const top = Math.round(minY * H);
        const cw = Math.round((maxX - minX) * W);
        const ch = Math.round((maxY - minY) * H);
        // Only worth a second pass if the crop is a real zoom-in.
        if (cw >= 64 && ch >= 64 && cw < W * 0.95 && ch < H * 0.95) {
          const crop = await sharp(work)
            .extract({ left, top, width: cw, height: ch })
            .toBuffer();
          const pass2 = await detectCorners(crop, client, model);
          usage = addUsage(usage, pass2.usage);
          if (pass2.corners) {
            const refined = pass2.corners.map((c) => ({
              x: (left + c.x * cw) / W,
              y: (top + c.y * ch) / H,
            }));
            const ord = orderCorners(refined);
            // Accept refined corners only if they form a sane quad.
            if (isValidQuad([ord.tl, ord.tr, ord.br, ord.bl], W, H, 0.04)) {
              corners = refined;
            }
          }
        }
      } catch {
        // Pass 2 is best-effort; fall back to the coarse corners.
      }
    }

    // Decode the working image to raw RGB for sampling.
    const {
      data,
      info: { width: sw, height: sh },
    } = await sharp(work).removeAlpha().raw().toBuffer({ resolveWithObject: true });

    // Map normalized corners to pixel coords and order them.
    const px = corners.map((c) => ({ x: c.x * sw, y: c.y * sh }));
    const { tl, tr, br, bl } = orderCorners(px);

    // Reject degenerate / mis-ordered quads before warping to garbage.
    if (!isValidQuad([tl, tr, br, bl], sw, sh, 0.1)) {
      return { buf: await lightEnhance(buf), mime: "image/jpeg", detected: false, usage };
    }

    // Output rectangle sized to the longer of each opposing edge pair.
    const outW = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    const outH = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    if (outW < 32 || outH < 32 || outW > MAX_DIM * 2 || outH > MAX_DIM * 2) {
      return { buf: await lightEnhance(buf), mime: "image/jpeg", detected: false, usage };
    }

    // Homography mapping OUTPUT rect corners -> SOURCE corners (inverse map for
    // the warp), then sample.
    const dstRect: Pt[] = [
      { x: 0, y: 0 },
      { x: outW, y: 0 },
      { x: outW, y: outH },
      { x: 0, y: outH },
    ];
    const h = solveHomography(dstRect, [tl, tr, br, bl]);
    if (!h) {
      return { buf: await lightEnhance(buf), mime: "image/jpeg", detected: false, usage };
    }
    const warped = warp(data, sw, sh, outW, outH, h);
    const outBuf = await scanFinish(warped, outW, outH);
    return { buf: outBuf, mime: "image/jpeg", detected: true, usage };
  } catch {
    // Any decode/model/warp failure: fall back to the original framing.
    try {
      return { buf: await lightEnhance(buf), mime: "image/jpeg", detected: false, usage };
    } catch {
      return { buf: opts.buf, mime: "image/jpeg", detected: false, usage };
    }
  }
}
