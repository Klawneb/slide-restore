// Single-photo editor: Auto Fix, sliders, before/after, crop and straighten,
// rotate, dust removal, zoom, save.

import {
  prepare, renderPreview, renderUncropped, renderDetail, setCrop, forget, exportJpeg, rotatedOriginal, latestOnly,
} from './engine.js';
import { ZERO_ADJ } from './processing/render.js';
import { FULL_CROP, rotateCrop } from './processing/crop.js';
import { restoredName, saveBlob, canShareFiles, shareFiles, toast, busy, friendlyError } from './io.js';

const $ = (id) => document.getElementById(id);
const frame = $('frame');
const cvAfter = $('cv-after');
const cvBefore = $('cv-before');
const cvDetail = $('cv-detail');
const splitLine = $('split-line');
const autoBtn = $('btn-auto');
const editor = $('editor');
const cropBox = $('crop-box');
const angleSlider = $('crop-angle');
const sliders = [...document.querySelectorAll('#sliders input[type=range]')];

let photo = null;
let handle = null;
let original = null;
let split = 0.5;
let onClose = null;
let cropRect = null; // while cropping: the rectangle as shown (after rotation)
let cropAngle = 0; // while cropping: the straightening angle being tried

function previewSize() {
  const r = frame.getBoundingClientRect();
  const longest = Math.max(r.width, r.height, 800) * Math.min(devicePixelRatio || 1, 2);
  return Math.round(Math.min(1600, longest));
}

const refresh = latestOnly(async () => {
  if (!handle) return;
  const h = handle;
  const img = await (cropRect ? renderUncropped(h, photo, cropAngle) : renderPreview(h, photo));
  if (h !== handle) return; // photo changed meanwhile
  cvAfter.width = img.width; cvAfter.height = img.height;
  cvAfter.getContext('2d').putImageData(img, 0, 0);
  drawBefore();
  layoutOverlay();
  layoutCrop();
  requestDetail();
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
  sliders.forEach((s) => { s.value = photo.adj[s.dataset.adj]; showValue(s); });
  autoBtn.classList.toggle('on', photo.useAuto);
  autoBtn.querySelector('use').setAttribute('href', photo.useAuto ? '#i-check' : '#i-auto');
  autoBtn.querySelector('.auto-label').textContent = photo.useAuto ? 'Auto Fix is on' : 'Auto Fix';
  $('btn-dust').setAttribute('aria-pressed', String(photo.dust));
}

// The number beside each slider name: 0 in the middle, +/- either side.
function showValue(slider) {
  const out = slider.closest('.slider').querySelector('.s-val');
  const v = Number(slider.value);
  out.textContent = v > 0 ? `+${v}` : String(v);
  out.classList.toggle('changed', v !== 0);
}

export async function openEditor(p, { inBatch = false, onBack } = {}) {
  photo = p;
  onClose = onBack;
  $('btn-done').hidden = !inBatch;
  $('btn-save').hidden = inBatch;
  $('btn-share').hidden = inBatch || !canShareFiles();
  $('photo-name').textContent = photo.name;
  endCropMode();
  resetZoom();
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
  photo.dust = true;
  photo.adj = { ...ZERO_ADJ };
  await withBusy(() => setCrop(photo, photo.autoCrop));
  resetZoom();
  syncControls();
  changed();
  const a = photo.autoCrop;
  toast(!a ? 'Auto Fix applied'
    : a.angle ? 'Auto Fix applied, border cropped off and picture straightened'
      : 'Auto Fix applied, slide border cropped off');
});

// Shows the spinner only if the work takes a noticeable time.
async function withBusy(fn) {
  const t = setTimeout(() => busy('Working…'), 150);
  try { return await fn(); } finally { clearTimeout(t); busy(false); }
}

sliders.forEach((s) => {
  s.addEventListener('input', () => {
    photo.adj[s.dataset.adj] = Number(s.value);
    showValue(s);
    changed();
  });
  // Double-tap a slider to centre it.
  s.addEventListener('dblclick', () => {
    s.value = 0;
    photo.adj[s.dataset.adj] = 0;
    showValue(s);
    changed();
  });
});

$('btn-reset').addEventListener('click', async () => {
  photo.useAuto = false;
  photo.dust = false;
  photo.adj = { ...ZERO_ADJ };
  photo.rot = 0;
  await withBusy(() => setCrop(photo, null));
  resetZoom();
  syncControls();
  changed();
  toast('Back to the original');
});

$('btn-rotate').addEventListener('click', () => {
  photo.rot = (photo.rot + 1) % 4;
  resetZoom();
  changed();
});

