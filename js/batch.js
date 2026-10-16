// Batch screen: many photos, Auto Fix All, Save All.

import { newPhoto, prepare, renderPreview, forget, exportJpeg, isEdited, setCrop } from './engine.js';
import { restoredName, saveBlob, canShareFiles, shareFiles, toast, friendlyError, sleep } from './io.js';

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const THUMB = 360;

let items = []; // { photo, tile, canvas, handle, error }
let running = false;
let callbacks = {};

export function initBatch({ onEdit, onHome }) {
  callbacks = { onEdit, onHome };
}

export async function addFiles(files) {
  const added = files.map((file) => ({ photo: newPhoto(file) }));
  items.push(...added);
  added.forEach(makeTile);
  updateTitle();
  // Decode thumbnails one at a time to keep memory low on the tablet.
  for (const it of added) {
    try {
      it.handle = await prepare(it.photo, THUMB);
      await drawThumb(it);
    } catch (err) {
      console.error(err);
      it.error = true;
      setBadge(it);
    }
  }
}

export function clearBatch() {
  items.forEach((it) => forget(it.handle));
  items = [];
  grid.replaceChildren();
}

export async function refreshItem(photo) {
  const it = items.find((i) => i.photo === photo);
  if (it) await drawThumb(it);
}

function makeTile(it) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.setAttribute('role', 'button');
  tile.innerHTML = '<div class="spinner"></div><span class="badge"></span>';
  const rm = document.createElement('button');
  rm.className = 'remove';
  rm.innerHTML = '<svg class="i"><use href="#i-close"/></svg>';
  rm.setAttribute('aria-label', 'Remove from list');
  rm.addEventListener('click', (e) => {
    e.stopPropagation();
    if (running) return;
    forget(it.handle);
    items = items.filter((i) => i !== it);
    tile.remove();
    updateTitle();
  });
  tile.appendChild(rm);
  tile.addEventListener('click', () => {
    if (running || !it.handle || it.error) return;
    callbacks.onEdit(it.photo);
  });
  it.tile = tile;
  grid.appendChild(tile);
}

async function drawThumb(it) {
  const img = await renderPreview(it.handle, it.photo);
  if (!it.canvas) {
    it.canvas = document.createElement('canvas');
    it.tile.querySelector('.spinner')?.remove();
    it.tile.prepend(it.canvas);
  }
  it.canvas.width = img.width; it.canvas.height = img.height;
  it.canvas.getContext('2d').putImageData(img, 0, 0);
  setBadge(it);
}

function setBadge(it) {
  const b = it.tile.querySelector('.badge');
  const p = it.photo;
  b.className = 'badge';
  if (it.error) { b.textContent = "Can't open"; b.classList.add('error'); it.tile.querySelector('.spinner')?.remove(); }
  else if (p.saved) { b.textContent = 'Saved'; b.classList.add('saved'); }
  else if (isEdited(p)) { b.textContent = 'Fixed'; b.classList.add('fixed'); }
  else b.textContent = 'Original';
}

function updateTitle() {
  $('batch-title').textContent = items.length === 1 ? '1 photo' : `${items.length} photos`;
}

function usable() {
  return items.filter((i) => i.handle && !i.error);
}

function progress(done, total, label) {
  const box = $('progress');
  if (total === 0 || done === null) { box.hidden = true; return; }
  box.hidden = false;
  $('progress-bar').style.width = `${(done / total) * 100}%`;
  $('progress-text').textContent = `${label} ${done} of ${total}`;
}

function lock(on) {
  running = on;
  ['batch-auto', 'batch-save', 'batch-share', 'batch-add', 'batch-back'].forEach((id) => { $(id).disabled = on; });
}

$('batch-auto').addEventListener('click', async () => {
  const list = usable();
  if (!list.length) return;
  lock(true);
  for (let i = 0; i < list.length; i++) {
    progress(i, list.length, 'Fixing');
    const it = list[i];
    if (!it.photo.useAuto) {
      it.photo.useAuto = true;
      it.photo.dust = true;
      it.photo.saved = false;
      try { await setCrop(it.photo, it.photo.autoCrop); } catch (err) { console.error(err); }
    }
    await drawThumb(it);
  }
  progress(null);
  lock(false);
  toast(`Fixed ${list.length} photo${list.length > 1 ? 's' : ''}`);
});

async function exportAll(label, each) {
  const list = usable().filter((i) => !i.photo.saved);
  if (!list.length) { toast('All photos are already saved'); return; }
  lock(true);
  let ok = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      progress(i, list.length, label);
      try {
        await each(list[i], await exportJpeg(list[i].photo));
        ok++;
      } catch (err) {
        console.error(err);
        toast(friendlyError(err));
      }
    }
  } finally {
    progress(null);
    lock(false);
  }
  return ok;
}

$('batch-save').addEventListener('click', async () => {
  const ok = await exportAll('Saving', async (it, blob) => {
    saveBlob(blob, restoredName(it.photo.name));
    it.photo.saved = true;
    setBadge(it);
    await sleep(350); // give the browser a moment between downloads
  });
  if (ok) toast(`Saved ${ok} photo${ok > 1 ? 's' : ''} to your Downloads`);
});

if (canShareFiles()) {
  $('batch-share').hidden = false;
  $('batch-share').addEventListener('click', async () => {
    const files = [];
    const done = [];
    await exportAll('Preparing', async (it, blob) => {
      files.push(new File([blob], restoredName(it.photo.name), { type: 'image/jpeg' }));
      done.push(it);
    });
    if (!files.length) return;
    try {
      if (await shareFiles(files)) {
        done.forEach((it) => { it.photo.saved = true; setBadge(it); });
      }
    } catch (err) {
      console.error(err);
      toast('Too many photos to share at once – try Save All instead.');
    }
  });
}

$('batch-back').addEventListener('click', () => {
  const unsaved = usable().some((i) => isEdited(i.photo) && !i.photo.saved);
  if (unsaved && !confirm('Some fixed photos have not been saved yet. Leave anyway?')) return;
  callbacks.onHome();
});
