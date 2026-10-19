// App entry: screen switching and wiring the home buttons.

import { newPhoto } from './engine.js';
import { openEditor } from './editor.js';
import { initBatch, addPhotos, clearBatch, refreshItem } from './batch.js';
import { pickFiles } from './io.js';
import { startSession, addPhotos as keepPhotos, setEditing, endSession, restoreSession } from './session.js';

const screens = ['home', 'editor', 'batch'];

let updateReady = false;

function show(name) {
  // A new version was downloaded: switch to it when back on the home screen,
  // so no work in progress is lost.
  if (name === 'home' && updateReady) { location.reload(); return; }
  screens.forEach((s) => document.getElementById(s).classList.toggle('active', s === name));
}

async function goHome() {
  clearBatch();
  await endSession(); // finish before show() may reload for an update
  show('home');
}

function editOne(photo) {
  show('editor');
  openEditor(photo, { onBack: goHome });
}

function editInBatch(photo) {
  setEditing(photo);
  show('editor');
  openEditor(photo, {
    inBatch: true,
    onBack: () => { setEditing(null); show('batch'); refreshItem(photo); },
  });
}

document.getElementById('btn-one').addEventListener('click', async () => {
  const [file] = await pickFiles({ multiple: false });
  if (!file) return;
  const photo = newPhoto(file);
  startSession('one', [photo]);
  editOne(photo);
});

document.getElementById('btn-many').addEventListener('click', async () => {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  const photos = files.map(newPhoto);
  clearBatch();
  startSession('batch', photos);
  show('batch');
  addPhotos(photos);
});

document.getElementById('batch-add').addEventListener('click', async () => {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  const photos = files.map(newPhoto);
  keepPhotos(photos);
  addPhotos(photos);
});

initBatch({ onHome: goHome, onEdit: editInBatch });

// Carry on where things were left when the app was last closed.
restoreSession().then((s) => {
  if (!s) return;
  if (s.mode === 'one') { editOne(s.photos[0]); return; }
  show('batch');
  addPhotos(s.photos);
  if (s.editing) editInBatch(s.editing);
}).catch((err) => console.error(err));

// Updates: Android often just resumes an installed app instead of reloading
// it, so also check for a new version whenever the app comes back on screen.
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first install, nothing to update
    updateReady = true;
    if (document.getElementById('home').classList.contains('active')) location.reload();
  });
  window.addEventListener('load', async () => {
    const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  });
}
