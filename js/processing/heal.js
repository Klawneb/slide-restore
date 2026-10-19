// Spot healing: paint over a blemish (a speck, a hair, a scratch) and it is
// covered with a nearby patch of the picture, whose colours are then bent to
// match what's round the blemish so no edge shows – a healing brush. The
// patch keeps its grain and texture, so the fill doesn't look smeared.
//
// A stroke is { pts: [[x, y], ...], r, dx, dy }: the brush's path in
// fractions of the photo (before straightening, cropping and turning), its
// radius as a fraction of the photo's long side, and where the patch comes
// from, as an offset in fractions of the photo (0, 0: no patch, a smooth fill).
// findSource() chooses the patch once, so the preview, the zoomed-in detail
// and the saved photo all heal the same way.

const FEATHER = 0.3; // soft edge beyond the brush, as a fraction of its radius
const NONE = Object.freeze({ dx: 0, dy: 0 });

const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Distance from each pixel near the stroke to its path, over the stroke's
// bounding box widened by `margin` pixels. Pixel centres are at +0.5.
function strokeField(w, h, stroke, margin) {
  const r = stroke.r * Math.max(w, h);
  if (!(r > 0.3) || !stroke.pts?.length) return null;
  const pts = stroke.pts.map(([x, y]) => [x * w, y * h]);
  const reach = r + margin;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  x0 = Math.max(0, Math.floor(x0 - reach)); y0 = Math.max(0, Math.floor(y0 - reach));
  x1 = Math.min(w, Math.ceil(x1 + reach)); y1 = Math.min(h, Math.ceil(y1 + reach));
  if (x1 <= x0 || y1 <= y0) return null;
  const bw = x1 - x0, bh = y1 - y0;
  const d = new Float32Array(bw * bh).fill(Infinity);
  // Each segment only visits the pixels it can reach.
  const segs = Math.max(1, pts.length - 1);
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[Math.min(i + 1, pts.length - 1)];
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy;
    const sx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - reach)), sx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + reach));
    const sy0 = Math.max(y0, Math.floor(Math.min(ay, by) - reach)), sy1 = Math.min(y1, Math.ceil(Math.max(ay, by) + reach));
    for (let y = sy0; y < sy1; y++) {
      for (let x = sx0; x < sx1; x++) {
        const px = x + 0.5 - ax, py = y + 0.5 - ay;
        const t = len2 ? clampi((px * vx + py * vy) / len2, 0, 1) : 0;
        const ex = px - t * vx, ey = py - t * vy;
        const dd = Math.sqrt(ex * ex + ey * ey);
        const j = (y - y0) * bw + (x - x0);
        if (dd < d[j]) d[j] = dd;
      }
    }
  }
  return { x0, y0, bw, bh, r, d };
}

