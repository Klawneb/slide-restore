// Finds the picture inside a scanned slide mount and crops off the border.
//
// Scans of slides usually show the cardboard/plastic mount round the edge,
// then the dark rim of the film, then the picture. Mounts can be lit
// unevenly and have writing on them ("VIEW FROM THIS SIDE"), and the picture
// can come right up to one edge of the scan. So rather than trusting the
// mount to be one even colour, we work inwards from each side looking for
// the film's dark rim, then skip it.
//
// Crop rectangles are fractions of the image: { x0, y0, x1, y1 } in 0..1,
// with an optional angle: degrees clockwise to straighten the image by
// first (the rectangle is then of the straightened image).

import { clamp } from './color.js';

export const FULL_CROP = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 });

export function isFullCrop(c) {
  return !c || (!c.angle && c.x0 <= 0.001 && c.y0 <= 0.001 && c.x1 >= 0.999 && c.y1 >= 0.999);
}

// Straighten and crop an image as a crop describes.
export function applyCrop(img, c) {
  return transform(img, c?.angle || 0, c);
}

const SIDES = ['left', 'right', 'top', 'bottom'];

// Returns a crop rectangle plus the rotation that straightens the picture
// ({ x0, y0, x1, y1, angle }, angle in degrees clockwise; the rectangle is
// of the straightened image), or null when there is no mount to remove.
export function detectCrop(input) {
  const img = shrink(input, 640); // plenty of detail for finding edges, and quick
  const first = detectRect(img);
  if (!first) return null;
  // Straighten by the measured tilt, then measure again on the result: the
  // second look both tightens the crop and corrects any leftover tilt.
  let best = first, angle = 0;
  for (let it = 0; it < 2 && best.tilt != null && Math.abs(best.tilt) >= 0.15; it++) {
    const next = clamp(angle - best.tilt, -MAX_TILT, MAX_TILT);
    const r = detectRect(transform(img, next, null));
    if (!r) break;
    best = r; angle = next;
  }
  if (Math.abs(angle) < 0.2) { best = first; angle = 0; }
  return { ...best.rect, angle: Math.round(angle * 100) / 100 };
}

const MAX_TILT = 5; // degrees: more than this is deliberate, not a crooked slide

