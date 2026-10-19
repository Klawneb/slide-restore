// Background worker: decoding, analysis, rendering and JPEG export.
// Keeps the UI responsive even on very large scans.

import { analyze } from './processing/analyze.js';
import { render, rotate } from './processing/render.js';
import { detectCrop, applyCrop, isFullCrop, rotateCrop, transform, FULL_CROP } from './processing/crop.js';
import { healInPlace, findSource } from './processing/heal.js';

const previews = new Map(); // key → { img, plain, healed, framed, whole } kept for fast re-rendering

function subImage(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const s = ((y + row) * img.width + x) * 4;
    out.set(img.data.subarray(s, s + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

function fit(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function draw(source, sx, sy, sw, sh, w, h) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

// Heal strokes are compared as text: painting adds one after another, so a
// cached result can usually be built on rather than started again.
const strokeKeys = (heals = []) => heals.map((s) => JSON.stringify(s));
const startsWith = (keys, start) => start.length <= keys.length && start.every((k, i) => k === keys[i]);

// The preview with the heal strokes applied (a copy; entry.img stays as it is).
function healedPreview(entry, heals) {
  const keys = strokeKeys(heals);
  let h = entry.healed;
  if (!h || !startsWith(keys, h.keys)) h = entry.plain;
  if (h.keys.length < keys.length) {
    const img = h.img === entry.img
      ? { width: entry.img.width, height: entry.img.height, data: new Uint8ClampedArray(entry.img.data) } : h.img;
    for (let i = h.keys.length; i < keys.length; i++) healInPlace(img, heals[i]);
    h = { keys, img };
  }
  entry.healed = h;
  return h;
}

// The whole scan at full resolution, healed. Kept for zooming in; healed
// further in place as strokes are added, decoded again otherwise.
async function healedWhole(entry, file, heals) {
  const keys = strokeKeys(heals);
  let wh = entry.whole;
  if (!wh || !startsWith(keys, wh.keys)) {
    entry.whole = wh = null; // free the old one first
    const bmp = await decode(file);
    wh = { keys: [], img: draw(bmp, 0, 0, bmp.width, bmp.height, bmp.width, bmp.height) };
    bmp.close();
  }
  for (let i = wh.keys.length; i < keys.length; i++) healInPlace(wh.img, heals[i]);
  wh.keys = keys;
  entry.whole = wh;
  return wh.img;
}

async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('UNSUPPORTED');
  }
}

// What analyze() needs: a ~1024px copy and a full-resolution centre patch
// (to judge blur and grain at true size).
function analysisInputs(bmp) {
  const { width: W, height: H } = bmp;
  const [aw, ah] = fit(W, H, 1024);
  const small = draw(bmp, 0, 0, W, H, aw, ah);
  const cw = Math.min(W, 768), ch = Math.min(H, 768);
  const detail = draw(bmp, (W - cw) >> 1, (H - ch) >> 1, cw, ch, cw, ch);
  return { small, detail, W, H };
}

function analyzeCrop({ small, detail, W, H }, c) {
  if (isFullCrop(c)) return analyze(small, detail, Math.max(W, H));
  const long = Math.max(W * (c.x1 - c.x0), H * (c.y1 - c.y0));
  return analyze(applyCrop(small, c), detail, long);
}

const handlers = {
  // Decodes a photo, keeps a preview for live editing and works out Auto Fix
  // settings for each crop asked for ('auto' = the detected border crop).
  async prepare({ key, file, previewMax, detect, crops }) {
    const bmp = await decode(file);
    const { width: W, height: H } = bmp;
    const [pw, ph] = fit(W, H, previewMax);
    const preview = draw(bmp, 0, 0, W, H, pw, ph);
    let autoCrop;
    const autos = [];
    if (detect || crops.length) {
      const inputs = analysisInputs(bmp);
      if (detect) autoCrop = detectCrop(inputs.small);
      for (const c of crops) {
        const rect = (c === 'auto' ? autoCrop : c) ?? null;
        const same = autos.find((a) => JSON.stringify(a.crop) === JSON.stringify(rect));
        autos.push({ crop: rect, auto: same ? same.auto : analyzeCrop(inputs, rect) });
      }
    }
    bmp.close();
    previews.set(key, { img: preview, plain: { keys: [], img: preview }, healed: null, framed: null, whole: null });
    const copy = new ImageData(new Uint8ClampedArray(preview.data), pw, ph);
    return { result: { original: copy, fullWidth: W, fullHeight: H, autoCrop, autos }, transfer: [copy.data.buffer] };
  },

  // Auto Fix settings for a hand-adjusted crop.
  async analyze({ file, crop }) {
    const bmp = await decode(file);
    const inputs = analysisInputs(bmp);
    bmp.close();
    return { result: analyzeCrop(inputs, crop) };
  },

  render({ key, base, adj, rot, crop, heals }) {
    const entry = previews.get(key);
    if (!entry) throw new Error('NOT_PREPARED');
    const src = healedPreview(entry, heals);
    // Straightening resamples the whole preview, so keep the last result.
    const ck = JSON.stringify(crop ?? null);
    if (entry.framed?.key !== ck || entry.framed.src !== src) entry.framed = { key: ck, src, img: applyCrop(src.img, crop) };
    const out = render(entry.framed.img, base, adj, rot);
    const data = new ImageData(out.data, out.width, out.height);
    return { result: data, transfer: [data.data.buffer] };
  },

  // Full-resolution render of part of the photo, for zooming in. region is
  // a rectangle of the photo as shown (cropped and rotated), in 0..1.
  async detail({ key, file, base, adj, rot, crop, heals, region }) {
    const entry = previews.get(key);
    if (!entry) throw new Error('NOT_PREPARED');
    const img = await healedWhole(entry, file, heals);
    const W = img.width, H = img.height;
    // The crop in pixels, as applyCrop() cuts it.
    const c = isFullCrop(crop) ? FULL_CROP : crop;
    const ox = Math.round(c.x0 * W), oy = Math.round(c.y0 * H);
    const cw = Math.max(1, Math.round(c.x1 * W) - ox), ch = Math.max(1, Math.round(c.y1 * H) - oy);
    const r = rotateCrop(region, -rot);
    // A margin so sharpening and dust removal behave as on the whole photo.
    const pad = 24;
    const x0 = Math.max(0, Math.floor(r.x0 * cw) - pad), x1 = Math.min(cw, Math.ceil(r.x1 * cw) + pad);
    const y0 = Math.max(0, Math.floor(r.y0 * ch) - pad), y1 = Math.min(ch, Math.ceil(r.y1 * ch) + pad);
    const sub = c.angle
      ? transform(img, c.angle, { x0: (ox + x0) / W, y0: (oy + y0) / H, x1: (ox + x1) / W, y1: (oy + y1) / H })
      : subImage(img, ox + x0, oy + y0, x1 - x0, y1 - y0);
    const out = render(sub, base, adj, 0, Math.max(cw, ch));
    // Trim the margin back off, then turn it the way it's shown.
    const tx0 = Math.floor(r.x0 * cw) - x0, ty0 = Math.floor(r.y0 * ch) - y0;
    const tw = Math.max(1, Math.min(out.width - tx0, Math.ceil(r.x1 * cw) - Math.floor(r.x0 * cw)));
    const th = Math.max(1, Math.min(out.height - ty0, Math.ceil(r.y1 * ch) - Math.floor(r.y0 * ch)));
    const shown = rotate(subImage(out, tx0, ty0, tw, th), rot);
    const data = new ImageData(shown.data, shown.width, shown.height);
    return { result: data, transfer: [data.data.buffer] };
  },

  // Where to take a new heal stroke's patch from, on the preview as healed so far.
  healSource({ key, heals, stroke }) {
    const entry = previews.get(key);
    if (!entry) throw new Error('NOT_PREPARED');
    return { result: findSource(healedPreview(entry, heals).img, stroke) };
  },

  forget({ key }) {
    previews.delete(key);
    return { result: true };
  },

  async export({ file, base, adj, rot, crop, heals, quality }) {
    const bmp = await decode(file);
    const { width: W, height: H } = bmp;
    let full;
    if (crop?.angle || heals?.length) {
      // Straightening needs the whole scan to sample from, and healing may
      // take patches from outside the crop.
      const whole = draw(bmp, 0, 0, W, H, W, H);
      for (const s of heals ?? []) healInPlace(whole, s);
      full = applyCrop(whole, crop);
    } else {
      const r = isFullCrop(crop) ? { x0: 0, y0: 0, x1: 1, y1: 1 } : crop;
      const sx = Math.round(r.x0 * W), sy = Math.round(r.y0 * H);
      const sw = Math.max(1, Math.round(r.x1 * W) - sx), sh = Math.max(1, Math.round(r.y1 * H) - sy);
      full = draw(bmp, sx, sy, sw, sh, sw, sh);
    }
    bmp.close();
    const out = render(full, base, adj, rot);
    const c = new OffscreenCanvas(out.width, out.height);
    c.getContext('2d').putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
    return { result: blob };
  },
};

self.onmessage = async (e) => {
  const { id, type, payload } = e.data;
  try {
    const { result, transfer = [] } = await handlers[type](payload);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
