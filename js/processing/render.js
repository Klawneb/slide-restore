// Applies restoration parameters to an image.
//
// `auto` comes from analyze(); `adj` holds the user's slider offsets
// (-100..100 each). Sliders nudge the auto values rather than replace them.

import { clamp } from './color.js';
import { removeDustInPlace } from './dust.js';

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
  chromaRadius: 0, // fraction of the image's long side; 0 = no colour smoothing
  shadowTint: null, // [r, g, b] added to shadows, fading out by mid-grey
  shadowCalm: 0, // 0..1: less colour in near-black areas
  dust: false, // remove dust specks
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
    chromaRadius: auto.chromaRadius ?? 0,
    shadowTint: auto.shadowTint ?? null,
    shadowCalm: auto.shadowCalm ?? 0,
    dust: !!auto.dust,
  };
}

// Gamma with a linear toe below TOE: plain gamma < 1 has unlimited gain at
// black, which turns shadow grain and JPEG blocks into blotches.
const TOE = 0.12;
function toneCurve(x, g) {
  if (g >= 1 || x >= TOE) return Math.pow(x, g);
  return x * Math.pow(TOE, g - 1);
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
      x = toneCurve(x, g);
      x = clamp((x - p.lumaLo) / span, 0, 1);
      luts[c][i] = clamp(contrastCurve(x, p.curve ?? 0), 0, 1);
    }
  }
  return luts;
}

const CLIP0 = 235;
const clipWeight = (v) => {
  if (v <= CLIP0) return 0;
  const u = (v - CLIP0) / (255 - CLIP0);
  return u * u * (3 - 2 * u);
};

// Colour stage only (LUTs + vibrance/saturation). Returns a new image.
export function applyColor(img, p) {
  const [lr, lg, lb] = buildLuts(p);
  const src = img.data, n = src.length;
  const out = new Uint8ClampedArray(n);
  const vib = p.vibrance ?? 0, sat = p.saturation ?? 1;
  const doSat = vib !== 0 || sat !== 1;
  const st = p.shadowTint, calm = p.shadowCalm ?? 0;
  for (let i = 0; i < n; i += 4) {
    let r = lr[src[i]], g = lg[src[i + 1]], b = lb[src[i + 2]];
    // A channel the scanner clipped is really "at least this bright", so let
    // it rise with the brightest channel rather than tint highlights.
    if (src[i] > CLIP0 || src[i + 1] > CLIP0 || src[i + 2] > CLIP0) {
      const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      r += (mx - r) * clipWeight(src[i]);
      g += (mx - g) * clipWeight(src[i + 1]);
      b += (mx - b) * clipWeight(src[i + 2]);
    }
    if (st) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      const wt = l >= 0.5 ? 0 : (1 - l * 2) * (1 - l * 2);
      r += st[0] * wt; g += st[1] * wt; b += st[2] * wt;
    }
    if (calm > 0) {
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < 0.3) {
        const u = l / 0.3, k = 1 - calm * (1 - u * u * (3 - 2 * u));
        r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k;
      }
    }
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

// Separable Gaussian blur of whole planes, delivered in horizontal bands so
// memory stays small on big scans: visit(y0, y1, blurred) receives rows
// y0..y1-1 of each plane, blurred.
function blurBands(planes, w, h, sigma, visit) {
  const k = gaussianKernel(sigma), r = (k.length - 1) >> 1;
  const BAND = 128;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const y1 = Math.min(h, y0 + BAND);
    const ey0 = Math.max(0, y0 - r), ey1 = Math.min(h, y1 + r);
    const blurred = planes.map((P) => {
      const T = new Float32Array(w * (ey1 - ey0));
      for (let y = ey0; y < ey1; y++) {
        const base = y * w, tb = (y - ey0) * w;
        for (let x = 0; x < w; x++) {
          let s = 0;
          if (x >= r && x < w - r) { // interior: no edge checks
            for (let i = 0, o = base + x - r; i < k.length; i++) s += P[o + i] * k[i];
          } else {
            for (let i = -r; i <= r; i++) {
              const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
              s += P[base + xx] * k[i + r];
            }
          }
          T[tb + x] = s;
        }
      }
      const O = new Float32Array(w * (y1 - y0));
      for (let y = y0; y < y1; y++) {
        const ob = (y - y0) * w;
        for (let i = -r; i <= r; i++) { // accumulate whole rows: cache friendly
          const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
          const tb = (yy - ey0) * w, kv = k[i + r];
          for (let x = 0; x < w; x++) O[ob + x] += T[tb + x] * kv;
        }
      }
      return O;
    });
    visit(y0, y1, blurred);
  }
}

