// Removes dust specks: small spots much darker or lighter than what's round
// them (dust on the slide, or on the scanner glass).
//
// Specks are found by morphological closing (fills dark spots smaller than
// the window) and opening (removes light ones). Only spots on fairly smooth
// surroundings are touched — sky, walls, skin, water — where dust is most
// visible; busy texture like foliage is left alone so it isn't flattened.
// Dust is sparse, so spots in clusters (sunlight glinting through leaves,
// sparkle on water) are picture, not dust. Each speck is filled from the
// pixels round it.

const T = 18; // how much a speck must stand out (0..255 brightness)
const MAX_NEIGHBOURS = 6; // more clear spots than this close by: texture, not dust

export function removeDustInPlace(img, radius) {
  const r = Math.max(1, Math.round(radius));
  const { width: w, height: h, data } = img;
  if (w < 4 * r || h < 4 * r) return img;
  const n = w * h;
  const L = new Uint8Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) L[j] = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;

  const closed = morph(morph(L, w, h, r, true), w, h, r, false);
  const opened = morph(morph(L, w, h, r, false), w, h, r, true);

  // Candidate pixels: 1 = dark speck, 2 = light speck.
  const mark = new Uint8Array(n);
  let any = false;
  for (let j = 0; j < n; j++) {
    if (closed[j] - L[j] > T) { mark[j] = 1; any = true; }
    else if (L[j] - opened[j] > T) { mark[j] = 2; any = true; }
  }
  if (!any) return img;

  // Group candidates into specks and judge each against its surroundings.
  const maxArea = Math.PI * r * r * 1.3, maxSpan = 2 * r + 2;
  const stack = new Int32Array(n);
  const pix = new Int32Array(Math.ceil(maxArea) + 64);
  const fillMask = new Uint8Array(n);
  const specks = [];
  for (let s = 0; s < n; s++) {
    if (!mark[s]) continue;
    const kind = mark[s];
    let top = 0, count = 0, tooBig = false;
    let x0 = w, x1 = 0, y0 = h, y1 = 0, sum = 0;
    stack[top++] = s; mark[s] = 0;
    while (top) {
      const j = stack[--top];
      const x = j % w, y = (j - x) / w;
      if (count < pix.length) pix[count] = j;
      count++;
      sum += L[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (count > maxArea) tooBig = true;
      const nb = [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1];
      for (const k of nb) if (k >= 0 && mark[k] === kind) { mark[k] = 0; stack[top++] = k; }
    }
    if (tooBig || x1 - x0 > maxSpan || y1 - y0 > maxSpan) continue;
    specks.push({ x0, x1, y0, y1, pix: pix.slice(0, Math.min(count, pix.length)), sum, count, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }

  // Each speck must stand out clearly from a fairly smooth ring round it.
  const clear = [];
  for (const k of specks) {
    const { x0, x1, y0, y1, sum, count } = k;
    const rx0 = Math.max(0, x0 - r), rx1 = Math.min(w - 1, x1 + r);
    const ry0 = Math.max(0, y0 - r), ry1 = Math.min(h - 1, y1 + r);
    let rs = 0, rs2 = 0, rn = 0;
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      const v = L[y * w + x];
      rs += v; rs2 += v * v; rn++;
    }
    if (rn < 8) continue;
    k.mean = rs / rn;
    k.sd = Math.sqrt(Math.max(0, rs2 / rn - k.mean * k.mean));
    const contrast = Math.abs(sum / count - k.mean);
    if (k.sd <= 9 && contrast >= Math.max(T, k.sd * 4)) clear.push(k);
  }

  // Dust is sparse: clear spots in clusters (light through leaves, sparkle
  // on water) are picture. Count neighbours on a coarse grid.
  const cell = 8 * r, gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const grid = new Uint16Array(gw * gh);
  for (const k of clear) grid[Math.floor(k.cy / cell) * gw + Math.floor(k.cx / cell)]++;
  const near = (k) => {
    const gx = Math.floor(k.cx / cell), gy = Math.floor(k.cy / cell);
    let c = 0;
    for (let y = Math.max(0, gy - 2); y <= Math.min(gh - 1, gy + 2); y++) {
      for (let x = Math.max(0, gx - 2); x <= Math.min(gw - 1, gx + 2); x++) c += grid[y * gw + x];
    }
    return c - 1;
  };

  for (const k of clear) {
    if (near(k) > MAX_NEIGHBOURS) continue;
    const { x0, x1, y0, y1, mean, sd } = k;
    for (const j of k.pix) fillMask[j] = 1;
    // Include the speck's soft edge.
    for (let y = Math.max(0, y0 - 1); y <= Math.min(h - 1, y1 + 1); y++) {
      for (let x = Math.max(0, x0 - 1); x <= Math.min(w - 1, x1 + 1); x++) {
        const j = y * w + x;
        if (Math.abs(L[j] - mean) > sd * 1.5 + 4) fillMask[j] = 1;
      }
    }
    fillSpeck(data, fillMask, w, h, Math.max(0, x0 - 1), Math.min(w - 1, x1 + 1), Math.max(0, y0 - 1), Math.min(h - 1, y1 + 1), r);
  }
  return img;
}

// Replace masked pixels with a distance-weighted average of nearby unmasked ones.
function fillSpeck(data, mask, w, h, x0, x1, y0, y1, r) {
  const R = r + 2;
  const fills = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const j = y * w + x;
    if (!mask[j]) continue;
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
      for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
        const k = yy * w + xx;
        if (mask[k]) continue;
        const d2 = (xx - x) * (xx - x) + (yy - y) * (yy - y);
        const wt = 1 / (d2 * d2 + 1);
        const p = k * 4;
        sr += data[p] * wt; sg += data[p + 1] * wt; sb += data[p + 2] * wt; sw += wt;
      }
    }
    if (sw > 0) fills.push(j, sr / sw, sg / sw, sb / sw);
  }
  for (let i = 0; i < fills.length; i += 4) {
    const p = fills[i] * 4;
    data[p] = fills[i + 1]; data[p + 1] = fills[i + 2]; data[p + 2] = fills[i + 3];
    mask[fills[i]] = 0;
  }
}

