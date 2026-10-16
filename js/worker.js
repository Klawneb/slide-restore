// Background worker: decoding, analysis, rendering and JPEG export.
// Keeps the UI responsive even on very large scans.

import { analyze } from './processing/analyze.js';
import { render } from './processing/render.js';

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

const handlers = {
  async prepare({ key, file, previewMax, auto }) {
    const bmp = await decode(file);
    const { width: W, height: H } = bmp;
    const [pw, ph] = fit(W, H, previewMax);
    const preview = draw(bmp, 0, 0, W, H, pw, ph);
    if (!auto) {
      const [aw, ah] = fit(W, H, 1024);
      const small = aw === pw ? preview : draw(bmp, 0, 0, W, H, aw, ah);
      // Full-resolution centre crop to judge blur and grain at true size.
      const cw = Math.min(W, 768), ch = Math.min(H, 768);
      const crop = draw(bmp, (W - cw) >> 1, (H - ch) >> 1, cw, ch, cw, ch);
      auto = analyze(small, crop, Math.max(W, H));
    }
    bmp.close();
    previews.set(key, preview);
    const copy = new ImageData(new Uint8ClampedArray(preview.data), pw, ph);
    return { result: { auto, original: copy, fullWidth: W, fullHeight: H }, transfer: [copy.data.buffer] };
  },

  render({ key, base, adj, rot }) {
    const img = previews.get(key);
    if (!img) throw new Error('NOT_PREPARED');
    const out = render(img, base, adj, rot);
    const data = new ImageData(out.data, out.width, out.height);
    return { result: data, transfer: [data.data.buffer] };
  },

  forget({ key }) {
    previews.delete(key);
    return { result: true };
  },

  async export({ file, base, adj, rot, quality }) {
    const bmp = await decode(file);
    const full = draw(bmp, 0, 0, bmp.width, bmp.height, bmp.width, bmp.height);
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
