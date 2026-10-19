// Keeps the work in progress on the tablet (in IndexedDB), so closing the app,
// or Android closing it in the background, doesn't lose it: the photos being
// worked on, their settings and undo history, and which one was open.
// The original files are copied in, since the picker's file may no longer be
// readable once the app has been closed.

import { newPhoto } from './engine.js';
import { toast } from './io.js';

let dbp = null;
let session = null;          // { mode: 'one' | 'batch', ids: [...], editing: id | null }
const photos = new Map();    // id -> photo, for the photos in the session
const dirty = new Set();     // photos whose settings need writing
let flushTimer = 0;
let seq = 0;
let warned = false;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('slide-restore', 1);
    req.onupgradeneeded = () => {
      ['meta', 'files', 'photos'].forEach((s) => req.result.createObjectStore(s));
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

// Run fn on the given stores in one transaction; resolves once it's written.
async function write(fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['meta', 'files', 'photos'], 'readwrite');
    fn(t.objectStore('meta'), t.objectStore('files'), t.objectStore('photos'));
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error);
  });
}

function failed(err) {
  console.error(err);
  if (warned) return;
  warned = true;
  toast('Not enough space to keep these photos if the app is closed');
}

const settings = ({ file, ...state }) => state;
const putMeta = (meta) => meta.put({ ...session }, 'session');

// Start a new session with these photos, replacing any earlier one.
export function startSession(mode, list) {
  photos.clear();
  dirty.clear();
  session = { mode, ids: [], editing: null };
  navigator.storage?.persist?.().catch(() => {});
  write((meta, files, store) => { meta.clear(); files.clear(); store.clear(); }).catch(failed);
  addPhotos(list);
}

export function addPhotos(list) {
  if (!session) return;
  list.forEach((p) => {
    p.id ??= `${Date.now().toString(36)}-${seq++}`;
    photos.set(p.id, p);
    session.ids.push(p.id);
  });
  write((meta, files, store) => {
    list.forEach((p) => { files.put(p.file, p.id); store.put(settings(p), p.id); });
    putMeta(meta);
  }).catch(failed);
}

export function removePhoto(photo) {
  if (!session || !photos.delete(photo.id)) return;
  dirty.delete(photo);
  session.ids = session.ids.filter((id) => id !== photo.id);
  write((meta, files, store) => { files.delete(photo.id); store.delete(photo.id); putMeta(meta); }).catch(failed);
}

// Which photo is open in the editor (null when none), to reopen it.
export function setEditing(photo) {
  if (!session) return;
  session.editing = photo?.id ?? null;
  write((meta) => putMeta(meta)).catch(failed);
}

// Note that a photo's settings have changed; written shortly after.
export function savePhoto(photo) {
  if (!photos.has(photo?.id)) return;
  dirty.add(photo);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 400);
}

function flush() {
  clearTimeout(flushTimer);
  if (!dirty.size) return;
  const list = [...dirty];
  dirty.clear();
  write((meta, files, store) => list.forEach((p) => store.put(settings(p), p.id))).catch(failed);
}

export function endSession() {
  session = null;
  photos.clear();
  dirty.clear();
  clearTimeout(flushTimer);
  return write((meta, files, store) => { meta.clear(); files.clear(); store.clear(); }).catch(failed);
}

// The session left from last time, if any: { mode, photos, editing }.
export async function restoreSession() {
  const d = await db();
  // All requests are made up front: a transaction closes once nothing is pending.
  const read = (keys) => {
    const t = d.transaction(['meta', 'files', 'photos'], 'readonly');
    return Promise.all(keys.map(([store, key]) => new Promise((resolve, reject) => {
      const r = t.objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    })));
  };
  const [meta] = await read([['meta', 'session']]);
  if (!meta?.ids.length) return null;
  const got = await read(meta.ids.flatMap((id) => [['files', id], ['photos', id]]));
  const list = [];
  for (let i = 0; i < got.length; i += 2) {
    const [file, state] = [got[i], got[i + 1]];
    if (file && state) list.push(Object.assign(newPhoto(file), state));
  }
  if (!list.length || session) return null; // (or something new was started meanwhile)
  session = { ...meta, ids: list.map((p) => p.id) };
  list.forEach((p) => photos.set(p.id, p));
  return { mode: meta.mode, photos: list, editing: list.find((p) => p.id === meta.editing) ?? null };
}

// Android may close a backgrounded app without warning: write now.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
window.addEventListener('pagehide', flush);
