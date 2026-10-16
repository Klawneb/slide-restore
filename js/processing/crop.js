// Finds the picture inside a scanned slide mount and crops off the border.
//
// Scans of slides usually show the cardboard/plastic mount round the edge:
// a fairly even colour, then the dark rim of the film, then the picture.
// Working inwards from each side we skip the mount, then the rim.
//
// Crop rectangles are fractions of the image: { x0, y0, x1, y1 } in 0..1.

import { clamp } from './color.js';

export const FULL_CROP = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 });

export function isFullCrop(c) {
  return !c || (c.x0 <= 0.001 && c.y0 <= 0.001 && c.x1 >= 0.999 && c.y1 >= 0.999);
}

// Returns a crop rectangle, or null when there is no mount to remove.
export function detectCrop(img) {
  const { width: w, height: h } = img;
  if (w < 32 || h < 32) return null;
  const strip = Math.max(2, Math.round(Math.min(w, h) * 0.012));

  // Each side's outer strip: a mount is an even colour there.
  const sides = ['left', 'right', 'top', 'bottom'].map((side) => {
    const px = stripPixels(img, side, strip);
    const med = [0, 1, 2].map((c) => median(px.map((p) => p[c])));
    const d = px.map((p) => dist(p, med)).sort((a, b) => a - b);
    const d80 = d[Math.floor(d.length * 0.8)];
    return { side, med, uniform: d80 < 18, tol: Math.max(24, d80 * 2.5) };
  });

  // The sides showing the mount must agree on its colour (one mount), so a
  // plain sky reaching one edge of a borderless scan isn't mistaken for it.
  let mount = sides.filter((s) => s.uniform);
  if (mount.length < 2) return null;
  const consensus = [0, 1, 2].map((c) => median(mount.map((s) => s.med[c])));
  mount = mount.filter((s) => dist(s.med, consensus) < 40);
  if (mount.length < 2) return null;

  const L = lumaPlane(img);
  const edges = mount.map((s) => ({ side: s.side, ...(filmEdge(img, L, s) ?? {}) })).filter((e) => e.film != null);
  if (!edges.length) return null;

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
  if (rect.x1 - rect.x0 < 0.4 || rect.y1 - rect.y0 < 0.4) return null;
  if (isFullCrop(rect)) return null;
  return rect;
}

// Where the film starts in from this side ({ film } pixels), and how wide its
// dark rim is ({ rim }, null if it can't be seen). Null if no border.
function filmEdge(img, L, s) {
  const { width: w, height: h, data } = img;
  const horiz = s.side === 'left' || s.side === 'right'; // lines are columns
  const len = horiz ? w : h, across = horiz ? h : w;
  const a0 = Math.floor(across * 0.2), a1 = Math.ceil(across * 0.8);
  const maxDepth = Math.floor(len * 0.35);
  const idx = (i, a) => {
    const x = horiz ? (s.side === 'left' ? i : w - 1 - i) : a;
    const y = horiz ? a : (s.side === 'top' ? i : h - 1 - i);
    return y * w + x;
  };

  // Fraction of each line that isn't mount colour, and its median brightness.
  const frac = new Float32Array(maxDepth), lineL = new Float32Array(maxDepth);
  const vals = new Float32Array(a1 - a0);
  for (let i = 0; i < maxDepth; i++) {
    let off = 0;
    for (let a = a0; a < a1; a++) {
      const j = idx(i, a), p = j * 4;
      const d = Math.max(Math.abs(data[p] - s.med[0]), Math.abs(data[p + 1] - s.med[1]), Math.abs(data[p + 2] - s.med[2]));
      if (d > s.tol) off++;
      vals[a - a0] = L[j];
    }
    frac[i] = off / (a1 - a0);
    lineL[i] = median(vals);
  }

  // Outer edge of the film: where most of the line stops being mount.
  let out = -1;
  for (let i = 0; i < maxDepth; i++) if (frac[i] > 0.5) { out = i; break; }
  if (out < 0) return null;
  if (out < 2) return null; // no real border on this side
  // A tilted slide reaches the mount colour a little further in at one end.
  let full = out;
  const tiltMax = Math.min(maxDepth - 1, out + Math.ceil(len * 0.03));
  while (full < tiltMax && frac[full] < 0.97) full++;
  if (frac[full] < 0.97) full = out;

  // The dark rim: find its darkest line, then where brightness recovers.
  const long = Math.max(w, h);
  let lo = full;
  for (let i = full; i < Math.min(maxDepth, full + Math.ceil(long * 0.02)); i++) if (lineL[i] < lineL[lo]) lo = i;
  const r0 = Math.min(maxDepth - 1, lo + Math.ceil(long * 0.012));
  const r1 = Math.min(maxDepth, lo + Math.ceil(long * 0.03));
  const ref = r1 > r0 ? median(lineL.subarray(r0, r1)) : lineL[lo];
  let rim = null;
  if (ref - lineL[lo] > 25) {
    const half = lineL[lo] + (ref - lineL[lo]) * 0.6;
    let inner = lo;
    while (inner < r0 && lineL[inner] < half) inner++;
    rim = inner - full;
  }
  return { film: full, rim };
}

function stripPixels(img, side, strip) {
  const { width: w, height: h, data } = img;
  const px = [];
  const stepA = Math.max(1, Math.floor(Math.max(w, h) / 400));
  const add = (x, y) => { const p = (y * w + x) * 4; px.push([data[p], data[p + 1], data[p + 2]]); };
  for (let i = 0; i < strip; i++) {
    if (side === 'left' || side === 'right') {
      const x = side === 'left' ? i : w - 1 - i;
      for (let y = 0; y < h; y += stepA) add(x, y);
    } else {
      const y = side === 'top' ? i : h - 1 - i;
      for (let x = 0; x < w; x += stepA) add(x, y);
    }
  }
  return px;
}

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
  if (isFullCrop(c)) return img;
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
  for (let i = 0; i < q; i++) r = { x0: 1 - r.y1, y0: r.x0, x1: 1 - r.y0, y1: r.x1 };
  return r;
}
