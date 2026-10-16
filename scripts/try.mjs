// Runs Auto Fix on JPEG files the same way the app's worker does, writing
// side-by-side before/after images for inspection.
// Usage: node scripts/try.mjs <out-dir> <file.jpg>...

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import jpeg from 'jpeg-js';
import { analyze } from '../js/processing/analyze.js';
import { render } from '../js/processing/render.js';

const [outDir, ...files] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

function resize(img, max) {
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.round(img.width * s), h = Math.round(img.height * s);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.floor((x + 1) / s));
    const y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.floor((y + 1) / s));
    const acc = [0, 0, 0]; let n = 0;
    for (let yy = y0; yy < y1 && yy < img.height; yy++) for (let xx = x0; xx < x1 && xx < img.width; xx++) {
      const i = (yy * img.width + xx) * 4;
      acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2]; n++;
    }
    const o = (y * w + x) * 4;
    out[o] = acc[0] / n; out[o + 1] = acc[1] / n; out[o + 2] = acc[2] / n; out[o + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

function crop(img, cx, cy, cw, ch) {
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const src = ((cy + y) * img.width + cx) * 4;
    out.set(img.data.subarray(src, src + cw * 4), y * cw * 4);
  }
  return { width: cw, height: ch, data: out };
}

function sideBySide(a, b) {
  const w = a.width + b.width + 8, h = Math.max(a.height, b.height);
  const out = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    if (y < a.height) out.set(a.data.subarray(y * a.width * 4, (y + 1) * a.width * 4), y * w * 4);
    if (y < b.height) out.set(b.data.subarray(y * b.width * 4, (y + 1) * b.width * 4), (y * w + a.width + 8) * 4);
  }
  return { width: w, height: h, data: out };
}

const save = (img, path) => writeFileSync(path, jpeg.encode({ ...img, data: Buffer.from(img.data.buffer) }, 92).data);

for (const f of files) {
  const raw = jpeg.decode(readFileSync(f), { useTArray: true, formatAsRGBA: true });
  const full = { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data.buffer) };
  const small = resize(full, 1024);
  const cw = Math.min(full.width, 768), ch = Math.min(full.height, 768);
  const c = crop(full, (full.width - cw) >> 1, (full.height - ch) >> 1, cw, ch);
  const auto = analyze(small, c, Math.max(full.width, full.height));
  const fixed = render(full, auto, {});
  const name = basename(f, '.jpg').slice(0, 8);
  console.log(name, `${full.width}x${full.height}`, JSON.stringify(auto, (k, v) => (typeof v === 'number' ? +v.toFixed(3) : v)));
  save(sideBySide(resize(full, 900), resize(fixed, 900)), join(outDir, `${name}_compare.jpg`));
  // 100% crops show sharpening and noise at true pixel size.
  const z = (img) => crop(img, Math.floor(img.width * 0.35), Math.floor(img.height * 0.45), 440, 330);
  save(sideBySide(z(full), z(fixed)), join(outDir, `${name}_zoom.jpg`));
}