// Crop rectangle of the mount's opening in this image, and the picture's
// tilt in degrees clockwise (null if it couldn't be measured).
function detectRect(img) {
  const { width: w, height: h } = img;
  if (w < 32 || h < 32) return null;
  const L = lumaPlane(img);
  // Thin, so a sliver of mount beside a picture that nearly fills the scan counts.
  const strip = Math.max(2, Math.round(Math.min(w, h) * 0.005));

  // Each side's outer strip: a mount is smooth there (lighting may vary
  // slowly along it, writing may cross part of it).
  const sides = SIDES.map((side) => {
    const all = stripPixels(img, side, strip);
    // Leave out strongly coloured writing that runs off the edge.
    const px = all.filter((p) => Math.max(...p) - Math.min(...p) < 80);
    if (px.length < all.length * 0.4) return { side, uniform: false };
    const med = [0, 1, 2].map((c) => median(px.map((p) => p[c])));
    const steps = [];
    for (let i = 1; i < px.length; i++) steps.push(dist(px[i], px[i - 1]));
    steps.sort((a, b) => a - b);
    const q = (t) => steps[Math.floor(steps.length * t)];
    return { side, med, lum: luma(med), uniform: q(0.5) < 6 && q(0.75) < 12 && q(0.9) < 20 };
  });

  // The sides showing the mount must agree on its colour (one mount), so a
  // plain sky reaching one edge of a borderless scan isn't mistaken for it.
  // Brightness may differ a lot between sides when the lighting falls off
  // across the scan; hue shouldn't.
  let mount = sides.filter((s) => s.uniform);
  if (mount.length < 2) return null;
  const hue = (m) => [m[0] - m[1], m[2] - m[1]];
  const ref = [0, 1].map((k) => median(mount.map((s) => hue(s.med)[k])));
  const refLum = median(mount.map((s) => s.lum));
  mount = mount.filter((s) => {
    const [a, b] = hue(s.med);
    return Math.abs(a - ref[0]) < 18 && Math.abs(b - ref[1]) < 18 && s.lum > refLum * 0.25 && s.lum < refLum / 0.25;
  });
  // Mounts are card or plastic, light where the lighting is good: deep
  // shadow round the edge of a borderless photo is not a mount.
  if (mount.length < 2 || Math.max(...mount.map((s) => s.lum)) < 90) return null;

  // Two passes: the second measures each side only along the picture found
  // by the first, so a big mount doesn't dilute the measurements.
  let span = { x0: 0.2, x1: 0.8, y0: 0.2, y1: 0.8 };
  let edges = null;
  for (let pass = 0; pass < 2; pass++) {
    edges = mount.map((s) => ({ side: s.side, ...(filmEdge(img, L, s, span) ?? {}) })).filter((e) => e.film != null);
    if (edges.length < 2) return null; // one "edge" alone is more likely picture
    const cut = Object.fromEntries(edges.map((e) => [e.side, e.film]));
    const x0 = (cut.left ?? 0) / w, x1 = 1 - (cut.right ?? 0) / w;
    const y0 = (cut.top ?? 0) / h, y1 = 1 - (cut.bottom ?? 0) / h;
    const ix = (x1 - x0) * 0.1, iy = (y1 - y0) * 0.1;
    span = { x0: x0 + ix, x1: x1 - ix, y0: y0 + iy, y1: y1 - iy };
  }

  // The film's dark rim is the same width all round, so sides where the
  // picture is too dark to see where the rim ends borrow the others' width.
  const long = Math.max(w, h);
  const measured = edges.map((e) => e.rim).filter((r) => r != null);
  const rimW = measured.length ? median(measured) : Math.round(0.011 * long);
  const cut = { left: 0, right: 0, top: 0, bottom: 0 };
  for (const e of edges) {
    const rim = e.rim != null ? Math.min(e.rim, rimW * 1.6) : rimW;
    // A little extra trims the slide's rounded corners.
    cut[e.side] = e.film + rim + 0.004 * long;
  }
  const rect = {
    x0: cut.left / w, x1: 1 - cut.right / w,
    y0: cut.top / h, y1: 1 - cut.bottom / h,
  };
  if (rect.x1 - rect.x0 < 0.35 || rect.y1 - rect.y0 < 0.35) return null;
  if (isFullCrop(rect)) return null;

  // Tilt: each side's edge slope, turned into a clockwise angle. At least
  // two sides must agree (an edge with no dark rim can be misjudged); if
  // they don't, it's not a simple tilt (bowed or bent mount).
  const toDeg = 180 / Math.PI;
  const sign = { left: -1, right: 1, top: 1, bottom: -1 };
  const tilts = edges.filter((e) => e.slope != null).map((e) => sign[e.side] * Math.atan(e.slope) * toDeg);
  let tilt = null;
  if (tilts.length >= 2) {
    const mid = median(tilts);
    const agree = tilts.filter((t) => Math.abs(t - mid) <= 0.5);
    if (agree.length >= 2) tilt = agree.reduce((x, y) => x + y, 0) / agree.length;
  }
  return { rect, tilt };
}

