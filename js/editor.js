// Single-photo editor: Auto Fix, sliders, before/after, rotate, save.

import { prepare, renderPreview, forget, exportJpeg, rotatedOriginal, latestOnly } from './engine.js';
import { ZERO_ADJ } from './processing/render.js';
import { restoredName, saveBlob, canShareFiles, shareFiles, toast, busy, friendlyError } from './io.js';

const $ = (id) => document.getElementById(id);
const frame = $('frame');
const cvAfter = $('cv-after');
const cvBefore = $('cv-before');
const splitLine = $('split-line');
const autoBtn = $('btn-auto');
const sliders = [...document.querySelectorAll('#sliders input[type=range]')];

let photo = null;
let handle = null;
let original = null;
let split = 0.5;
let onClose = null;

function previewSize() {
  const r = frame.getBoundingClientRect();
  const longest = Math.max(r.width, r.height, 800) * Math.min(devicePixelRatio || 1, 2);
  return Math.round(Math.min(1600, longest));
}

const refresh = latestOnly(async () => {
  if (!handle) return;
  const h = handle;
  const img = await renderPreview(h, photo);
  if (h !== handle) return; // photo changed meanwhile
  cvAfter.width = img.width; cvAfter.height = img.height;
  cvAfter.getContext('2d').putImageData(img, 0, 0);
  drawBefore();
  layoutOverlay();
});

function drawBefore() {
  const img = rotatedOriginal(original, photo.rot);
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

autoBtn.addEventListener('click', () => {
  photo.useAuto = true;
  photo.adj = { ...ZERO_ADJ };
  syncControls();
  changed();
  toast('✨ Auto Fix applied');
});

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

$('btn-reset').addEventListener('click', () => {
  photo.useAuto = false;
  photo.adj = { ...ZERO_ADJ };
  photo.rot = 0;
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
frame.addEventListener('pointerdown', (e) => { frame.setPointerCapture(e.pointerId); dragSplit(e); });
frame.addEventListener('pointermove', (e) => { if (e.buttons) dragSplit(e); });

window.addEventListener('resize', () => { if (handle) layoutOverlay(); });

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
