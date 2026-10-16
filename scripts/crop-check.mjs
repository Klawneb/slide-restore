// Draws the auto-detected crop on each scan for inspection.
// Usage: node scripts/crop-check.mjs <out-dir> <file.jpg>...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import jpeg from 'jpeg-js';
import { detectCrop } from '../js/processing/crop.js';

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

for (const f of files) {
  const raw = jpeg.decode(readFileSync(f), { useTArray: true, formatAsRGBA: true });
  const small = resize({ width: raw.width, height: raw.height, data: raw.data }, 1024);
  const t = performance.now();
  const c = detectCrop(small);
  const ms = (performance.now() - t).toFixed(0);
  const name = basename(f, '.jpg').slice(0, 8);
  console.log(name, ms + 'ms', JSON.stringify(c, (k, v) => (typeof v === 'number' ? +v.toFixed(4) : v)));
  const img = small;
  if (c) {
    const X0 = Math.round(c.x0 * img.width), X1 = Math.round(c.x1 * img.width) - 1;
    const Y0 = Math.round(c.y0 * img.height), Y1 = Math.round(c.y1 * img.height) - 1;
    const put = (x, y) => { const p = (y * img.width + x) * 4; img.data[p] = 255; img.data[p + 1] = 0; img.data[p + 2] = 255; };
    for (let x = X0; x <= X1; x++) { put(x, Y0); put(x, Y1); }
    for (let y = Y0; y <= Y1; y++) { put(X0, y); put(X1, y); }
  }
  writeFileSync(join(outDir, `${name}_crop.jpg`), jpeg.encode({ ...img, data: Buffer.from(img.data.buffer) }, 90).data);
}
