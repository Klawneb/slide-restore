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
  // Black points far apart usually mean the darkest things are coloured
  // (brown wood, deep blue sea) rather than tinted black: forcing them to
  // neutral strips one colour out of every shadow.
  {
    const lo = Math.min(...p.black);
    for (let c = 0; c < 3; c++) {
      const spread = p.black[c] - lo;
      if (spread > 30) p.black[c] = lo + 30 + (spread - 30) * 0.35;
    }
  }

  // 1b. Neutralise highlights: bright greyish areas (sand, clouds, walls)
  // carry a cast that mid-tone gamma barely touches, so adjust white points.
  {
    const m = greyishMean(img, p, step, 0.6, 0.97);
    if (m) {
      const [, A, B] = rgbToLab(m[0], m[1], m[2]);
      const strength = castStrength(Math.hypot(A, B));
      const target = (m[0] + m[1] + m[2]) / 3;
      const gains = m.map((v) => 1 + (target / v - 1) * strength);
      // Only ever boost the weaker channels: dimming the strongest one would
      // stop it reaching full brightness and tint every highlight.
      const minGain = Math.min(...gains);
      for (let c = 0; c < 3; c++) {
        const gain = clamp(gains[c] / minGain, 1, 1.3);
        p.white[c] = p.black[c] + (p.white[c] - p.black[c]) / gain;
      }
    }
  }

  // 2. Neutralise mid-tones: the greyish mid-brightness pixels should be grey.
  {
    const m = greyishMean(img, p, step, 0.18, 0.88);
    if (m) {
      const [, A, B] = rgbToLab(m[0], m[1], m[2]);
      const strength = castStrength(Math.hypot(A, B));
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
      // Gentle: high-contrast scenes (deep shadows, bright sky) shouldn't be
      // forced to mid-grey, and lifting shadows hard exposes grain.
      const g = Math.log(TARGET_MEDIAN) / Math.log(median);
      p.bright = clamp(Math.pow(g, 0.6), 0.72, 1.5);
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

  // 4b. Shadows pushed past neutral. Removing a strong warm cast (lamplight
  // indoors) leaves the parts lit by daylight from a window blue-purple,
  // and the brightness and contrast steps magnify it. Pull such shadows
  // back to grey; shadows that keep the original cast (sunsets) are left be.
  {
    const orig = greyishMean(img, NEUTRAL_AUTO, step, 0.05, 0.95);
    const m = greyishMean(img, p, step, 0.04, 0.35);
    if (orig && m) {
      const [, a0, b0] = rgbToLab(orig[0], orig[1], orig[2]);
      const [, a1, b1] = rgbToLab(m[0], m[1], m[2]);
      const len0 = Math.hypot(a0, b0), len1 = Math.hypot(a1, b1);
      const opposed = len0 > 1 && len1 > 1 ? -(a0 * a1 + b0 * b1) / (len0 * len1) : 0;
      if (opposed > 0) {
        const t = (m[0] + m[1] + m[2]) / 3;
        // Shadow weights in render average about 0.6 over this range.
        p.shadowTint = m.map((v) => clamp(((t - v) * opposed) / 0.6, -0.08, 0.08));
      }
      // Near-black areas: an offset would grey the blacks, so instead calm
      // their colour when it has swung against the original cast.
      const deep = darkMean(img, p, step, 0.12);
      if (deep && len0 > 1) {
        const [, a2, b2] = rgbToLab(deep[0], deep[1], deep[2]);
        const len2 = Math.hypot(a2, b2);
        const against = len2 > 1 ? -(a0 * a2 + b0 * b2) / (len0 * len2) : 0;
        if (against > 0) p.shadowCalm = clamp((len2 / 12) * against, 0, 0.8);
      }
    }
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
    // Grainy or heavily compressed scans get less sharpening, not more noise.
    const calm = clamp(1 - (noise - 2) / 6, 0.35, 1);
    p.sharpAmount = (0.2 + u * 0.7) * calm;
    const sigmaPx = 1 + u * 1.5;
    const long = fullLongSide ?? Math.max(img.width, img.height);
    p.sharpRadius = sigmaPx / long;
    p.sharpThreshold = clamp(noise * 4, 4, 20);
    // Smooth colour speckle (film grain, JPEG blocks) without touching detail.
    p.chromaRadius = clamp(1.2 + noise * 0.25, 1.2, 3) / long;
  }

  return p;
}

// Strong remaining casts may be genuine (sunsets, lamplight): correct less.
function castStrength(chroma) {
  return chroma <= 18 ? 1 : clamp(1 - (chroma - 18) / 50, 0.5, 1);
}

// Average colour (0..1) of greyish pixels within a brightness range, after the
// current settings. Less colourful pixels count more. Null if none qualify.
function greyishMean(img, p, step, lo, hi) {
  const [lr, lg, lb] = buildLuts(p);
  let sr = 0, sg = 0, sb = 0, sw = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4 * step) {
    const r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    if (l < lo || l > hi) continue;
    const s = Math.max(r, g, b) - Math.min(r, g, b);
    const wgt = 1 / (1 + (s / 0.1) * (s / 0.1));
    sr += r * wgt; sg += g * wgt; sb += b * wgt; sw += wgt;
  }
  return sw > 0 ? [sr / sw, sg / sw, sb / sw] : null;
}

// Average colour (0..1) of all pixels darker than maxL after the settings.
function darkMean(img, p, step, maxL) {
  const [lr, lg, lb] = buildLuts(p);
  let sr = 0, sg = 0, sb = 0, n = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4 * step) {
    const r = lr[d[i]], g = lg[d[i + 1]], b = lb[d[i + 2]];
    if (0.299 * r + 0.587 * g + 0.114 * b > maxL) continue;
    sr += r; sg += g; sb += b; n++;
  }
  return n > 50 ? [sr / n, sg / n, sb / n] : null;
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