$('btn-dust').addEventListener('click', () => {
  photo.dust = !photo.dust;
  syncControls();
  changed();
  toast(photo.dust ? 'Removing dust specks' : 'Dust removal off');
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
  const a = cvAfter.getBoundingClientRect();
  split = Math.min(1, Math.max(0, (e.clientX - a.left) / a.width));
  layoutOverlay();
}

window.addEventListener('resize', () => {
  if (!handle) return;
  resetZoom();
  layoutOverlay();
  layoutCrop();
});

// ---------- Zoom ----------
// Pinch (or double-tap, or the mouse wheel) to zoom; drag to look around.
// While moving, the screen-sized preview is simply enlarged; once still, the
// part on screen is rendered from the full-resolution scan so true detail
// (sharpness, grain, dust) can be judged.

const zoom = { s: 1, tx: 0, ty: 0 };
const pointers = new Map();
let gesture = null;
let lastTap = { t: 0, x: 0, y: 0 };

function maxZoom() {
  // Up to twice the scan's own resolution on screen.
  if (!photo?.fullWidth) return 4;
  const c = photo.crop ?? FULL_CROP;
  const w = photo.fullWidth * (c.x1 - c.x0), h = photo.fullHeight * (c.y1 - c.y0);
  const across = photo.rot % 2 ? h : w; // scan pixels across the picture as shown
  const shown = (cvAfter.offsetWidth || 1) * Math.min(devicePixelRatio || 1, 2);
  return Math.min(10, Math.max(2, (across / shown) * 2));
}

function applyZoom() {
  const w = cvAfter.offsetWidth, h = cvAfter.offsetHeight;
  const fw = frame.clientWidth, fh = frame.clientHeight;
  zoom.s = Math.min(maxZoom(), Math.max(1, zoom.s));
  const limX = Math.max(0, (w * zoom.s - fw) / 2), limY = Math.max(0, (h * zoom.s - fh) / 2);
  zoom.tx = Math.min(limX, Math.max(-limX, zoom.tx));
  zoom.ty = Math.min(limY, Math.max(-limY, zoom.ty));
  if (zoom.s <= 1.001) { zoom.s = 1; zoom.tx = 0; zoom.ty = 0; }
  cvAfter.style.transform = zoom.s === 1 ? '' : `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.s})`;
  frame.classList.toggle('zoomed', zoom.s > 1);
  $('zoom-out').hidden = zoom.s === 1;
  layoutOverlay();
}

function resetZoom() {
  zoom.s = 1; zoom.tx = 0; zoom.ty = 0;
  cvDetail.classList.remove('ready');
  applyZoom();
}

// Zoom by factor k keeping the point (px, py) (client coordinates) still.
function zoomAt(k, px, py) {
  const f = frame.getBoundingClientRect();
  const cx = px - (f.left + f.width / 2), cy = py - (f.top + f.height / 2);
  const s1 = Math.min(maxZoom(), Math.max(1, zoom.s * k));
  const r = s1 / zoom.s;
  zoom.tx = cx - (cx - zoom.tx) * r;
  zoom.ty = cy - (cy - zoom.ty) * r;
  zoom.s = s1;
  applyZoom();
}

// Ask for full-resolution detail of what's on screen, once things are still.
let detailTimer = 0, detailSeq = 0;
function requestDetail() {
  clearTimeout(detailTimer);
  cvDetail.classList.remove('ready');
  if (zoom.s <= 1 || cropRect || !handle) return;
  detailTimer = setTimeout(async () => {
    const f = frame.getBoundingClientRect(), a = cvAfter.getBoundingClientRect();
    const vx0 = Math.max(f.left, a.left), vx1 = Math.min(f.right, a.right);
    const vy0 = Math.max(f.top, a.top), vy1 = Math.min(f.bottom, a.bottom);
    if (vx1 <= vx0 || vy1 <= vy0) return;
    // Only worth it once the preview's own pixels are being enlarged.
    if (a.width * Math.min(devicePixelRatio || 1, 2) < cvAfter.width * 1.15) return;
    const region = {
      x0: (vx0 - a.left) / a.width, x1: (vx1 - a.left) / a.width,
      y0: (vy0 - a.top) / a.height, y1: (vy1 - a.top) / a.height,
    };
    const seq = ++detailSeq, h = handle, s = { ...zoom };
    try {
      const img = await renderDetail(h, photo, region);
      if (seq !== detailSeq || h !== handle || s.s !== zoom.s || s.tx !== zoom.tx || s.ty !== zoom.ty) return;
      cvDetail.width = img.width; cvDetail.height = img.height;
      cvDetail.getContext('2d').putImageData(img, 0, 0);
      Object.assign(cvDetail.style, {
        left: `${vx0 - f.left}px`, top: `${vy0 - f.top}px`,
        width: `${vx1 - vx0}px`, height: `${vy1 - vy0}px`,
      });
      cvDetail.classList.add('ready');
    } catch (err) {
      console.error(err);
    }
  }, 250);
}

frame.addEventListener('pointerdown', (e) => {
  if (cropRect) return;
  frame.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [p, q] = [...pointers.values()];
    gesture = { type: 'pinch', d: Math.hypot(p.x - q.x, p.y - q.y), mx: (p.x + q.x) / 2, my: (p.y + q.y) / 2 };
    cvDetail.classList.remove('ready');
    return;
  }
  // Double-tap: zoom in to that spot, or back out.
  const now = Date.now();
  if (now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap.t = 0;
    if (zoom.s > 1) resetZoom(); else { zoomAt(3, e.clientX, e.clientY); requestDetail(); }
    gesture = null;
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (frame.classList.contains('split')) { gesture = { type: 'split' }; dragSplit(e); }
  else if (zoom.s > 1) { gesture = { type: 'pan', x: e.clientX, y: e.clientY }; cvDetail.classList.remove('ready'); }
  else gesture = null;
});

frame.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture?.type === 'pinch' && pointers.size >= 2) {
    const [p, q] = [...pointers.values()];
    const d = Math.hypot(p.x - q.x, p.y - q.y), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    zoom.tx += mx - gesture.mx; zoom.ty += my - gesture.my; // two-finger drag
    zoomAt(d / Math.max(1, gesture.d), mx, my);
    Object.assign(gesture, { d, mx, my });
  } else if (gesture?.type === 'pan') {
    zoom.tx += e.clientX - gesture.x; zoom.ty += e.clientY - gesture.y;
    gesture.x = e.clientX; gesture.y = e.clientY;
    applyZoom();
  } else if (gesture?.type === 'split') {
    dragSplit(e);
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pointers.size === 0) {
    if (gesture?.type === 'pinch' || gesture?.type === 'pan') requestDetail();
    gesture = null;
  } else if (gesture?.type === 'pinch') {
    // One finger lifted: carry on as a pan with the other.
    const [p] = [...pointers.values()];
    gesture = { type: 'pan', x: p.x, y: p.y };
  }
}
['pointerup', 'pointercancel'].forEach((t) => frame.addEventListener(t, endPointer));

