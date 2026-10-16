// Applies restoration parameters to an image.
//
// `auto` comes from analyze(); `adj` holds the user's slider offsets
// (-100..100 each). Sliders nudge the auto values rather than replace them.

import { clamp } from './color.js';

export const NEUTRAL_AUTO = Object.freeze({
  black: [0, 0, 0],
  white: [255, 255, 255],
  gamma: [1, 1, 1],
  bright: 1,
  lumaLo: 0,
  lumaHi: 1,
  curve: 0,
  vibrance: 0,
  sharpAmount: 0,
  sharpRadius: 0, // fraction of the image's long side
  sharpThreshold: 4,
});

export const ZERO_ADJ = Object.freeze({
  brightness: 0, contrast: 0, warmth: 0, tint: 0, saturation: 0, sharpness: 0,
});

// Merge auto parameters with slider offsets into the values render() uses.
export function resolveParams(auto, adj = ZERO_ADJ) {
  const a = { ...ZERO_ADJ, ...adj };
  const w = a.warmth / 100, t = a.tint / 100;
  // Per-channel gamma keeps black and white fixed while shifting mid-tones,
  // so warmth/tint never clip highlights.
  const gamma = [
    auto.gamma[0] * Math.pow(2, -w * 0.35),
    auto.gamma[1] * Math.pow(2, t * 0.35),
    auto.gamma[2] * Math.pow(2, w * 0.35),
  ];
  const sharpAmount = a.sharpness >= 0
    ? auto.sharpAmount + (a.sharpness / 100) * 1.5
    : auto.sharpAmount * (1 + a.sharpness / 100);
  return {
    black: auto.black,
    white: auto.white,
    gamma,
    bright: auto.bright * Math.pow(2, -(a.brightness / 100) * 0.9),
    lumaLo: auto.lumaLo,
    lumaHi: auto.lumaHi,
    curve: clamp(auto.curve + (a.contrast / 100) * 0.7, -0.7, 0.9),
    vibrance: auto.vibrance,
    saturation: 1 + a.saturation / 100,
    sharpAmount: Math.max(0, sharpAmount),
    sharpRadius: auto.sharpRadius,
    sharpThreshold: auto.sharpThreshold,
  };
}

function contrastCurve(x, s) {
  if (s >= 0) return (1 - s) * x + s * x * x * (3 - 2 * x);
  return 0.5 + (x - 0.5) * (1 + s * 0.7);
}

// One lookup table per channel: levels → channel gamma → brightness →
// luma stretch → contrast curve. Output is 0..1.
export function buildLuts(p) {
  const luts = [new Float32Array(256), new Float32Array(256), new Float32Array(256)];
  const span = Math.max(1e-3, p.lumaHi - p.lumaLo);
  for (let c = 0; c < 3; c++) {
    const lo = p.black[c], range = Math.max(1, p.white[c] - lo);
    const g = p.gamma[c] * p.bright;
    for (let i = 0; i < 256; i++) {
      let x = clamp((i - lo) / range, 0, 1);
      x = Math.pow(x, g);
      x = clamp((x - p.lumaLo) / span, 0, 1);
      luts[c][i] = clamp(contrastCurve(x, p.curve ?? 0), 0, 1);
    }
  }
  return luts;
}

// Colour stage only (LUTs + vibrance/saturation). Returns a new image.
export function applyColor(img, p) {
  const [lr, lg, lb] = buildLuts(p);
  const src = img.data, n = src.length;
  const out = new Uint8ClampedArray(n);
  const vib = p.vibrance ?? 0, sat = p.saturation ?? 1;
  const doSat = vib !== 0 || sat !== 1;
  for (let i = 0; i < n; i += 4) {
    let r = lr[src[i]], g = lg[src[i + 1]], b = lb[src[i + 2]];
    if (doSat) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      // Vibrance boosts dull colours more than already-vivid ones.
      const f = sat * (1 + vib * (1 - (mx - mn)));
      r = l + (r - l) * f; g = l + (g - l) * f; b = l + (b - l) * f;
    }
    out[i] = r * 255 + 0.5;
    out[i + 1] = g * 255 + 0.5;
    out[i + 2] = b * 255 + 0.5;
    out[i + 3] = src[i + 3];
  }
  return { width: img.width, height: img.height, data: out };
}

export function gaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

// Unsharp mask on brightness only (no colour fringes), modifies img in place.
// Works in horizontal bands so memory stays small on big scans.
export function sharpenInPlace(img, amount, sigma, threshold) {
  if (amount <= 0.001) return img;
  const { width: w, height: h, data } = img;
  const L = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) {
    L[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] + 0.5;
  }
  const k = gaussianKernel(sigma), r = (k.length - 1) >> 1;
  const BAND = 128;
  const t0 = threshold * 0.5, t1 = threshold * 1.5;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const y1 = Math.min(h, y0 + BAND);
    const ey0 = Math.max(0, y0 - r), ey1 = Math.min(h, y1 + r);
    const rows = ey1 - ey0;
    const T = new Float32Array(w * rows);
    // Horizontal pass for band + margins.
    for (let y = 0; y < rows; y++) {
      const base = (ey0 + y) * w, tb = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
          s += L[base + xx] * k[i + r];
        }
        T[tb + x] = s;
      }
    }
    // Vertical pass + apply.
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) {
          let yy = y + i;
          yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
          s += T[(yy - ey0) * w + x] * k[i + r];
        }
        const idx = y * w + x;
        const d = L[idx] - s;
        const ad = d < 0 ? -d : d;
        if (ad <= t0) continue;
        let wt = 1;
        if (ad < t1) { const u = (ad - t0) / (t1 - t0); wt = u * u * (3 - 2 * u); }
        let delta = amount * d * wt;
        delta = delta > 40 ? 40 : delta < -40 ? -40 : delta;
        const p = idx * 4;
        data[p] += delta; data[p + 1] += delta; data[p + 2] += delta;
      }
    }
  }
  return img;
}

// Rotate by quarter turns clockwise. Returns a new image (or the same one for 0).
export function rotate(img, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (q === 0) return img;
  const { width: w, height: h, data } = img;
  const nw = q === 2 ? w : h, nh = q === 2 ? h : w;
  const src32 = new Uint32Array(data.buffer, data.byteOffset, w * h);
  const out = new Uint8ClampedArray(w * h * 4);
  const dst32 = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      if (q === 1) { nx = h - 1 - y; ny = x; }
      else if (q === 2) { nx = w - 1 - x; ny = h - 1 - y; }
      else { nx = y; ny = w - 1 - x; }
      dst32[ny * nw + nx] = src32[y * w + x];
    }
  }
  return { width: nw, height: nh, data: out };
}

// Full pipeline: colour → sharpen → rotate.
export function render(img, auto, adj, quarterTurns = 0) {
  const p = resolveParams(auto, adj);
  const out = applyColor(img, p);
  const longSide = Math.max(img.width, img.height);
  const sigma = clamp(p.sharpRadius * longSide, 0.6, 4);
  sharpenInPlace(out, p.sharpAmount, sigma, p.sharpThreshold);
  return rotate(out, quarterTurns);
}