// Fills in the unknown values (kind 2) smoothly from the known ones (kind 1),
// as a soap film stretched over them would: a quick coarse-to-fine guess
// (pull-push), then relaxed. V holds three values per pixel, changed in place.
function membrane(V, kind, w, h) {
  const levels = [];
  let lw = w, lh = h, val = V, wt = new Float32Array(w * h);
  for (let j = 0; j < wt.length; j++) wt[j] = kind[j] === 1 ? 1 : 0;
  levels.push({ w, h, val, wt });
  // Pull: average the known values down a pyramid.
  while (lw > 1 || lh > 1) {
    const nw = (lw + 1) >> 1, nh = (lh + 1) >> 1;
    const nv = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
    for (let y = 0; y < lh; y++) {
      for (let x = 0; x < lw; x++) {
        const j = y * lw + x, k = wt[j];
        if (!k) continue;
        const c = (y >> 1) * nw + (x >> 1);
        nwt[c] += k;
        nv[c * 3] += val[j * 3] * k; nv[c * 3 + 1] += val[j * 3 + 1] * k; nv[c * 3 + 2] += val[j * 3 + 2] * k;
      }
    }
    for (let c = 0; c < nwt.length; c++) {
      if (!nwt[c]) continue;
      nv[c * 3] /= nwt[c]; nv[c * 3 + 1] /= nwt[c]; nv[c * 3 + 2] /= nwt[c];
      if (nwt[c] > 1) nwt[c] = 1;
    }
    lw = nw; lh = nh; val = nv; wt = nwt;
    levels.push({ w: lw, h: lh, val, wt });
  }
  // Push: fill the gaps at each level from the one above, finest last.
  for (let l = levels.length - 2; l >= 0; l--) {
    const F = levels[l], C = levels[l + 1];
    for (let y = 0; y < F.h; y++) {
      const cy = clampi((y + 0.5) / 2 - 0.5, 0, C.h - 1), cy0 = Math.floor(cy), cy1 = Math.min(C.h - 1, cy0 + 1), ty = cy - cy0;
      for (let x = 0; x < F.w; x++) {
        const j = y * F.w + x, k = F.wt[j];
        if (k >= 1) continue;
        const cx = clampi((x + 0.5) / 2 - 0.5, 0, C.w - 1), cx0 = Math.floor(cx), cx1 = Math.min(C.w - 1, cx0 + 1), tx = cx - cx0;
        const a = (cy0 * C.w + cx0) * 3, b = (cy0 * C.w + cx1) * 3, c = (cy1 * C.w + cx0) * 3, e = (cy1 * C.w + cx1) * 3;
        const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
        for (let ch = 0; ch < 3; ch++) {
          const up = C.val[a + ch] * w00 + C.val[b + ch] * w01 + C.val[c + ch] * w10 + C.val[e + ch] * w11;
          F.val[j * 3 + ch] = F.val[j * 3 + ch] * k + up * (1 - k);
        }
      }
    }
  }
  // Relax: each unknown becomes the average of its neighbours.
  const fill = [];
  for (let j = 0; j < kind.length; j++) if (kind[j] === 2) fill.push(j);
  for (let it = 0; it < 30; it++) {
    for (const j of fill) {
      const x = j % w;
      let s0 = 0, s1 = 0, s2 = 0, n = 0;
      const add = (k) => { s0 += V[k * 3]; s1 += V[k * 3 + 1]; s2 += V[k * 3 + 2]; n++; };
      if (x > 0) add(j - 1);
      if (x < w - 1) add(j + 1);
      if (j >= w) add(j - w);
      if (j + w < kind.length) add(j + w);
      V[j * 3] = s0 / n; V[j * 3 + 1] = s1 / n; V[j * 3 + 2] = s2 / n;
    }
  }
}

// Heal one stroke into img (any size: the stroke is in fractions of it).
export function healInPlace(img, stroke) {
  const { width: w, height: h, data } = img;
  const r = stroke.r * Math.max(w, h);
  const soft = Math.max(1, r * FEATHER), edge = r + soft;
  const m = strokeField(w, h, stroke, soft + 2);
  if (!m) return img;
  const { x0, y0, bw, bh, d } = m;
  const ox = Math.round((stroke.dx || 0) * w), oy = Math.round((stroke.dy || 0) * h);
  const patch = ox !== 0 || oy !== 0;
  const src = (x, y) => (clampi(y + oy, 0, h - 1) * w + clampi(x + ox, 0, w - 1)) * 4;
  // 0 = left alone, 1 = just outside (where the patch must match), 2 = filled.
  const n = bw * bh;
  const kind = new Uint8Array(n);
  const V = new Float32Array(n * 3); // picture minus patch
  let known = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = y * bw + x, dd = d[j];
      if (dd <= edge) kind[j] = 2;
      else if (dd <= edge + 1.5) {
        kind[j] = 1; known++;
        const p = ((y0 + y) * w + x0 + x) * 4, s = src(x0 + x, y0 + y);
        for (let c = 0; c < 3; c++) V[j * 3 + c] = data[p + c] - (patch ? data[s + c] : 0);
      }
    }
  }
  if (!known) return img;
  membrane(V, kind, bw, bh);
  // Work out every new pixel before writing any, in case the patch overlaps.
  const out = [];
  for (let j = 0; j < n; j++) {
    if (kind[j] !== 2) continue;
    const x = x0 + (j % bw), y = y0 + Math.floor(j / bw);
    const p = (y * w + x) * 4, s = src(x, y);
    const u = d[j] <= r ? 1 : (edge - d[j]) / soft, a = u * u * (3 - 2 * u);
    for (let c = 0; c < 3; c++) {
      const v = (patch ? data[s + c] : 0) + V[j * 3 + c];
      out.push(p + c, data[p + c] + (v - data[p + c]) * a);
    }
  }
  for (let i = 0; i < out.length; i += 2) data[out[i]] = out[i + 1];
  return img;
}