// Square max (dilate) or min (erode) filter of radius r, separable, using the
// van Herk / Gil-Werman method: about three comparisons per pixel whatever r is.
function morph(src, w, h, r, isMax) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const win = 2 * r + 1;
  const len = Math.max(w, h) + 2 * win;
  const line = new Uint8Array(len), g = new Uint8Array(len), hh = new Uint8Array(len);
  const pad = isMax ? 0 : 255;
  const pass = (from, to, count, lineLen, stride, lineStride) => {
    const L = lineLen + 2 * r;
    line.fill(pad, 0, r);
    line.fill(pad, r + lineLen, L);
    for (let li = 0; li < count; li++) {
      const base = li * lineStride;
      for (let k = 0, q = base; k < lineLen; k++, q += stride) line[r + k] = from[q];
      // Running max/min forwards and backwards within blocks of win.
      for (let b0 = 0; b0 < L; b0 += win) {
        const b1 = Math.min(L, b0 + win);
        let m = line[b0];
        g[b0] = m;
        for (let i = b0 + 1; i < b1; i++) { const v = line[i]; if (isMax ? v > m : v < m) m = v; g[i] = m; }
        m = line[b1 - 1];
        hh[b1 - 1] = m;
        for (let i = b1 - 2; i >= b0; i--) { const v = line[i]; if (isMax ? v > m : v < m) m = v; hh[i] = m; }
      }
      // Window [k, k + 2r] in padded coordinates.
      for (let k = 0, q = base; k < lineLen; k++, q += stride) {
        const x = hh[k], y = g[k + 2 * r];
        to[q] = isMax ? (x > y ? x : y) : (x < y ? x : y);
      }
    }
  };
  pass(src, tmp, h, w, 1, w); // rows
  pass(tmp, out, w, h, w, 1); // columns
  return out;
}
