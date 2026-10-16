// Single-photo editor: Auto Fix, sliders, before/after, crop, rotate, save.

import { prepare, renderPreview, renderUncropped, setCrop, forget, exportJpeg, rotatedOriginal, latestOnly } from './engine.js';
import { ZERO_ADJ } from './processing/render.js';
import { FULL_CROP, rotateCrop } from './processing/crop.js';
import { restoredName, saveBlob, canShareFiles, shareFiles, toast, busy, friendlyError } from './io.js';

const $ = (id) => document.getElementById(id);
const frame = $('frame');
const cvAfter = $('cv-after');
const cvBefore = $('cv-before');
const splitLine = $('split-line');
const autoBtn = $('btn-auto');
const editor = $('editor');
const cropBox = $('crop-box');
const sliders = [...document.querySelectorAll('#sliders input[type=range]')];

let photo = null;
let handle = null;
let original = null;
let split = 0.5;
let onClose = null;
let cropRect = null; // while cropping: the rectangle as shown (after rotation)

function previewSize() {
  const r = frame.getBoundingClientRect();
  const longest = Math.max(r.width, r.height, 800) * Math.min(devicePixelRatio || 1, 2);
  return Math.round(Math.min(1600, longest));
}

const refresh = latestOnly(async () => {
  if (!handle) return;
  const h = handle;
  const img = await (cropRect ? renderUncropped : renderPreview)(h, photo);
  if (h !== handle) return; // photo changed meanwhile
  cvAfter.width = img.width; cvAfter.height = img.height;
  cvAfter.getContext('2d').putImageData(img, 0, 0);
  drawBefore();
  layoutOverlay();
  layoutCrop();
});

function drawBefore() {
  const img = rotatedOriginal(original, photo.rot, photo.crop);
  cvBefore.width = img.width; cvBefore.height = img.height;
  cvBefore.getContext('2d').putImageData(img, 0, 0);
}

// Keep the "before" canvas exactly on top of the "after" one.
function layoutOverlay() {
  const f = frame.getBoundingClientRect();
  const a = cvAfter.getBoundingClientRect();
  Object.assign(cvBefore.style, {
    left: `${a.left - f.left}px`, top: `${a.top - f.top}px`,
    width: `${a.width}px`, height: `${a.height}px`,
  });
  cvBefore.style.clipPath = frame.classList.contains('split')
    ? `inset(0 ${(1 - split) * 100}% 0 0)` : '';
  splitLine.style.left = `${a.left - f.left + a.width * split}px`;
  splitLine.style.top = `${a.top - f.top}px`;
  splitLine.style.bottom = 'auto';
  splitLine.style.height = `${a.height}px`;
  Object.assign($('tag-before').style, { left: `${a.left - f.left}px`, top: `${a.top - f.top}px` });
  Object.assign($('tag-after').style, { left: `${a.right - f.left}px`, top: `${a.top - f.top}px`, transform: 'translateX(-100%)' });
}

function syncControls() {
  sliders.forEach((s) => { s.value = photo.adj[s.dataset.adj]; });
  autoBtn.classList.toggle('on', photo.useAuto);
  autoBtn.classList.toggle('pulse', !photo.useAuto);
  autoBtn.textContent = photo.useAuto ? '✨ Auto Fix is on' : '✨ Auto Fix';
}

export async function openEditor(p, { inBatch = false, onBack } = {}) {
  photo = p;
  onClose = onBack;
  $('btn-done').hidden = !inBatch;
  $('btn-save').hidden = inBatch;
  $('btn-share').hidden = inBatch || !canShareFiles();
  endCropMode();
  frame.classList.remove('split', 'show-before');
  $('btn-compare').setAttribute('aria-pressed', 'false');
  const ctx = cvAfter.getContext('2d');
  ctx.clearRect(0, 0, cvAfter.width, cvAfter.height);
  syncControls();
  busy('Opening photo…');
  try {
    forget(handle);
    handle = null;
    const h = await prepare(photo, previewSize());
    handle = h;
    original = h.original;
    syncControls();
    refresh();
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
    close();
  } finally {
    busy(false);
  }
}

function close() {
  forget(handle);
  handle = null;
  onClose?.();
}

function changed() {
  photo.saved = false;
  refresh();
}

autoBtn.addEventListener('click', async () => {
  photo.useAuto = true;
  photo.adj = { ...ZERO_ADJ };
  await withBusy(() => setCrop(photo, photo.autoCrop));
  syncControls();
  changed();
  toast(photo.autoCrop ? '✨ Auto Fix applied – slide border cropped off' : '✨ Auto Fix applied');
});

// Shows the spinner only if the work takes a noticeable time.
async function withBusy(fn) {
  const t = setTimeout(() => busy('Working…'), 150);
  try { return await fn(); } finally { clearTimeout(t); busy(false); }
}

sliders.forEach((s) => {
  s.addEventListener('input', () => {
    photo.adj[s.dataset.adj] = Number(s.value);
    changed();
  });
  // Double-tap a slider to centre it.
  s.addEventListener('dblclick', () => {
    s.value = 0;
    photo.adj[s.dataset.adj] = 0;
    changed();
  });
});

$('btn-reset').addEventListener('click', async () => {
  photo.useAuto = false;
  photo.adj = { ...ZERO_ADJ };
  photo.rot = 0;
  await withBusy(() => setCrop(photo, null));
  syncControls();
  changed();
  toast('Back to the original');
});