// Where to take the patch from for a stroke: the nearby spot whose
// surroundings look most like the stroke's, that doesn't overlap it and has
// nothing in it busier than its own surroundings (another speck, an edge).
export function findSource(img, stroke) {
  const { width: w, height: h, data } = img;
  const r = stroke.r * Math.max(w, h);
  const soft = Math.max(1, r * FEATHER), edge = r + soft;
  const band = Math.max(2, r * 0.75); // how much of the surroundings is compared
  const m = strokeField(w, h, stroke, soft + band + 1);
  if (!m) return NONE;
  const { x0, y0, bw, bh, d } = m;
  const inner = [], ring = [];
  for (let j = 0; j < d.length; j++) {
    const list = d[j] <= edge ? inner : d[j] <= edge + band ? ring : null;
    if (list) list.push(x0 + (j % bw), y0 + Math.floor(j / bw));
  }
  if (!inner.length || !ring.length) return NONE;
  // Compare a few hundred pixels at most.
  const sample = (list) => {
    const step = Math.max(1, Math.floor(list.length / 2 / 500));
    const out = [];
    for (let i = 0; i < list.length; i += 2 * step) out.push(list[i], list[i + 1]);
    return out;
  };
  const ringS = sample(ring), innerS = sample(inner);
  const lum = (p) => 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  const variance = (s, s2, n) => s2 / n - (s / n) * (s / n);

  const base = 2 * edge + 2;
  const DIST = [1, 1.25, 1.6, 2, 2.6, 3.4, 4.5, 6];
  const ANGLES = 24;
  let best = null, bestScore = Infinity;
  for (let di = 0; di < DIST.length; di++) {
    for (let ai = 0; ai < ANGLES; ai++) {
      const t = (ai / ANGLES) * 2 * Math.PI + (di % 2) * (Math.PI / ANGLES);
      const ox = Math.round(Math.cos(t) * DIST[di] * base), oy = Math.round(Math.sin(t) * DIST[di] * base);
      // The patch must be inside the picture and clear of what's being healed.
      let ok = true;
      for (let i = 0; i < inner.length && ok; i += 2) {
        const sx = inner[i] + ox, sy = inner[i + 1] + oy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) ok = false;
        else {
          const lx = sx - x0, ly = sy - y0;
          if (lx >= 0 && ly >= 0 && lx < bw && ly < bh && d[ly * bw + lx] <= edge + 1) ok = false;
        }
      }
      if (!ok) continue;
      // How alike the surroundings are, once an overall shift in colour (which
      // healing evens out) is mostly allowed for.
      const mean = [0, 0, 0], sq = [0, 0, 0];
      let rl = 0, rl2 = 0, rn = 0;
      for (let i = 0; i < ringS.length; i += 2) {
        const tx = ringS[i], ty = ringS[i + 1];
        const sx = clampi(tx + ox, 0, w - 1), sy = clampi(ty + oy, 0, h - 1);
        const p = (ty * w + tx) * 4, s = (sy * w + sx) * 4;
        for (let c = 0; c < 3; c++) { const v = data[p + c] - data[s + c]; mean[c] += v; sq[c] += v * v; }
        const l = lum(s); rl += l; rl2 += l * l; rn++;
      }
      let score = 0;
      for (let c = 0; c < 3; c++) score += variance(mean[c], sq[c], rn) + 0.25 * (mean[c] / rn) ** 2;
      let il = 0, il2 = 0, inn = 0;
      for (let i = 0; i < innerS.length; i += 2) {
        const l = lum(((innerS[i + 1] + oy) * w + innerS[i] + ox) * 4);
        il += l; il2 += l * l; inn++;
      }
      score += 2 * Math.max(0, variance(il, il2, inn) - variance(rl, rl2, rn));
      score *= 1 + 0.04 * di; // nearer is better, other things equal
      if (score < bestScore) { bestScore = score; best = [ox, oy]; }
    }
  }
  if (!best) return NONE;
  return { dx: Math.round((best[0] / w) * 1e6) / 1e6, dy: Math.round((best[1] / h) * 1e6) / 1e6 };
}

// A long stroke (a hair, a scratch) in pieces, each to be healed with its
// own patch: one patch rarely suits the whole length, which may cross from
// one thing in the picture to another. aspect is the photo's width / height.
export function splitStroke(stroke, aspect, maxLength = 8) {
  const { pts, r } = stroke;
  // Lengths in units of the photo's long side, like r.
  const sx = aspect >= 1 ? 1 : aspect, sy = aspect >= 1 ? 1 / aspect : 1;
  const pieces = [];
  let cur = [pts[0]], len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot((pts[i][0] - pts[i - 1][0]) * sx, (pts[i][1] - pts[i - 1][1]) * sy);
    cur.push(pts[i]);
    if (len >= maxLength * r && i < pts.length - 1) {
      pieces.push({ pts: cur, r });
      cur = [pts[i]]; len = 0;
    }
  }
  pieces.push({ pts: cur, r });
  return pieces;
}