// Where the film starts in from this side ({ film } pixels), and how wide its
// dark rim is ({ rim }, null if it can't be seen). Null if not found.
function filmEdge(img, L, s, span) {
  const { width: w, height: h, data } = img;
  const horiz = s.side === 'left' || s.side === 'right'; // lines are columns
  const len = horiz ? w : h, across = horiz ? h : w;
  const a0 = clamp(Math.floor(across * (horiz ? span.y0 : span.x0)), 0, across - 1);
  const a1 = clamp(Math.ceil(across * (horiz ? span.y1 : span.x1)), a0 + 1, across);
  const n = a1 - a0;
  const maxDepth = Math.floor(len * 0.45);
  const long = Math.max(w, h);
  const idx = (i, a) => {
    const x = horiz ? (s.side === 'left' ? i : w - 1 - i) : a;
    const y = horiz ? a : (s.side === 'top' ? i : h - 1 - i);
    return y * w + x;
  };

  // The side is measured in SEGS sections along its length. Each finds its
  // own edge, so a slightly tilted slide is handled: the crop goes to the
  // innermost one, clearing the film's edge all the way along.
  const SEGS = 3;
  const segOf = (k) => Math.min(SEGS - 1, Math.floor((k * SEGS) / n));
  const segN = Array.from({ length: SEGS }, (_, g) => {
    let c = 0;
    for (let k = 0; k < n; k++) if (segOf(k) === g) c++;
    return c;
  });

  // Per line and section: median brightness, and how much isn't mount
  // (dark film rim, or picture). Lighting often falls off across a scan, so
  // each pixel is compared with the mount just outside it (tracked inwards
  // line by line), not one value for the whole mount.
  const lineL = Array.from({ length: SEGS }, () => new Float32Array(maxDepth));
  const notMount = Array.from({ length: SEGS }, () => new Float32Array(maxDepth));
  const darkFrac = Array.from({ length: SEGS }, () => new Float32Array(maxDepth));
  const vals = Array.from({ length: SEGS }, (_, g) => new Float32Array(segN[g]));
  const mountRef = new Float32Array(n);
  for (let a = a0; a < a1; a++) mountRef[a - a0] = L[idx(0, a)];
  const hr = s.med[0] - s.med[1], hb = s.med[2] - s.med[1];
  const fill = new Int32Array(SEGS), nm = new Int32Array(SEGS), nd = new Int32Array(SEGS);
  for (let i = 0; i < maxDepth; i++) {
    fill.fill(0); nm.fill(0); nd.fill(0);
    for (let a = a0; a < a1; a++) {
      const k = a - a0, g = segOf(k), j = idx(i, a), p = j * 4;
      const l = L[j], m = mountRef[k];
      vals[g][fill[g]++] = l;
      const r = data[p], gr = data[p + 1], bl = data[p + 2];
      const chroma = Math.max(r, gr, bl) - Math.min(r, gr, bl);
      // Strongly coloured writing on the mount can be quite dark; the rim isn't colourful.
      const isDark = l < m * 0.72 && chroma < 70;
      // Mount is near the mount's brightness and hue nearby.
      const isOff = Math.abs(l - m) > Math.max(28, m * 0.15) || Math.max(Math.abs(r - gr - hr), Math.abs(bl - gr - hb)) > 30;
      if (isDark) nd[g]++;
      if (isOff || isDark) nm[g]++;
      else mountRef[k] = m * 0.7 + l * 0.3; // follow slow lighting changes while on the mount
    }
    for (let g = 0; g < SEGS; g++) {
      lineL[g][i] = median(vals[g]);
      notMount[g][i] = nm[g] / segN[g];
      darkFrac[g][i] = nd[g] / segN[g];
    }
  }

  const persist = Math.max(3, Math.ceil(long * 0.015));
  const found = [];
  for (let g = 0; g < SEGS; g++) {
    const e = segmentEdge(notMount[g], darkFrac[g], lineL[g], maxDepth, persist, long);
    // Where along the side this section's middle is (image x or y).
    if (e) found.push({ ...e, at: a0 + ((g + 0.5) * n) / SEGS });
  }
  if (found.length < 2) return null;
  // Sections disagreeing wildly means something other than a straight film
  // edge (e.g. writing reaching into one section): keep the consistent ones.
  const mid = median(found.map((e) => e.out));
  const ok = found.filter((e) => Math.abs(e.out - mid) <= long * 0.03);
  if (ok.length < 2) return null;
  const rims = ok.map((e) => e.rim).filter((r) => r != null);
  // How the edge moves along the side (for straightening), from the outer
  // and inner sections. Needs both ends.
  let slope = null;
  if (ok.length >= 2 && ok[ok.length - 1].at - ok[0].at > n * 0.5) {
    const mx = ok.reduce((t, e) => t + e.at, 0) / ok.length, my = ok.reduce((t, e) => t + e.sub, 0) / ok.length;
    let sxy = 0, sxx = 0;
    for (const e of ok) { sxy += (e.at - mx) * (e.sub - my); sxx += (e.at - mx) ** 2; }
    slope = sxy / sxx;
  }
  return { film: Math.max(...ok.map((e) => e.out)), rim: rims.length ? median(rims) : null, slope };
}