const smoothstep = (a, b, x) => {
  const u = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return u * u * (3 - 2 * u);
};

// Blurs only the colour (not brightness) to remove colour speckle from film
// grain and JPEG compression. Detail lives in brightness, so it stays sharp.
// Colour is smoothed at half resolution (as JPEG stores it) for speed.
export function smoothChromaInPlace(img, sigma) {
  if (sigma < 0.3) return img;
  const { width: w, height: h, data } = img;
  const hw = (w + 1) >> 1, hh = (h + 1) >> 1;
  const Cb = new Float32Array(hw * hh), Cr = new Float32Array(hw * hh);
  for (let y = 0; y < h; y++) {
    const hy = (y >> 1) * hw;
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      Cb[hy + (x >> 1)] += data[p + 2] - l;
      Cr[hy + (x >> 1)] += data[p] - l;
    }
  }
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const n = (Math.min(2, h - 2 * y)) * (Math.min(2, w - 2 * x));
    Cb[y * hw + x] /= n; Cr[y * hw + x] /= n;
  }
  const SB = new Float32Array(hw * hh), SR = new Float32Array(hw * hh);
  blurBands([Cb, Cr], hw, hh, sigma / 2, (y0, y1, [B, R]) => {
    SB.set(B, y0 * hw); SR.set(R, y0 * hw);
  });
  // Bilinear upsample and recombine with the untouched brightness.
  for (let y = 0; y < h; y++) {
    const fy = Math.min(hh - 1, Math.max(0, (y - 0.5) / 2));
    const y0 = Math.floor(fy), y1 = Math.min(hh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(hw - 1, Math.max(0, (x - 0.5) / 2));
      const x0 = Math.floor(fx), x1 = Math.min(hw - 1, x0 + 1), tx = fx - x0;
      const a = y0 * hw + x0, b = y0 * hw + x1, c = y1 * hw + x0, d = y1 * hw + x1;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      const cb = SB[a] * w00 + SB[b] * w01 + SB[c] * w10 + SB[d] * w11;
      const cr = SR[a] * w00 + SR[b] * w01 + SR[c] * w10 + SR[d] * w11;
      const p = (y * w + x) * 4;
      const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      const r = l + cr, bl = l + cb;
      data[p] = r;
      data[p + 1] = (l - 0.299 * r - 0.114 * bl) / 0.587;
      data[p + 2] = bl;
    }
  }
  return img;
}

// Unsharp mask on brightness only (no colour fringes), modifies img in place.
// Small differences (grain, JPEG noise) and deep shadows are left alone, and
// the boost is capped to avoid halos round high-contrast edges.
export function sharpenInPlace(img, amount, sigma, threshold) {
  if (amount <= 0.001) return img;
  const { width: w, height: h, data } = img;
  const L = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) {
    L[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] + 0.5;
  }
  const t0 = threshold * 0.5, t1 = threshold * 1.5;
  blurBands([L], w, h, sigma, (y0, y1, [S]) => {
    for (let j = y0 * w, b = 0; j < y1 * w; j++, b++) {
      const d = L[j] - S[b];
      const ad = d < 0 ? -d : d;
      if (ad <= t0) continue;
      const wt = smoothstep(t0, t1, ad) * smoothstep(10, 45, L[j]);
      let delta = amount * d * wt;
      delta = delta > 24 ? 24 : delta < -24 ? -24 : delta;
      const p = j * 4;
      data[p] += delta; data[p + 1] += delta; data[p + 2] += delta;
    }
  });
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

// Largest dust speck removed, as a fraction of the photo's long side.
const DUST_SIZE = 0.003;

// Full pipeline: colour → dust → colour smoothing → sharpen → rotate.
// longSide: the long side of the whole photo when img is only part of it
// (zoomed-in detail), so sizes like the sharpening radius match.
export function render(img, auto, adj, quarterTurns = 0, longSide = Math.max(img.width, img.height)) {
  const p = resolveParams(auto, adj);
  const out = applyColor(img, p);
  // Before sharpening, which would make specks stand out more.
  if (p.dust) removeDustInPlace(out, Math.max(1.5, DUST_SIZE * longSide));
  smoothChromaInPlace(out, Math.min(4, p.chromaRadius * longSide));
  const sigma = clamp(p.sharpRadius * longSide, 0.6, 4);
  sharpenInPlace(out, p.sharpAmount, sigma, p.sharpThreshold);
  return rotate(out, quarterTurns);
}
