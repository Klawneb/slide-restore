// Talks to the processing worker and holds per-photo state helpers.

import { NEUTRAL_AUTO, ZERO_ADJ, rotate } from './processing/render.js';
import { applyCrop, isFullCrop } from './processing/crop.js';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let nextId = 1;

worker.onmessage = (e) => {
  const { id, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};

function call(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
}

let keySeq = 1;

export function newPhoto(file) {
  return {
    file,
    name: file.name || 'photo.jpg',
    autos: {},        // Auto Fix settings, per crop (see cropKey)
    autoCrop: undefined, // detected slide-mount crop; null if none, undefined until looked for
    crop: null,       // current crop rectangle and straightening angle (of the unrotated photo), null = whole
    dust: false,      // remove dust specks
    useAuto: false,   // whether Auto Fix is switched on
    adj: { ...ZERO_ADJ },
    rot: 0,
    heals: [],        // spot healing strokes (see processing/heal.js), in order
    saved: false,
  };
}

const cropKey = (c) => (isFullCrop(c) ? 'full' : [c.x0, c.y0, c.x1, c.y1, c.angle || 0].map((v) => v.toFixed(4)).join(','));

export const autoParams = (photo) => photo.autos[cropKey(photo.crop)];

// Settings the sliders are relative to: Auto Fix if on, otherwise "no change".
export function baseParams(photo) {
  const auto = autoParams(photo);
  if (photo.useAuto) return { ...auto, dust: photo.dust };
  return { ...NEUTRAL_AUTO, sharpRadius: auto.sharpRadius, sharpThreshold: auto.sharpThreshold, dust: photo.dust };
}

export function isEdited(photo) {
  return photo.useAuto || photo.dust || photo.rot % 4 !== 0 || !isFullCrop(photo.crop) || photo.heals.length > 0
    || Object.values(photo.adj).some((v) => v !== 0);
}

// Decode and analyse a photo at a given preview size. Returns a handle.
// Auto Fix settings are worked out for the current crop and the auto crop,
// so switching Auto Fix on later is instant.
export async function prepare(photo, previewMax) {
  const key = keySeq++;
  const detect = photo.autoCrop === undefined;
  const want = new Map();
  for (const c of [photo.crop, detect ? 'auto' : photo.autoCrop]) {
    const k = c === 'auto' ? 'auto' : cropKey(c);
    if (!photo.autos[k]) want.set(k, c);
  }
  const r = await call('prepare', { key, file: photo.file, previewMax, detect, crops: [...want.values()] });
  if (detect) photo.autoCrop = r.autoCrop ?? null;
  for (const { crop, auto } of r.autos) photo.autos[cropKey(crop)] = auto;
  photo.fullWidth = r.fullWidth;
  photo.fullHeight = r.fullHeight;
  return { key, original: r.original };
}

// Change the crop, working out Auto Fix settings for it if needed.
export async function setCrop(photo, crop) {
  photo.crop = isFullCrop(crop) ? null : crop;
  const k = cropKey(photo.crop);
  if (!photo.autos[k]) photo.autos[k] = await call('analyze', { file: photo.file, crop: photo.crop });
}

export function renderPreview(handle, photo) {
  return call('render', { key: handle.key, base: baseParams(photo), adj: photo.adj, rot: photo.rot, crop: photo.crop, heals: photo.heals });
}

// The whole photo (ignoring the crop, but straightened by angle), for the crop screen.
export function renderUncropped(handle, photo, angle = 0) {
  const crop = angle ? { x0: 0, y0: 0, x1: 1, y1: 1, angle } : null;
  return call('render', { key: handle.key, base: baseParams(photo), adj: photo.adj, rot: photo.rot, crop, heals: photo.heals });
}

// Full-resolution render of part of the photo as shown (region in 0..1).
export function renderDetail(handle, photo, region) {
  return call('detail', { key: handle.key, file: photo.file, base: baseParams(photo), adj: photo.adj, rot: photo.rot, crop: photo.crop, heals: photo.heals, region });
}

// Where a new heal stroke should take its patch from: { dx, dy }.
export function findHealSource(handle, photo, stroke) {
  return call('healSource', { key: handle.key, heals: photo.heals, stroke });
}

export function forget(handle) {
  if (handle) call('forget', { key: handle.key });
}

export function exportJpeg(photo, quality = 0.95) {
  return call('export', { file: photo.file, base: baseParams(photo), adj: photo.adj, rot: photo.rot, crop: photo.crop, heals: photo.heals, quality });
}

export function rotatedOriginal(original, rot, crop = null) {
  const r = rotate(applyCrop(original, crop), rot);
  return r === original ? original : new ImageData(r.data, r.width, r.height);
}

// Runs the latest requested job only, dropping stale ones (for live sliders).
export function latestOnly(fn) {
  let running = false, queued = null;
  return function run(...args) {
    queued = args;
    if (running) return;
    running = true;
    (async () => {
      while (queued) {
        const a = queued; queued = null;
        try { await fn(...a); } catch (err) { console.error(err); }
      }
      running = false;
    })();
  };
}
