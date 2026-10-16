// Talks to the processing worker and holds per-photo state helpers.

import { NEUTRAL_AUTO, ZERO_ADJ, rotate } from './processing/render.js';

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
    auto: null,       // computed Auto Fix settings
    useAuto: false,   // whether Auto Fix is switched on
    adj: { ...ZERO_ADJ },
    rot: 0,
    saved: false,
  };
}

// Settings the sliders are relative to: Auto Fix if on, otherwise "no change".
export function baseParams(photo) {
  if (photo.useAuto) return photo.auto;
  return { ...NEUTRAL_AUTO, sharpRadius: photo.auto.sharpRadius, sharpThreshold: photo.auto.sharpThreshold };
}

export function isEdited(photo) {
  return photo.useAuto || photo.rot % 4 !== 0 || Object.values(photo.adj).some((v) => v !== 0);
}

// Decode and analyse a photo at a given preview size. Returns a handle.
export async function prepare(photo, previewMax) {
  const key = keySeq++;
  const r = await call('prepare', { key, file: photo.file, previewMax, auto: photo.auto });
  photo.auto = r.auto;
  photo.fullWidth = r.fullWidth;
  photo.fullHeight = r.fullHeight;
  return { key, original: r.original };
}

export function renderPreview(handle, photo) {
  return call('render', { key: handle.key, base: baseParams(photo), adj: photo.adj, rot: photo.rot });
}

export function forget(handle) {
  if (handle) call('forget', { key: handle.key });
}

export function exportJpeg(photo, quality = 0.95) {
  return call('export', { file: photo.file, base: baseParams(photo), adj: photo.adj, rot: photo.rot, quality });
}

export function rotatedOriginal(original, rot) {
  const r = rotate(original, rot);
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