// One section of a side: where the film starts, and its rim width if visible.
function segmentEdge(notMount, darkFrac, lineL, maxDepth, persist, long) {
  // Outer edge of the film: a line of dark rim right across, or where the
  // line stops being mount and stays that way (the picture itself, when it's
  // bright right up to the edge). Writing on the mount isn't dark and only
  // covers part of a few lines, so it is neither.
  let out = -1;
  for (let i = 0; i + persist <= maxDepth; i++) {
    if (darkFrac[i] > 0.75) { out = i; break; }
    if (notMount[i] <= 0.6) continue;
    let sum = 0;
    for (let k = i; k < i + persist; k++) sum += notMount[k];
    if (sum / persist > 0.8) { out = i; break; }
  }
  // Even a sliver of mount beside a picture that nearly fills the scan is
  // some way in; an "edge" right at the border is just picture.
  if (out < Math.max(3, long * 0.006)) return null;
  // The lines outside it must have been mostly mount, not picture.
  let pictureLike = 0;
  for (let i = 0; i < out; i++) if (notMount[i] > 0.75) pictureLike++;
  if (pictureLike > out * 0.15) return null;

  // The dark rim: find its darkest line, then where brightness recovers.
  let lo = out;
  for (let i = out; i < Math.min(maxDepth, out + Math.ceil(long * 0.015)); i++) if (lineL[i] < lineL[lo]) lo = i;
  const r0 = Math.min(maxDepth - 1, lo + Math.ceil(long * 0.012));
  const r1 = Math.min(maxDepth, lo + Math.ceil(long * 0.03));
  const ref = r1 > r0 ? median(lineL.subarray(r0, r1)) : lineL[lo];
  let rim = null;
  if (ref - lineL[lo] > 25) {
    const half = lineL[lo] + (ref - lineL[lo]) * 0.6;
    let inner = lo;
    while (inner < r0 && lineL[inner] < half) inner++;
    rim = inner - out;
  }
  // Sub-pixel edge position: where the line crosses half "not mount".
  const prev = notMount[out - 1], cur = Math.max(notMount[out], darkFrac[out]);
  const sub = cur > prev ? out - 1 + clamp((0.5 - prev) / (cur - prev), 0, 1) : out;
  return { out, rim, sub };
}

