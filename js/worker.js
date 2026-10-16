// Background worker: decoding, analysis, rendering and JPEG export.
// Keeps the UI responsive even on very large scans.

import { analyze } from './processing/analyze.js';
import { render } from './processing/render.js';
import { detectCrop, cropImage, isFullCrop } from './processing/crop.js';

const previews = new Map(); // key → ImageData kept for fast re-rendering

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
  return analyze(cropImage(small, c), detail, long);
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
    previews.set(key, preview);
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

  render({ key, base, adj, rot, crop }) {
    const img = previews.get(key);
    if (!img) throw new Error('NOT_PREPARED');
    const out = render(cropImage(img, crop), base, adj, rot);
    const data = new ImageData(out.data, out.width, out.height);
    return { result: data, transfer: [data.data.buffer] };
  },

  forget({ key }) {
    previews.delete(key);
    return { result: true };
  },

  async export({ file, base, adj, rot, crop, quality }) {
    const bmp = await decode(file);
    const { width: W, height: H } = bmp;
    const r = isFullCrop(crop) ? { x0: 0, y0: 0, x1: 1, y1: 1 } : crop;
    const sx = Math.round(r.x0 * W), sy = Math.round(r.y0 * H);
    const sw = Math.max(1, Math.round(r.x1 * W) - sx), sh = Math.max(1, Math.round(r.y1 * H) - sy);
    const full = draw(bmp, sx, sy, sw, sh, sw, sh);
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