frame.addEventListener('wheel', (e) => {
  if (cropRect) return;
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  requestDetail();
}, { passive: false });

$('zoom-out').addEventListener('pointerdown', (e) => e.stopPropagation());
$('zoom-out').addEventListener('click', resetZoom);

// ---------- Crop and straighten ----------
// The whole photo is shown with a box over it; drag its corners or edges to
// resize it, or drag inside it to move it. The slider straightens it.

const MIN_CROP = 0.1;

function startCropMode() {
  resetZoom();
  frame.classList.remove('split', 'show-before');
  $('btn-compare').setAttribute('aria-pressed', 'false');
  cropRect = rotateCrop(photo.crop ?? FULL_CROP, photo.rot);
  setCropAngle(photo.crop?.angle || 0);
  editor.classList.add('cropping');
  refresh();
}

function endCropMode() {
  cropRect = null;
  editor.classList.remove('cropping');
}

function setCropAngle(a) {
  cropAngle = Math.round(a * 10) / 10;
  angleSlider.value = cropAngle;
  const out = $('angle-val');
  out.textContent = `${cropAngle > 0 ? '+' : ''}${cropAngle}°`;
  out.classList.toggle('changed', cropAngle !== 0);
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

angleSlider.addEventListener('input', () => {
  setCropAngle(Number(angleSlider.value));
  refresh();
});
angleSlider.addEventListener('dblclick', () => {
  setCropAngle(0);
  refresh();
});

$('btn-crop').addEventListener('click', startCropMode);

$('crop-auto').addEventListener('click', () => {
  if (!photo.autoCrop) { toast('No slide border found on this photo'); return; }
  cropRect = rotateCrop(photo.autoCrop, photo.rot);
  setCropAngle(photo.autoCrop.angle || 0);
  refresh();
});

$('crop-none').addEventListener('click', () => {
  cropRect = { ...FULL_CROP };
  setCropAngle(0);
  refresh();
});

$('crop-cancel').addEventListener('click', () => {
  endCropMode();
  refresh();
});

$('crop-done').addEventListener('click', async () => {
  const { x0, y0, x1, y1 } = rotateCrop(cropRect, -photo.rot);
  const c = cropAngle ? { x0, y0, x1, y1, angle: cropAngle } : { x0, y0, x1, y1 };
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
    toast('Saved to your Downloads');
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
