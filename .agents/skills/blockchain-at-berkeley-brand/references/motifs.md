# B@B Signature Motifs — the cookbook

The charisma of the brand comes from these textures. Build them from here.
**Use 1–2 per page** (the hairline grid is always on; add one hero texture plus
mono data chrome). Every snippet is self-contained and uses the `--bab-*` tokens
from `brand.css`.

---

## 1. Hairline grid / ledger frame (always on)

The skeleton. Vertical rules at the content margins + divided cells.

```html
<div class="bab-container">
  <div class="bab-frame">           <!-- vertical hairlines left & right -->
    <section style="padding: 92px var(--bab-pad);">…</section>
    <hr class="bab-rule">
    <div class="bab-cells" style="grid-template-columns: repeat(3, 1fr);">
      <div class="bab-cell">…</div>
      <div class="bab-cell">…</div>
      <div class="bab-cell">…</div>
    </div>
  </div>
</div>
```

Optional: a faint full-page column grid overlay (very subtle, decorative):

```css
.bab-grid-overlay {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background-image: repeating-linear-gradient(
    to right, transparent 0, transparent calc(8.333% - 1px),
    var(--bab-line-soft) calc(8.333% - 1px), var(--bab-line-soft) 8.333%);
  opacity: 0.35;
  -webkit-mask-image: linear-gradient(black, transparent 70%);
  mask-image: linear-gradient(black, transparent 70%);
}
```

---

## 2. Transaction-hash field ★ (the most B@B texture)

Ambient rows of hex, mostly near-invisible, with **rare** gold glints. Renders
the chain itself. Put it behind a hero or footer at low contrast, then lay
content on top.

```html
<div class="bab-hashfield" aria-hidden="true"></div>
```
```css
.bab-hashfield {
  position: absolute; inset: 0; overflow: hidden; z-index: 0;
  font-family: var(--bab-mono); font-size: 12px; line-height: 1.35;
  letter-spacing: var(--bab-track);
  color: var(--bab-text-faint);
  white-space: pre; user-select: none; pointer-events: none;
  -webkit-mask-image: radial-gradient(120% 80% at 50% 0%, black, transparent 75%);
  mask-image: radial-gradient(120% 80% at 50% 0%, black, transparent 75%);
}
.bab-hashfield b { color: var(--bab-amber-deep); font-weight: 400; } /* warm dark */
.bab-hashfield i { color: var(--bab-gold-warm); font-style: normal; } /* rare glint */
```
```js
// Fill with rows of hex; ~2% of chars become warm, ~0.4% become a gold glint.
(function fillHashField(el = document.querySelector('.bab-hashfield')) {
  if (!el) return;
  const hex = '0123456789abcdef';
  const cols = Math.ceil(el.offsetWidth / 7.6);   // ~7.6px per mono char at 12px
  const rows = Math.ceil(el.offsetHeight / 16);
  let out = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = hex[(Math.random() * 16) | 0];
      const roll = Math.random();
      out += roll < 0.004 ? `<i>${ch}</i>` : roll < 0.025 ? `<b>${ch}</b>` : ch;
    }
    out += '\n';
  }
  el.innerHTML = out;
})();
```

Slow life (optional): every ~600ms, flip a handful of random chars to gold and
back. Keep it *sparse* — this is ambient, not a screensaver. Freeze it under
`prefers-reduced-motion`.

