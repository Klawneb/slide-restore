// Generates the app icons (PNG + SVG) without any dependencies.
// Design: a slide mount framing a little sunset landscape, plus a sparkle.
// Run: node scripts/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const OUT = new URL('../icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const C = {
  bgTop: hex('#24557f'), bgBot: hex('#132a40'),
  mount: hex('#f4efe4'), shadow: hex('#0b1a28'),
  skyTop: hex('#5aa9e6'), skyBot: hex('#f7a35c'),
  sun: hex('#ffe08a'), hill: hex('#3f8f4f'), hill2: hex('#2f7040'),
  gold: hex('#f5b942'),
};

function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
const hillY = (x) => 0.6 + 0.035 * Math.sin((x - 0.29) * 14);
const hill2Y = (x) => 0.65 + 0.025 * Math.sin((x - 0.29) * 9 + 2);

// Colour at unit-square point (x, y), or null for transparent.
function shade(x, y, maskable) {
  const roundBg = !maskable;
  if (roundBg && !inRoundRect(x, y, 0, 0, 1, 1, 0.22)) return null;
  let col = mix(C.bgTop, C.bgBot, y);
  // Content is shrunk on the maskable icon to stay inside the safe zone.
  const s = maskable ? 0.82 : 1;
  const u = (x - 0.5) / s + 0.5, v = (y - 0.5) / s + 0.5;
  if (inRoundRect(u - 0.015, v - 0.025, 0.2, 0.2, 0.8, 0.8, 0.05)) col = mix(col, C.shadow, 0.5);
  if (inRoundRect(u, v, 0.2, 0.2, 0.8, 0.8, 0.05)) {
    col = C.mount;
    if (inRoundRect(u, v, 0.29, 0.29, 0.71, 0.71, 0.015)) {
      col = mix(C.skyTop, C.skyBot, (v - 0.29) / 0.42);
      if ((u - 0.56) ** 2 + (v - 0.5) ** 2 < 0.07 ** 2) col = C.sun;
      if (v > hillY(u)) col = C.hill;
      if (v > hill2Y(u)) col = C.hill2;
    }
  }
  // Sparkle (astroid-shaped 4-point star).
  const dx = Math.abs(u - 0.78), dy = Math.abs(v - 0.23), r = 0.12;
  if (Math.sqrt(dx) + Math.sqrt(dy) < Math.sqrt(r)) col = C.gold;
  return col;
}

function png(size, maskable) {
  const SS = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const c = shade((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, maskable);
        if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = (a / (SS * SS)) * 255;
    }
  }
  return encodePng(size, size, raw);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function wavePath(fn, bottom) {
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const x = 0.29 + (0.42 * i) / 28;
    pts.push(`${(x * 512).toFixed(1)},${(fn(x) * 512).toFixed(1)}`);
  }
  return `M${pts.join(' L')} L${0.71 * 512},${bottom} L${0.29 * 512},${bottom} Z`;
}

function svg() {
  const k = 512, f = (v) => (v * k).toFixed(1);
  // Astroid sparkle via quadratic curves through the centre.
  const cx = 0.78 * k, cy = 0.23 * k, r = 0.12 * k;
  const star = `M${cx},${cy - r} Q${cx},${cy} ${cx + r},${cy} Q${cx},${cy} ${cx},${cy + r} Q${cx},${cy} ${cx - r},${cy} Q${cx},${cy} ${cx},${cy - r} Z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#24557f"/><stop offset="1" stop-color="#132a40"/></linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa9e6"/><stop offset="1" stop-color="#f7a35c"/></linearGradient>
    <clipPath id="win"><rect x="${f(0.29)}" y="${f(0.29)}" width="${f(0.42)}" height="${f(0.42)}" rx="${f(0.015)}"/></clipPath>
  </defs>
  <rect width="512" height="512" rx="${f(0.22)}" fill="url(#bg)"/>
  <rect x="${f(0.215)}" y="${f(0.225)}" width="${f(0.6)}" height="${f(0.6)}" rx="${f(0.05)}" fill="#0b1a28" opacity=".5"/>
  <rect x="${f(0.2)}" y="${f(0.2)}" width="${f(0.6)}" height="${f(0.6)}" rx="${f(0.05)}" fill="#f4efe4"/>
  <g clip-path="url(#win)">
    <rect x="${f(0.29)}" y="${f(0.29)}" width="${f(0.42)}" height="${f(0.42)}" fill="url(#sky)"/>
    <circle cx="${f(0.56)}" cy="${f(0.5)}" r="${f(0.07)}" fill="#ffe08a"/>
    <path d="${wavePath(hillY, f(0.72))}" fill="#3f8f4f"/>
    <path d="${wavePath(hill2Y, f(0.72))}" fill="#2f7040"/>
  </g>
  <path d="${star}" fill="#f5b942"/>
</svg>
`;
}

writeFileSync(new URL('icon-192.png', OUT), png(192, false));
writeFileSync(new URL('icon-512.png', OUT), png(512, false));
writeFileSync(new URL('maskable-512.png', OUT), png(512, true));
writeFileSync(new URL('icon.svg', OUT), svg());
console.log('Icons written to icons/');
