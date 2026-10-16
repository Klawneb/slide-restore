import { describe, it, expect } from 'vitest';
import { analyze, lumaPlane, reblurRatio } from '../js/processing/analyze.js';
import { render, rotate, applyColor, resolveParams } from '../js/processing/render.js';
import { meanLab, histograms, percentile, rgbToLab } from '../js/processing/color.js';

const W = 240, H = 160;

// A varied "scene": neutral grey ramp, colour patches and sharp edges.
function scene() {
  const data = new Uint8ClampedArray(W * H * 4);
  const patches = [
    [200, 60, 50], [60, 160, 70], [60, 90, 190], [220, 180, 150], [120, 170, 220], [230, 210, 60],
  ];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let r, g, b;
    if (y < H / 2) {
      const v = Math.round((x / (W - 1)) * 235 + 10);
      r = g = b = v;
    } else {
      const p = patches[Math.floor((x / W) * patches.length)];
      const check = ((x >> 3) + (y >> 3)) & 1 ? 1 : 0.85;
      [r, g, b] = p.map((c) => c * check);
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { width: W, height: H, data };
}

function mapPixels(img, fn) {
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const [r, g, b] = fn(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255);
    out[i] = r * 255; out[i + 1] = g * 255; out[i + 2] = b * 255; out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

// Mean Lab colour of the neutral (top) half.
function greyHalfLab(img) {
  const top = { width: img.width, height: img.height / 2, data: img.data.slice(0, img.data.length / 2) };
  return meanLab(top);
}

function boxBlur(img, r) {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = [0, 0, 0], n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
      const j = (yy * w + xx) * 4;
      s[0] += data[j]; s[1] += data[j + 1]; s[2] += data[j + 2]; n++;
    }
    const i = (y * w + x) * 4;
    out[i] = s[0] / n; out[i + 1] = s[1] / n; out[i + 2] = s[2] / n; out[i + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

const casts = {
  blue: (r, g, b) => [r * 0.7 + 0.05, g * 0.85 + 0.08, b * 0.8 + 0.2],
  green: (r, g, b) => [r * 0.75 + 0.05, g * 0.8 + 0.2, b * 0.7 + 0.08],
  yellow: (r, g, b) => [r * 0.8 + 0.2, g * 0.8 + 0.17, b * 0.6 + 0.03],
};

describe('colour cast removal', () => {
  for (const [name, fn] of Object.entries(casts)) {
    it(`neutralises a ${name} cast`, () => {
      const cast = mapPixels(scene(), fn);
      const [, a0, b0] = greyHalfLab(cast);
      const fixed = render(cast, analyze(cast));
      const [, a1, b1] = greyHalfLab(fixed);
      expect(Math.hypot(a0, b0)).toBeGreaterThan(10);
      expect(Math.hypot(a1, b1)).toBeLessThan(3);
    });
  }

  it('does not wipe out a genuinely warm sunset', () => {
    const sunset = mapPixels(scene(), (r, g, b) => [Math.min(1, r * 0.6 + 0.4), g * 0.65 + 0.12, b * 0.35]);
    // Make it really sunset-like: almost no blue anywhere, warm everywhere.
    const fixed = render(sunset, analyze(sunset));
    const [, a, b] = meanLab(fixed);
    expect(b).toBeGreaterThan(8); // still warm/yellow-orange
    expect(a).toBeGreaterThan(-5);
  });
});

describe('tone', () => {
  it('stretches a faded, low-contrast image to the full range', () => {
    const faded = mapPixels(scene(), (r, g, b) => [0.35 + r * 0.35, 0.35 + g * 0.35, 0.35 + b * 0.35]);
    const fixed = render(faded, analyze(faded));
    const h = histograms(fixed);
    expect(percentile(h.l, 0.01)).toBeLessThan(20);
    expect(percentile(h.l, 0.99)).toBeGreaterThan(235);
  });

  it('brightens a dark image towards a mid-tone median', () => {
    const dark = mapPixels(scene(), (r, g, b) => [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)]);
    const before = percentile(histograms(dark).l, 0.5);
    const after = percentile(histograms(render(dark, analyze(dark))).l, 0.5);
    expect(before).toBeLessThan(70);
    expect(after).toBeGreaterThan(95);
    expect(after).toBeLessThan(150);
  });

  it('brightness slider moves the image lighter and darker', () => {
    const img = scene();
    const auto = analyze(img);
    const med = (adj) => percentile(histograms(render(img, auto, adj)).l, 0.5);
    expect(med({ brightness: 50 })).toBeGreaterThan(med({}) + 10);
    expect(med({ brightness: -50 })).toBeLessThan(med({}) - 10);
  });

  it('warmth slider shifts colour without clipping white', () => {
    const img = scene();
    const auto = analyze(img);
    const warm = applyColor(img, resolveParams(auto, { warmth: 60 }));
    const [, , b] = greyHalfLab(warm);
    expect(b).toBeGreaterThan(5);
    const brightest = (W - 1) * 4; // top-right pixel is near-white
    expect(warm.data[brightest]).toBeGreaterThan(245);
  });
});

describe('sharpening', () => {
  it('detects blur and restores edge detail', () => {
    const blurred = boxBlur(scene(), 2);
    const auto = analyze(blurred);
    expect(auto.sharpAmount).toBeGreaterThan(0.9);
    const ratio = (img) => reblurRatio(lumaPlane(img), img.width, img.height);
    const noSharpen = render(blurred, auto, { sharpness: -100 });
    const sharpened = render(blurred, auto);
    expect(ratio(sharpened)).toBeLessThan(ratio(noSharpen));
  });

  it('sharpens a crisp image only lightly', () => {
    expect(analyze(scene()).sharpAmount).toBeLessThan(0.7);
  });
});

describe('rotate', () => {
  it('rotates a quarter turn and back', () => {
    const img = scene();
    const r1 = rotate(img, 1);
    expect([r1.width, r1.height]).toEqual([H, W]);
    const back = rotate(r1, 3);
    expect(Array.from(back.data)).toEqual(Array.from(img.data));
  });
});

describe('helpers', () => {
  it('Lab of white and grey is neutral', () => {
    const [L, a, b] = rgbToLab(1, 1, 1);
    expect(L).toBeCloseTo(100, 0);
    expect(Math.abs(a) + Math.abs(b)).toBeLessThan(0.5);
  });
});