**Variant — full "wall of hashes" hero** (like the source's dense field): drop
the mask, raise base color to `--bab-amber-deep`, and let a big Garamond line or
dithered image sit on top with a subtle black scrim behind the text.

### Hash portrait ★★ (the shipped showstopper)

Modulate the hash field by an image so the hex **resolves into a subject** — a
portrait, the logo, a map — visible only as brighter/denser characters. This is
the hero texture on the live B@B site (a person built from transaction hashes).

Render on a canvas: sample a grayscale source image per character-cell; draw a
random hex glyph whose brightness (and gold-glint odds) track the image's
luminance there.

```js
function hashPortrait(canvas, srcImg, { cell = 12, font = '12px "IBM Plex Mono"' } = {}) {
  const ctx = canvas.getContext('2d');
  const cols = Math.floor(canvas.width / (cell * 0.62));   // mono advance ≈ 0.62em
  const rows = Math.floor(canvas.height / cell);
  // sample the image down to cols×rows luminance
  const s = document.createElement('canvas'); s.width = cols; s.height = rows;
  const sctx = s.getContext('2d');
  sctx.drawImage(srcImg, 0, 0, cols, rows);
  const lum = sctx.getImageData(0, 0, cols, rows).data;
  const hex = '0123456789abcdef';
  ctx.font = font; ctx.textBaseline = 'top';
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = (y * cols + x) * 4;
    const b = (0.299*lum[i] + 0.587*lum[i+1] + 0.114*lum[i+2]) / 255; // 0..1
    if (b < 0.06 && Math.random() > 0.5) continue;          // near-black stays empty
    const ch = hex[(Math.random() * 16) | 0];
    // brightness → alpha; brightest cells rarely glint gold
    if (b > 0.7 && Math.random() < 0.10)      ctx.fillStyle = 'rgba(244,179,32,0.95)'; // gold-warm
    else if (b > 0.45)                        ctx.fillStyle = `rgba(255,255,255,${0.15 + b*0.55})`;
    else                                      ctx.fillStyle = `rgba(164,62,4,${0.25 + b*0.5})`;   // amber-deep
    ctx.fillText(ch, x * cell * 0.62, y * cell);
  }
}
// usage: const img = new Image(); img.onload = () => hashPortrait(cv, img); img.src = 'portrait.jpg';
```

Tips: feed it a high-contrast grayscale image (a bust/portrait works best); keep
the subject to one side and let the field thin out into ambient hashes elsewhere,
so it reads as texture that *happens* to cohere. Redraw a few cells per second for
a subtle "live ledger" shimmer. Freeze under `prefers-reduced-motion`.

---

## 3. Dithered / 1-bit imagery ★ (no full-color photos, ever)

All photography becomes monochrome + dithered. Two routes:

**A. Pre-process the asset** (best quality). Convert to grayscale 1-bit with
Floyd–Steinberg or Atkinson dithering, export PNG on black, then:
```html
<img src="portrait-dithered.png" alt="" class="bab-img-mono">
```
ImageMagick one-liner to generate the asset:
```bash
magick input.jpg -colorspace Gray -dither FloydSteinberg -remap pattern:gray50 dithered.png
# ordered/halftone dot look:
magick input.jpg -colorspace Gray -ordered-dither h8x8a halftone.png
```

**B. Live canvas dither** (no asset pipeline). Draw an image to canvas, threshold
each pixel with ordered-dither, paint white dots on transparent:

```js
function ditherToCanvas(img, canvas, scale = 3) {
  const w = Math.floor(img.width / scale), h = Math.floor(img.height / scale);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h), p = d.data;
  const bayer = [ [0,8,2,10],[12,4,14,6],[3,11,1,9],[15,7,13,5] ]; // 4x4 ordered
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const lum = 0.299*p[i] + 0.587*p[i+1] + 0.114*p[i+2];
    const on = lum / 255 > (bayer[y & 3][x & 3] + 0.5) / 16;
    p[i] = p[i+1] = p[i+2] = 255;
    p[i+3] = on ? 255 : 0;            // transparent where "off" → canvas shows through
  }
  ctx.putImageData(d, 0, 0);
  canvas.style.imageRendering = 'pixelated'; // keep dots crisp when scaled up
}
```
Render the canvas larger than its pixel size with `image-rendering: pixelated`
for the chunky dot-matrix look (the source's world map).

---

## 4. ASCII imagery

Photo/logo → ASCII glyphs in DM Mono, dim gold on black. Great for a portrait,
a logo reveal, or a loading state.

```js
function imageToAscii(img, cols = 120) {
  const ramp = " .:-=+*#%@";                 // dark → light
  const ratio = 0.5;                          // char aspect compensation
  const rows = Math.floor(cols * (img.height / img.width) * ratio);
  const cv = document.createElement('canvas');
  cv.width = cols; cv.height = rows;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, cols, rows);
  const p = ctx.getImageData(0, 0, cols, rows).data;
  let out = '';
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      const lum = (0.299*p[i] + 0.587*p[i+1] + 0.114*p[i+2]) / 255;
      out += ramp[Math.min(ramp.length - 1, (lum * ramp.length) | 0)];
    }
    out += '\n';
  }
  return out; // drop into <pre class="bab-ascii">
}
```
```css
.bab-ascii {
  font-family: var(--bab-mono); font-size: 9px; line-height: 1;
  letter-spacing: 0; color: var(--bab-gold-warm); opacity: 0.85;
  white-space: pre; background: var(--bab-black-true);
}
```

---

## 5. Halftone dots (SVG, resolution-independent)

A crisp dot-halftone fill for panels, maps, or dividers.

```html
<svg width="100%" height="240" aria-hidden="true">
  <defs>
    <pattern id="halftone" width="10" height="10" patternUnits="userSpaceOnUse">
      <circle cx="5" cy="5" r="1.6" fill="var(--bab-text-mute)"/>
    </pattern>
  </defs>
  <rect width="100%" height="100%" fill="url(#halftone)"/>
</svg>
```
Vary `r` across the field (or use a radial-gradient mask over the `<rect>`) to
fake tonal gradients. Turn a handful of circles `--bab-gold-warm` for glints.

---

## 6. Monospace data chrome

The small precise details that sell the "ledger" story.

```html
<!-- index numbers -->
<span class="bab-index">01</span> — <span class="bab-index">02</span> — <span class="bab-index">03</span>

<!-- truncated wallet-style address, live one turns gold -->
<span class="bab-mono">0xF4B3…0A0A</span>

<!-- metadata row -->
<div class="bab-label">EST. 2016 · BERKELEY, CA · <span class="bab-gold">● LIVE</span></div>
```

Use for: section indices, timestamps, block/counter numbers, addresses, status
dots (`●` gold = live), tags. Keep at `--bab-text-mute`; promote exactly one
element to gold when it represents a live/active/hover signal.

---

## Discipline

- Grid is always on. Add **one** hero texture (hash-field **or** dither **or**
  ASCII) + mono data chrome. Not all of them.
- Textures live at `z-index: 0`; content sits above with room to breathe.
- Every texture is monochrome except its **rare** gold glints.
- Freeze all texture animation under `prefers-reduced-motion`.