// Rotate an image by angle degrees clockwise about its centre (edges are
// extended to fill the corners), then cut out a crop rectangle of the result.
// Done in one go so a full-size scan is only resampled once.
export function transform(img, angle, crop) {
  if (!angle) return cropImage(img, crop);
  const { width: W, height: H, data } = img;
  const c = isFullCrop(crop) ? FULL_CROP : crop;
  const ox = Math.round(c.x0 * W), oy = Math.round(c.y0 * H);
  const cw = Math.max(1, Math.round(c.x1 * W) - ox), ch = Math.max(1, Math.round(c.y1 * H) - oy);
  const out = new Uint8ClampedArray(cw * ch * 4);
  const a = (angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const cx = (W - 1) / 2, cy = (H - 1) / 2;
  for (let v = 0; v < ch; v++) {
    const dy = oy + v - cy;
    // Source position for the start of the row, then step along it.
    let sx = cx + (ox - cx) * cos + dy * sin;
    let sy = cy - (ox - cx) * sin + dy * cos;
    for (let u = 0, o = v * cw * 4; u < cw; u++, o += 4, sx += cos, sy -= sin) {
      const x = sx < 0 ? 0 : sx > W - 1 ? W - 1 : sx;
      const y = sy < 0 ? 0 : sy > H - 1 ? H - 1 : sy;
      const x0 = x | 0, y0 = y | 0;
      const x1 = x0 < W - 1 ? x0 + 1 : x0, y1 = y0 < H - 1 ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const p00 = (y0 * W + x0) * 4, p01 = (y0 * W + x1) * 4, p10 = (y1 * W + x0) * 4, p11 = (y1 * W + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      out[o] = data[p00] * w00 + data[p01] * w01 + data[p10] * w10 + data[p11] * w11;
      out[o + 1] = data[p00 + 1] * w00 + data[p01 + 1] * w01 + data[p10 + 1] * w10 + data[p11 + 1] * w11;
      out[o + 2] = data[p00 + 2] * w00 + data[p01 + 2] * w01 + data[p10 + 2] * w10 + data[p11 + 2] * w11;
      out[o + 3] = 255;
    }
  }
  return { width: cw, height: ch, data: out };
}

// Box-filtered copy no larger than max on its long side.
function shrink(img, max) {
  const { width: W, height: H, data } = img;
  const s = max / Math.max(W, H);
  if (s >= 1) return img;
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / s), y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) / s)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / s), x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) / s)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0, p = (yy * W + x0) * 4; xx < x1; xx++, p += 4) {
        r += data[p]; g += data[p + 1]; b += data[p + 2]; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

function stripPixels(img, side, strip) {
  const { width: w, height: h, data } = img;
  const px = [];
  const step = Math.max(1, Math.floor(Math.max(w, h) / 400));
  const lenAlong = side === 'left' || side === 'right' ? h : w;
  for (let a = 0; a < lenAlong; a += step) {
    // Average across the strip's width: one sample per position along it.
    const acc = [0, 0, 0];
    for (let i = 0; i < strip; i++) {
      const x = side === 'left' ? i : side === 'right' ? w - 1 - i : a;
      const y = side === 'top' ? i : side === 'bottom' ? h - 1 - i : a;
      const p = (y * w + x) * 4;
      acc[0] += data[p]; acc[1] += data[p + 1]; acc[2] += data[p + 2];
    }
    px.push(acc.map((v) => v / strip));
  }
  return px;
}

const luma = (p) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

function lumaPlane({ width, height, data }) {
  const L = new Float32Array(width * height);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) L[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return L;
}

const dist = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

function median(arr) {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : 0;
}

// Cut a crop rectangle out of an image. Returns the same image for no crop.
export function cropImage(img, c) {
  if (!c || (c.x0 <= 0.001 && c.y0 <= 0.001 && c.x1 >= 0.999 && c.y1 >= 0.999)) return img;
  const { width: w, height: h, data } = img;
  const x0 = clamp(Math.round(c.x0 * w), 0, w - 1), x1 = clamp(Math.round(c.x1 * w), x0 + 1, w);
  const y0 = clamp(Math.round(c.y0 * h), 0, h - 1), y1 = clamp(Math.round(c.y1 * h), y0 + 1, h);
  const cw = x1 - x0, ch = y1 - y0;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const s = ((y0 + y) * w + x0) * 4;
    out.set(data.subarray(s, s + cw * 4), y * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

// Crop rectangle as seen after rotating the photo by quarter turns clockwise
// (and back again with -q).
export function rotateCrop(c, quarterTurns) {
  let r = { ...c };
  const q = ((quarterTurns % 4) + 4) % 4;
  for (let i = 0; i < q; i++) r = { x0: 1 - r.y1, y0: r.x0, x1: 1 - r.y0, y1: r.x1, angle: c.angle };
  if (!r.angle) delete r.angle;
  return r;
}
