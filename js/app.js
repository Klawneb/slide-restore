// App entry: screen switching and wiring the home buttons.

import { newPhoto } from './engine.js';
import { openEditor } from './editor.js';
import { initBatch, addFiles, clearBatch, refreshItem } from './batch.js';
import { pickFiles } from './io.js';

const screens = ['home', 'editor', 'batch'];

function show(name) {
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

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js'));
}
