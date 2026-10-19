import { describe, it, expect } from 'vitest';
import { analyze, lumaPlane, reblurRatio } from '../js/processing/analyze.js';
import { render, rotate, applyColor, resolveParams, neutralAdj, NEUTRAL_AUTO } from '../js/processing/render.js';
import { meanLab, histograms, percentile, rgbToLab } from '../js/processing/color.js';
import { detectCrop, cropImage, rotateCrop, transform } from '../js/processing/crop.js';
import { grainSigma } from '../js/processing/grain.js';

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
    expect(after).toBeGreaterThan(85);
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

describe('white balance picker', () => {
  const shown = (auto, adj, rgb) => [...applyColor({ width: 1, height: 1, data: Uint8ClampedArray.from([...rgb, 255]) }, resolveParams(auto, adj)).data].slice(0, 3);

  it('makes the picked colour come out grey', () => {
    for (const rgb of [[150, 140, 120], [120, 135, 160], [140, 155, 135], [200, 190, 205], [170, 120, 80], [60, 70, 95]]) {
      const adj = { brightness: 20, contrast: 10 };
      const { exact, ...pick } = neutralAdj(NEUTRAL_AUTO, adj, rgb);
      expect(exact).toBe(true);
      const [r, g, b] = shown(NEUTRAL_AUTO, { ...adj, ...pick }, rgb);
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
    }
  });

  it('works on top of Auto Fix and leaves the other sliders alone', () => {
    const cast = mapPixels(scene(), casts.yellow);
    const auto = analyze(cast);
    const adj = { brightness: -15, saturation: 30, warmth: 40 };
    const { exact, ...pick } = neutralAdj(auto, adj, [171, 163, 98]); // mid-grey under the cast
    expect(exact).toBe(true);
    const [r, g, b] = shown(auto, { ...adj, ...pick }, [171, 163, 98]);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
    expect(adj).toEqual({ brightness: -15, saturation: 30, warmth: 40 });
  });

  it('goes as far as it can on an extreme colour', () => {
    const res = neutralAdj(NEUTRAL_AUTO, {}, [230, 120, 10]);
    expect(res.exact).toBe(false);
    expect(res.pickWarmth).toBe(-300);
  });
});

describe('sharpening', () => {
  it('detects blur and restores edge detail', () => {
    const blurred = boxBlur(scene(), 2);
    const auto = analyze(blurred);
    expect(auto.sharpAmount).toBeGreaterThan(0.5);
    const ratio = (img) => reblurRatio(lumaPlane(img), img.width, img.height);
    const noSharpen = render(blurred, auto, { sharpness: -100 });
    const sharpened = render(blurred, auto);
    expect(ratio(sharpened)).toBeLessThan(ratio(noSharpen));
  });

  it('sharpens a crisp image only lightly', () => {
    expect(analyze(scene()).sharpAmount).toBeLessThan(0.35);
  });
});

describe('noise', () => {
  // Deterministic pseudo-random colour speckle, like film grain / JPEG noise.
  function speckled() {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    const img = scene();
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] += rand() * 40; img.data[i + 2] += rand() * 40;
    }
    return img;
  }
  // Average colour difference between neighbouring pixels in the grey half.
  function chromaSpeckle(img) {
    let s = 0, n = 0;
    for (let y = 0; y < img.height / 2; y++) for (let x = 1; x < img.width; x++) {
      const i = (y * img.width + x) * 4, j = i - 4;
      const c = (k) => img.data[k] - img.data[k + 1];
      s += Math.abs(c(i) - c(j)); n++;
    }
    return s / n;
  }

  it('smooths colour speckle instead of amplifying it', () => {
    const img = speckled();
    const fixed = render(img, analyze(img));
    expect(chromaSpeckle(fixed)).toBeLessThan(chromaSpeckle(img) * 0.6);
  });

  it('does not sharpen grain in deep shadows', () => {
    const img = speckled();
    const auto = { ...analyze(img), chromaRadius: 0 };
    const dark = mapPixels(img, (r, g, b) => [r * 0.12, g * 0.12, b * 0.12]);
    const a = render(dark, auto, { sharpness: -100 }), b = render(dark, auto, { sharpness: 100 });
    let diff = 0;
    for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i] - b.data[i]);
    expect(diff / a.data.length).toBeLessThan(0.5);
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

