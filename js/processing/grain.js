// Softens film grain in brightness without blurring edges.
//
// A guided filter (He et al.) using the image as its own guide: in each small
// window, if the brightness varies about as much as grain does, the window is
// flattened towards its mean; if it varies much more (an edge, real texture)
// it is kept. `sigma` is the grain's strength (0..255 units) at this image's
// resolution, so the filter only treats grain-sized ripples as grain. Colour
// isn't touched here; smoothChromaInPlace handles colour speckle.

export function smoothGrainInPlace(img, strength, sigma, radius) {
  if (strength <= 0.01 || sigma <= 0.3) return img;
  const { width: w, height: h, data } = img;
  const n = w * h;
  const r = Math.max(1, Math.round(radius));
  if (w <= 2 * r || h <= 2 * r) return img;

  const I = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    I[j] = l; II[j] = l * l;
  }
  const mean = boxMean(I, w, h, r);
  const mean2 = boxMean(II, w, h, r);

  // Ripples up to about k × grain strength count as grain.
  const k = 1.2 + 1.6 * strength;
  const eps = (k * sigma) * (k * sigma);
  // a: how much of each window's variation to keep; b: the rest is its mean.
  const A = II, B = new Float32Array(n); // reuse II's buffer for a
  for (let j = 0; j < n; j++) {
    const m = mean[j];
    const v = Math.max(0, mean2[j] - m * m);
    const a = v / (v + eps);
    A[j] = a; B[j] = m - a * m;
  }
  const ma = boxMean(A, w, h, r), mb = boxMean(B, w, h, r);

  const mix = Math.min(1, strength * 1.4);
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const l = I[j];
    const d = (ma[j] * l + mb[j] - l) * mix;
    data[i] += d; data[i + 1] += d; data[i + 2] += d;
  }
  return img;
}

// Mean over a (2r+1)² window, edges handled by shrinking the window.
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  // Rows.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= r; x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      tmp[row + x] = s / (Math.min(w - 1, hi) - Math.max(0, lo) + 1);
      if (hi + 1 < w) s += src[row + hi + 1];
      if (lo >= 0) s -= src[row + lo];
    }
  }
  // Columns.
  const col = new Float64Array(w);
  for (let y = 0; y <= r; y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    const lo = y - r, hi = y + r;
    const cnt = Math.min(h - 1, hi) - Math.max(0, lo) + 1;
    const row = y * w;
    for (let x = 0; x < w; x++) out[row + x] = col[x] / cnt;
    if (hi + 1 < h) { const p = (hi + 1) * w; for (let x = 0; x < w; x++) col[x] += tmp[p + x]; }
    if (lo >= 0) { const p = lo * w; for (let x = 0; x < w; x++) col[x] -= tmp[p + x]; }
  }
  return out;
}

// How strong the grain is (0..255 units): the ripple left after removing a
// small blur, measured only in flat areas (sky, walls, skin) where grain
// isn't mixed up with detail. Very dark and very bright areas are skipped
// (grain is squashed there). A busy picture with no flat areas gives 0: grain
// is hard to see there and smoothing would only blur detail.
export function grainSigma(L, w, h) {
  const r = 2, B = 16;
  if (w < 4 * B || h < 4 * B) return 0;
  const F = Float32Array.from(L);
  const m = boxMean(F, w, h, r);
  const stds = [];
  let blocks = 0;
  for (let by = 0; by + B <= h; by += B) for (let bx = 0; bx + B <= w; bx += B) {
    let s = 0, s2 = 0, sm = 0, sm2 = 0;
    for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
      const j = y * w + x, d = F[j] - m[j];
      s += d; s2 += d * d; sm += m[j]; sm2 += m[j] * m[j];
    }
    blocks++;
    const n = B * B, ml = sm / n;
    if (ml < 40 || ml > 225) continue;
    // Flat: the blurred picture barely changes across the block.
    if (Math.sqrt(Math.max(0, sm2 / n - ml * ml)) > 5) continue;
    stds.push(Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)));
  }
  if (stds.length < Math.max(6, blocks * 0.03)) return 0;
  stds.sort((a, b) => a - b);
  return stds[Math.floor(stds.length * 0.5)];
}
