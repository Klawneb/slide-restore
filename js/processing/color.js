// Colour helpers shared by analysis and rendering.
// Images are plain { width, height, data } objects where data is RGBA bytes,
// so the same code runs in the browser (ImageData) and in Node tests.

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Build a 256-bin histogram for each channel plus luma.
export function histograms(img, step = 1) {
  const { data } = img;
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4 * step) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    l[Math.round(luma(R, G, B))]++;
  }
  return { r, g, b, l };
}

// Value (0..255, fractional) below which `p` (0..1) of the histogram lies.
export function percentile(hist, p) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  if (total === 0) return 0;
  const target = p * total;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    const next = acc + hist[i];
    if (next >= target) {
      const frac = hist[i] ? (target - acc) / hist[i] : 0;
      return i + frac - 0.5 < 0 ? 0 : i + frac - 0.5;
    }
    acc = next;
  }
  return 255;
}

// sRGB (0..1) → CIE Lab (D65).
function toLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function labF(t) {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}
export function rgbToLab(r, g, b) {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = labF(X), fy = labF(Y), fz = labF(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

// Mean Lab colour of an image (sampled), handy for tests and cast measurement.
export function meanLab(img, step = 1) {
  const { data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
  }
  return rgbToLab(r / n / 255, g / n / 255, b / n / 255);
}
