# Slide Restore

A simple installable app for fixing scanned photo slides: faded colours, blue/green/yellow
colour casts, wrong brightness/contrast and softness. Everything runs on the tablet –
photos are never uploaded anywhere.

## Using it
- **Fix a Photo** → pick a photo → tap **✨ Auto Fix** → nudge the sliders if needed → **💾 Save**.
- **Fix Many Photos** → pick several → **✨ Auto Fix All** → **💾 Save All**. Tap any photo to fine-tune it.
- Saved photos go to the tablet's **Downloads** folder as `<name>_restored.jpg` (originals are never changed).
- **Hold to see original** shows the before; **↔ Compare** gives a draggable before/after split.
- Auto Fix also **crops off the slide mount** (the cardboard/plastic border and dark film edge), **straightens**
  slides that sit crooked, and **removes dust specks**.
  If the crop is wrong, tap **Crop** and drag the corners or edges (or drag inside the box to move it), use the
  **Straighten** slider if needed, then **Done**. **Auto crop** puts the detected crop back; **Whole photo** removes it.
  **Remove dust** switches dust removal on or off.
- **Zoom**: pinch the photo (or double-tap it) to look closely; drag to move around. When you stop moving, the part
  on screen is shown at the scan's full resolution. **Zoom out** (or double-tap again) goes back.
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
Push changes, and bump `VERSION` in `sw.js` every time (that is what tells installed copies to update).
The app checks for updates whenever it is opened or brought back on screen, and switches to the new version as soon as it is on the home screen (never in the middle of editing).

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
0. Border crop and straighten (`crop.js`) – if at least two edges of the scan show a light, smooth mount, work in from each side (in three sections, so tilted slides work) until the line stops being mount – the film's dark rim, or the picture itself – then skip the rim. Copes with uneven lighting, writing on the mount and pictures that nearly touch an edge. The film edge's slope on each side gives the tilt; the picture is straightened and the crop measured again. Colour/tone analysis then runs on the picture only.
1. Per-channel levels stretch – removes fading and most colour casts (damped when a channel would need an extreme stretch, e.g. real sunsets).
2. Mid-tone neutralisation – greyish mid-tones pulled towards true grey, with strength reduced for strong (probably genuine) casts.
3. Brightness – gamma moves the median brightness towards a pleasant mid-tone.
4. Contrast – brightness range stretch plus a gentle S-curve if still flat.
5. Colour strength – vibrance boost for washed-out images.
6. Sharpening – blur is measured on a full-resolution centre crop; unsharp mask on brightness only, with a grain-aware threshold.
7. Shadows – if removing a strong cast (e.g. warm lamplight indoors) has pushed the shadows past neutral, they're pulled back.

Dust removal (`dust.js`): small spots much lighter or darker than their surroundings (found by morphological
opening/closing), only where the surroundings are smooth and the spots are sparse – so foliage and sparkle are left alone.

Note: Chrome can't open TIFF files, so scans need to be saved as JPEG (or PNG).
