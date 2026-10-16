// Works out the "Auto Fix" settings for a photo.
//
// `img` is a downscaled copy (~1024px) used for colour and tone. `crop` is an
// optional full-resolution centre crop used to judge blur and grain at the
// photo's real pixel size. Both are { width, height, data } RGBA images.

import { clamp, histograms, percentile, rgbToLab } from './color.js';
import { NEUTRAL_AUTO, buildLuts, applyColor, gaussianKernel } from './render.js';

const TARGET_MEDIAN = 0.46;

export function analyze(img, crop = null, fullLongSide = null) {
  const npx = img.width * img.height;
  const step = Math.max(1, Math.floor(npx / 400000));
  const p = cloneAuto(NEUTRAL_AUTO);

  // 1. Per-channel levels: removes fading and most of any uniform colour cast.
  const h = histograms(img, step);
  ['r', 'g', 'b'].forEach((ch, c) => {
    let lo = percentile(h[ch], 0.005);
    let hi = percentile(h[ch], 0.995);
    if (hi - lo < 48) { // nearly flat channel: don't blow up its noise
      const mid = (hi + lo) / 2;
      lo = Math.max(0, mid - 24); hi = Math.min(255, mid + 24);
    }
    p.black[c] = lo; p.white[c] = hi;
  });
  // A channel needing a huge stretch (e.g. almost no blue in a sunset) is more
  // likely real scene colour than fading, so pull it towards the shared range.
  {
    const lo = Math.min(...p.black), hi = Math.max(...p.white);
    for (let c = 0; c < 3; c++) {
      const ratio = (hi - lo) / (p.white[c] - p.black[c]);
      const k = clamp(1 - (ratio - 1.8) / 3.4, 0.5, 1);
      p.black[c] = lo + (p.black[c] - lo) * k;
      p.white[c] = hi + (p.white[c] - hi) * k;
    }
  }

  // 2. Neutralise mid-tones: the greyish mid-brightness pixels should be grey.
  {
    const [lr, lg, lb] = buildLuts(p);
    let sr = 0, sg = 0, sb = 0, sw = 0;
    const d = img.data;
    for (let i = 0; i < d.length; i += 4 * step) {
      const r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      if (l < 0.18 || l > 0.88) continue;
      const s = Math.max(r, g, b) - Math.min(r, g, b);
      const wgt = 1 / (1 + (s / 0.1) * (s / 0.1));
      sr += r * wgt; sg += g * wgt; sb += b * wgt; sw += wgt;
    }
    if (sw > 0) {
      const m = [sr / sw, sg / sw, sb / sw];
      const [, A, B] = rgbToLab(m[0], m[1], m[2]);
      const chroma = Math.hypot(A, B);
      // Strong remaining casts may be genuine (sunsets, lamplight): correct less.
      const strength = chroma <= 12 ? 1 : clamp(1 - (chroma - 12) / 40, 0.4, 1);
      const target = (m[0] + m[1] + m[2]) / 3;
      for (let c = 0; c < 3; c++) {
        if (m[c] <= 0.01 || m[c] >= 0.99) continue;
        const g = Math.log(target) / Math.log(m[c]);
        p.gamma[c] = clamp(1 + (g - 1) * strength, 0.5, 2);
      }
    }
  }

  // 3. Brightness: move the median brightness towards a pleasant mid-tone.
  {
    const median = percentile(lumaHist(img, p, step), 0.5) / 255;
    if (median > 0.02 && median < 0.98) {
      const g = Math.log(TARGET_MEDIAN) / Math.log(median);
      p.bright = clamp(Math.pow(g, 0.8), 0.5, 1.8);
    }
  }

  // 4. Contrast: stretch brightness range, then S-curve if still flat.
  {
    const lh = lumaHist(img, p, step);
    const lo = percentile(lh, 0.01) / 255, hi = percentile(lh, 0.99) / 255;
    p.lumaLo = clamp(lo, 0, 0.25);
    p.lumaHi = clamp(hi, 0.75, 1);
    const std = histStd(lumaHist(img, p, step)) / 255;
    p.curve = clamp((0.21 - std) * 3.5, 0, 0.5);
  }

  // 5. Saturation: faded slides lose colour; boost dull colours.
  {
    const c = applyColor(img, p).data;
    let sum = 0, n = 0;
    for (let i = 0; i < c.length; i += 4 * step) {
      sum += Math.max(c[i], c[i + 1], c[i + 2]) - Math.min(c[i], c[i + 1], c[i + 2]);
      n++;
    }
    const meanSat = sum / n / 255;
    p.vibrance = clamp((0.2 - meanSat) * 2.5, 0, 0.6);
  }

  // 6. Sharpening, judged at real resolution where possible.
  {
    const src = crop ?? img;
    const L = lumaPlane(applyColor(src, p));
    const blurriness = reblurRatio(L, src.width, src.height); // ~0.15 crisp … ~0.7+ blurry
    const noise = noiseSigma(L, src.width, src.height);
    const u = clamp((blurriness - 0.25) / 0.45, 0, 1);
    p.sharpAmount = 0.35 + u * 1.25;
    const sigmaPx = 1 + u * 2;
    const long = fullLongSide ?? Math.max(img.width, img.height);
    p.sharpRadius = sigmaPx / long;
    p.sharpThreshold = clamp(noise * 2.5, 2, 16);
  }

  return p;
}

function cloneAuto(a) {
  return { ...a, black: [...a.black], white: [...a.white], gamma: [...a.gamma] };
}

function lumaHist(img, p, step) {
  const [lr, lg, lb] = buildLuts(p);
  const hist = new Uint32Array(256);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4 * step) {
    const l = 0.299 * lr[d[i]] + 0.587 * lg[d[i + 1]] + 0.114 * lb[d[i + 2]];
    hist[Math.round(l * 255)]++;
  }
  return hist;
}

function histStd(hist) {
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < 256; i++) { n += hist[i]; s += i * hist[i]; s2 += i * i * hist[i]; }
  const mean = s / n;
  return Math.sqrt(Math.max(0, s2 / n - mean * mean));
}

export function lumaPlane(img) {
  const { data } = img;
  const L = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; j < L.length; i += 4, j++) {
    L[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return L;
}

function blurPlane(L, w, h, sigma) {
  const k = gaussianKernel(sigma), r = (k.length - 1) >> 1;
  const T = new Float32Array(L.length), O = new Float32Array(L.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += L[y * w + clamp(x + i, 0, w - 1)] * k[i + r];
    T[y * w + x] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += T[clamp(y + i, 0, h - 1) * w + x] * k[i + r];
    O[y * w + x] = s;
  }
  return O;
}

function gradientEnergy(L, w, h) {
  let e = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    const dx = L[i + 1] - L[i], dy = L[i + w] - L[i];
    e += dx * dx + dy * dy;
  }
  return e;
}

// How much detail survives a further blur: close to 1 means already blurry.
export function reblurRatio(L, w, h) {
  const e0 = gradientEnergy(L, w, h);
  if (e0 < 1e-6) return 1;
  return gradientEnergy(blurPlane(L, w, h, 1.5), w, h) / e0;
}

// Immerkær's fast noise estimate (std dev in 0..255 units).
export function noiseSigma(L, w, h) {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = L[i - w - 1] - 2 * L[i - w] + L[i - w + 1]
      - 2 * L[i - 1] + 4 * L[i] - 2 * L[i + 1]
      + L[i + w - 1] - 2 * L[i + w] + L[i + w + 1];
    sum += Math.abs(v);
  }
  return sum * Math.sqrt(Math.PI / 2) / (6 * (w - 2) * (h - 2));
}