$('btn-rotate').addEventListener('click', () => {
  photo.rot = (photo.rot + 1) % 4;
  changed();
});

$('btn-back').addEventListener('click', close);
$('btn-done').addEventListener('click', close);

// Hold to see the original.
const hold = $('btn-hold');
const showBefore = (on) => frame.classList.toggle('show-before', on);
hold.addEventListener('pointerdown', (e) => { hold.setPointerCapture(e.pointerId); showBefore(true); });
['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => hold.addEventListener(t, () => showBefore(false)));
hold.addEventListener('contextmenu', (e) => e.preventDefault());

// Side-by-side split comparison, draggable.
$('btn-compare').addEventListener('click', (e) => {
  const on = !frame.classList.contains('split');
  frame.classList.toggle('split', on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
  split = 0.5;
  layoutOverlay();
});
function dragSplit(e) {
  if (!frame.classList.contains('split')) return;
  const a = cvAfter.getBoundingClientRect();
  split = Math.min(1, Math.max(0, (e.clientX - a.left) / a.width));
  layoutOverlay();
}
frame.addEventListener('pointerdown', (e) => {
  if (cropRect) return;
  frame.setPointerCapture(e.pointerId);
  dragSplit(e);
});
frame.addEventListener('pointermove', (e) => { if (e.buttons) dragSplit(e); });

window.addEventListener('resize', () => { if (handle) { layoutOverlay(); layoutCrop(); } });

// ---------- Crop ----------
// The whole photo is shown with a box over it; drag its corners or edges to
// resize it, or drag inside it to move it.

const MIN_CROP = 0.1;

function startCropMode() {
  frame.classList.remove('split', 'show-before');
  $('btn-compare').setAttribute('aria-pressed', 'false');
  cropRect = rotateCrop(photo.crop ?? FULL_CROP, photo.rot);
  editor.classList.add('cropping');
  refresh();
}

function endCropMode() {
  cropRect = null;
  editor.classList.remove('cropping');
}

function layoutCrop() {
  if (!cropRect) return;
  const f = frame.getBoundingClientRect();
  const a = cvAfter.getBoundingClientRect();
  Object.assign(cropBox.style, {
    left: `${a.left - f.left + cropRect.x0 * a.width}px`,
    top: `${a.top - f.top + cropRect.y0 * a.height}px`,
    width: `${(cropRect.x1 - cropRect.x0) * a.width}px`,
    height: `${(cropRect.y1 - cropRect.y0) * a.height}px`,
  });
}

let drag = null;
cropBox.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  cropBox.setPointerCapture(e.pointerId);
  drag = { handle: e.target.dataset.h || 'move', x: e.clientX, y: e.clientY, start: { ...cropRect } };
});
cropBox.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const a = cvAfter.getBoundingClientRect();
  const dx = (e.clientX - drag.x) / a.width, dy = (e.clientY - drag.y) / a.height;
  const s = drag.start, h = drag.handle, r = { ...s };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (h === 'move') {
    const mx = clamp(dx, -s.x0, 1 - s.x1), my = clamp(dy, -s.y0, 1 - s.y1);
    r.x0 = s.x0 + mx; r.x1 = s.x1 + mx; r.y0 = s.y0 + my; r.y1 = s.y1 + my;
  } else {
    if (h.includes('l')) r.x0 = clamp(s.x0 + dx, 0, s.x1 - MIN_CROP);
    if (h.includes('r')) r.x1 = clamp(s.x1 + dx, s.x0 + MIN_CROP, 1);
    if (h.includes('t')) r.y0 = clamp(s.y0 + dy, 0, s.y1 - MIN_CROP);
    if (h.includes('b')) r.y1 = clamp(s.y1 + dy, s.y0 + MIN_CROP, 1);
  }
  cropRect = r;
  layoutCrop();
});
['pointerup', 'pointercancel'].forEach((t) => cropBox.addEventListener(t, () => { drag = null; }));

$('btn-crop').addEventListener('click', startCropMode);

$('crop-auto').addEventListener('click', () => {
  if (!photo.autoCrop) { toast('No slide border found on this photo'); return; }
  cropRect = rotateCrop(photo.autoCrop, photo.rot);
  layoutCrop();
});

$('crop-none').addEventListener('click', () => {
  cropRect = { ...FULL_CROP };
  layoutCrop();
});

$('crop-done').addEventListener('click', async () => {
  const c = rotateCrop(cropRect, -photo.rot);
  try {
    await withBusy(() => setCrop(photo, c));
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
  endCropMode();
  changed();
});

async function makeJpeg() {
  busy('Saving full-size photo…');
  try {
    return await exportJpeg(photo);
  } finally {
    busy(false);
  }
}

$('btn-save').addEventListener('click', async () => {
  try {
    const blob = await makeJpeg();
    saveBlob(blob, restoredName(photo.name));
    photo.saved = true;
    toast('Saved ✓  (in your Downloads)');
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
});

$('btn-share').addEventListener('click', async () => {
  try {
    const blob = await makeJpeg();
    const file = new File([blob], restoredName(photo.name), { type: 'image/jpeg' });
    if (await shareFiles([file])) photo.saved = true;
  } catch (err) {
    console.error(err);
    toast(friendlyError(err));
  }
});
