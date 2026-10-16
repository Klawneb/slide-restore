// Picking, saving and sharing files, plus small UI feedback helpers.

export function pickFiles({ multiple }) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export function restoredName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  return `${base}_restored.jpg`;
}

export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles() {
  try {
    const f = new File([new Blob()], 'x.jpg', { type: 'image/jpeg' });
    return !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch {
    return false;
  }
}

export async function shareFiles(files) {
  try {
    await navigator.share({ files });
    return true;
  } catch (err) {
    if (err.name === 'AbortError') return false; // user closed the share sheet
    throw err;
  }
}

let toastTimer;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

export function busy(message) {
  const el = document.getElementById('busy');
  if (message === false) { el.hidden = true; return; }
  el.querySelector('.busy-text').textContent = message || 'Working…';
  el.hidden = false;
}

export function friendlyError(err) {
  if (err?.message === 'UNSUPPORTED') {
    return "Sorry, that file couldn't be opened. Try saving the scan as a JPEG.";
  }
  return 'Something went wrong. Please try again.';
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
