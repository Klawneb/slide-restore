# Slide Restore

A simple installable app for fixing scanned photo slides: faded colours, blue/green/yellow
colour casts, wrong brightness/contrast and softness. Everything runs on the tablet –
photos are never uploaded anywhere.

## Using it
- **Fix a Photo** → pick a photo → tap **✨ Auto Fix** → nudge the sliders if needed → **💾 Save**.
- **Fix Many Photos** → pick several → **✨ Auto Fix All** → **💾 Save All**. Tap any photo to fine-tune it.
- Saved photos go to the tablet's **Downloads** folder as `<name>_restored.jpg` (originals are never changed).
- **Hold to see original** shows the before; **↔ Compare** gives a draggable before/after split.
- Auto Fix also **crops off the slide mount** (the cardboard/plastic border and dark film edge) when the scan shows it.
  If it gets it wrong, tap **✂️ Crop** and drag the corners or edges (or drag inside the box to move it), then **✓ Done**.
  **✨ Auto crop** puts the detected crop back; **⬜ Whole photo** removes the crop.
- Double-tap a slider to centre it again. **↺ Start again** undoes everything.

## Installing on the Android tablet
1. Open the app's web address (see *Hosting* below) in **Chrome** on the tablet.
2. Tap the **⋮** menu → **Install app** (or **Add to Home screen** → Install).
3. A **Slide Restore** icon appears on the home screen. It opens full-screen and works offline.

## Hosting (GitHub Pages, free)
1. Create a GitHub repo and push this folder to it.
2. Repo **Settings → Pages** → Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
3. The app will be at `https://<username>.github.io/<repo>/`.

### Updating
Push changes, and bump `VERSION` in `sw.js` (needed when files are added/renamed).
The tablet picks up the new version the next time the app is opened (sometimes the time after).

## Development
```
npm install
npm test          # unit tests for the restoration pipeline
npm run serve     # http://localhost:5173
npm run icons     # regenerate icons from scripts/make-icons.mjs
npm run try -- out/ scan.jpg ...     # before/after comparisons of Auto Fix
npm run crops -- out/ scan.jpg ...   # draws the detected border crop on each scan
```

### How Auto Fix works (`js/processing/`)
0. Border crop (`crop.js`) – if the scan's edges show an even-coloured mount, work in from each side past the mount and the film's dark rim. Colour/tone analysis then runs on the picture only.
1. Per-channel levels stretch – removes fading and most colour casts (damped when a channel would need an extreme stretch, e.g. real sunsets).
2. Mid-tone neutralisation – greyish mid-tones pulled towards true grey, with strength reduced for strong (probably genuine) casts.
3. Brightness – gamma moves the median brightness towards a pleasant mid-tone.
4. Contrast – brightness range stretch plus a gentle S-curve if still flat.
5. Colour strength – vibrance boost for washed-out images.
6. Sharpening – blur is measured on a full-resolution centre crop; unsharp mask on brightness only, with a grain-aware threshold.

Note: Chrome can't open TIFF files, so scans need to be saved as JPEG (or PNG).
