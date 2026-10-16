// App entry: screen switching and wiring the home buttons.

import { newPhoto } from './engine.js';
import { openEditor } from './editor.js';
import { initBatch, addFiles, clearBatch, refreshItem } from './batch.js';
import { pickFiles } from './io.js';

const screens = ['home', 'editor', 'batch'];

let updateReady = false;

function show(name) {
  // A new version was downloaded: switch to it when back on the home screen,
  // so no work in progress is lost.
  if (name === 'home' && updateReady) { location.reload(); return; }
  screens.forEach((s) => document.getElementById(s).classList.toggle('active', s === name));
}

function goHome() {
  clearBatch();
  show('home');
}

document.getElementById('btn-one').addEventListener('click', async () => {
  const [file] = await pickFiles({ multiple: false });
  if (!file) return;
  show('editor');
  openEditor(newPhoto(file), { onBack: () => show('home') });
});

document.getElementById('btn-many').addEventListener('click', async () => {
  const files = await pickFiles({ multiple: true });
  if (!files.length) return;
  clearBatch();
  show('batch');
  addFiles(files);
});

document.getElementById('batch-add').addEventListener('click', async () => {
  const files = await pickFiles({ multiple: true });
  if (files.length) addFiles(files);
});

initBatch({
  onHome: goHome,
  onEdit(photo) {
    show('editor');
    openEditor(photo, {
      inBatch: true,
      onBack: () => { show('batch'); refreshItem(photo); },
    });
  },
});

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