describe('auto crop', () => {
  const MW = 320, MH = 240, OX = 40, OY = 40, RIM = 3;
  // The test scene inside a slightly textured slide mount, with a dark film rim.
  function mounted(mount = [205, 188, 182], rim = [35, 28, 26]) {
    const pic = scene();
    const data = new Uint8ClampedArray(MW * MH * 4);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const i = (y * MW + x) * 4;
      const px = x - OX, py = y - OY;
      let c;
      if (px >= 0 && py >= 0 && px < W && py < H) {
        const inRim = px < RIM || py < RIM || px >= W - RIM || py >= H - RIM;
        c = inRim ? rim : Array.from(pic.data.subarray((py * W + px) * 4, (py * W + px) * 4 + 3));
      } else {
        const t = rand() * 10;
        c = mount.map((v) => v + t);
      }
      data.set([...c, 255], i);
    }
    return { width: MW, height: MH, data };
  }

  it('crops a slide mount and film rim down to the picture', () => {
    const c = detectCrop(mounted());
    expect(c).not.toBeNull();
    const px = [c.x0 * MW - OX, c.y0 * MH - OY, (1 - c.x1) * MW - (MW - OX - W), (1 - c.y1) * MH - (MH - OY - H)];
    for (const inset of px) {
      expect(inset).toBeGreaterThanOrEqual(RIM - 0.5); // rim removed
      expect(inset).toBeLessThan(RIM + 6); // not much picture lost
    }
  });

  it('crops a dark grey mount when the film rim shows inside it', () => {
    const c = detectCrop(mounted([60, 60, 64], [10, 8, 8]));
    expect(c).not.toBeNull();
    expect(c.x0 * MW - OX).toBeGreaterThanOrEqual(RIM - 0.5);
    expect(c.x0 * MW - OX).toBeLessThan(RIM + 6);
  });

  it('copes with uneven lighting, writing on the mount and a picture near one edge', () => {
    // Picture almost touching the left edge, a wide mount on the right with
    // blue writing that runs off the edge, lighting falling off to the right,
    // and no dark rim along the bottom (bright sky meets the mount directly).
    const PX = 4, PY = 50;
    const pic = scene();
    const data = new Uint8ClampedArray(MW * MH * 4);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const px = x - PX, py = y - PY;
      const light = 1 - 0.6 * (x / MW) * (y / MH); // darker towards bottom right
      let c;
      if (px >= 0 && py >= 0 && px < W && py < H) {
        const inRim = px < RIM || py < RIM || px >= W - RIM; // no rim along the bottom
        c = inRim ? [30, 26, 24] : py >= H - 12 ? [250, 250, 252] : Array.from(pic.data.subarray((py * W + px) * 4, (py * W + px) * 4 + 3));
      } else if (x > 268 && (Math.floor(y / 14) % 3 === 0) && y > 30 && y < 220) {
        c = [60, 140, 205].map((v) => v * light); // writing
      } else {
        c = [200, 198, 194].map((v) => v * light);
      }
      data.set([...c, 255], (y * MW + x) * 4);
    }
    const c = detectCrop({ width: MW, height: MH, data });
    expect(c).not.toBeNull();
    const left = c.x0 * MW - PX, top = c.y0 * MH - PY;
    const right = (PX + W) - c.x1 * MW, bottom = (PY + H) - c.y1 * MH;
    for (const inset of [left, top, right]) {
      expect(inset).toBeGreaterThanOrEqual(RIM - 0.5);
      expect(inset).toBeLessThan(RIM + 6);
    }
    expect(bottom).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThan(8);
  });

  it('leaves photos without a border alone', () => {
    expect(detectCrop(scene())).toBeNull();
    // Plain sky along one edge is picture, not a border.
    const sky = mapPixels(scene(), (r, g, b) => [r, g, b]);
    for (let i = 0; i < W * 40 * 4; i += 4) sky.data.set([150, 190, 235], i);
    expect(detectCrop(sky)).toBeNull();
    // Deep, smooth shadow round the edges is picture too.
    const shady = mapPixels(scene(), (r, g, b) => [r, g, b]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (x < 30 || y < 25 || x >= W - 30) shady.data.set([45, 36, 26], (y * W + x) * 4);
    }
    expect(detectCrop(shady)).toBeNull();
  });

  it('measures and straightens a crooked slide', () => {
    const tilted = transform(mounted(), 2, null); // picture turned 2° clockwise
    const c = detectCrop(tilted);
    expect(c).not.toBeNull();
    expect(c.angle).toBeGreaterThan(-2.4);
    expect(c.angle).toBeLessThan(-1.6);
    // Straightened and cropped, it's the picture again, rim-free.
    const fixed = transform(tilted, c.angle, c);
    expect(Math.abs(fixed.width - (W - 2 * RIM))).toBeLessThan(12);
    expect(Math.abs(fixed.height - (H - 2 * RIM))).toBeLessThan(12);
    expect(detectCrop(mounted()).angle).toBe(0);
  });

  it('rotates by small angles about the centre', () => {
    const img = scene();
    const back = transform(transform(img, 3, null), -3, null);
    let diff = 0, n = 0;
    for (let y = 40; y < H - 40; y++) for (let x = 40; x < W - 40; x++) {
      const p = (y * W + x) * 4;
      diff += Math.abs(back.data[p] - img.data[p]); n++;
    }
    expect(diff / n).toBeLessThan(6);
  });

  it('crops images and maps crops through rotation', () => {
    const c = { x0: 0.1, y0: 0.2, x1: 0.7, y1: 0.9 };
    const back = rotateCrop(rotateCrop(c, 1), -1);
    for (const k of Object.keys(c)) expect(back[k]).toBeCloseTo(c[k], 9);
    // Crop then rotate shows the same pixels as rotate then rotated crop.
    const img = scene();
    const a = rotate(cropImage(img, c), 1), b = cropImage(rotate(img, 1), rotateCrop(c, 1));
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe('dust removal', () => {
  // A smooth sky-like gradient with a few isolated specks, plus a patch of
  // clustered bright spots (like light through leaves) that must stay.
  function dusty() {
    const w = 400, h = 300, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = 150 + (x / w) * 50;
      data.set([v - 20, v, v + 30, 255], (y * w + x) * 4);
    }
    const dot = (cx, cy, rad, c) => {
      for (let y = cy - rad; y <= cy + rad; y++) for (let x = cx - rad; x <= cx + rad; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= rad * rad) data.set([c, c, c, 255], (y * w + x) * 4);
      }
    };
    const specks = [[60, 60, 1, 40], [200, 80, 2, 30], [120, 200, 1, 250], [320, 150, 1, 60]];
    for (const [x, y, rad, c] of specks) dot(x, y, rad, c);
    // Dark foliage with many small glints.
    for (let y = 200; y < 290; y++) for (let x = 250; x < 390; x++) data.set([20, 30, 15, 255], (y * w + x) * 4);
    const glints = [];
    for (let gy = 208; gy < 285; gy += 11) for (let gx = 258; gx < 385; gx += 13) { dot(gx, gy, 1, 230); glints.push([gx, gy]); }
    return { img: { width: w, height: h, data }, specks, glints };
  }
  const lum = (img, x, y) => { const p = (y * img.width + x) * 4; return 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2]; };

  it('removes isolated specks on smooth areas and keeps clustered texture', () => {
    const { img, specks, glints } = dusty();
    const before = { ...img, data: new Uint8ClampedArray(img.data) };
    const out = render(img, { ...NEUTRAL_AUTO, dust: true }, {});
    for (const [x, y] of specks) {
      const bg = lum(before, x + 8, y);
      expect(Math.abs(lum(out, x, y) - bg)).toBeLessThan(10);
    }
    for (const [x, y] of glints) expect(lum(out, x, y)).toBeGreaterThan(150);
  });

  it('leaves photos alone when switched off', () => {
    const { img } = dusty();
    const a = render(img, { ...NEUTRAL_AUTO, dust: false }, {});
    let diff = 0;
    for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i] - img.data[i]) > 1) diff++;
    expect(diff).toBe(0);
  });
});

describe('grain smoothing', () => {
  // Left half: flat grey with grain. Right half: sharp black/white stripes.
  function grainy(seed = 1) {
    const w = 256, h = 192, data = new Uint8ClampedArray(w * h * 4);
    let s = seed;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = x < w / 2 ? 128 + rnd() * 10 : ((x >> 2) & 1 ? 220 : 40);
      data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
    }
    return { width: w, height: h, data };
  }
  const sd = (img, x0, x1) => {
    let s = 0, s2 = 0, n = 0;
    for (let y = 8; y < img.height - 8; y++) for (let x = x0; x < x1; x++) {
      const v = img.data[(y * img.width + x) * 4 + 1]; s += v; s2 += v * v; n++;
    }
    return Math.sqrt(s2 / n - (s / n) ** 2);
  };
  const auto = { ...NEUTRAL_AUTO, noise: 5, noiseLong: 256 };

  it('smooths grain on flat areas but keeps edges', () => {
    const img = grainy();
    const out = render(img, { ...auto, grain: 0.6 }, {});
    expect(sd(out, 8, 120)).toBeLessThan(sd(img, 8, 120) * 0.6);
    // Stripes keep their full contrast.
    expect(Math.abs(sd(out, 136, 248) - sd(img, 136, 248))).toBeLessThan(3);
  });

  it('does nothing when off, and the slider can switch it off or on', () => {
    const img = grainy();
    const off = render(img, { ...auto, grain: 0 }, {});
    expect(sd(off, 8, 120)).toBeCloseTo(sd(img, 8, 120), 0);
    const down = render(img, { ...auto, grain: 0.6 }, { grain: -100 });
    expect(sd(down, 8, 120)).toBeCloseTo(sd(img, 8, 120), 0);
    const up = render(img, { ...auto, grain: 0 }, { grain: 100 });
    expect(sd(up, 8, 120)).toBeLessThan(sd(img, 8, 120) * 0.6);
  });

  it('measures grain in flat areas and ignores busy pictures', () => {
    const img = grainy();
    const L = lumaPlane(img);
    expect(grainSigma(L, img.width, img.height)).toBeGreaterThan(3);
    // Stripes only: no flat areas, so no grain measured.
    const busy = new Uint8Array(256 * 192).map((_, j) => ((j % 256) >> 2) & 1 ? 220 : 40);
    expect(grainSigma(busy, 256, 192)).toBe(0);
  });

  it('analyze turns grain smoothing on for grainy photos only', () => {
    expect(analyze(grainy()).grain).toBeGreaterThan(0.3);
    expect(analyze(scene()).grain).toBe(0);
  });
});
