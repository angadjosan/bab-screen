# B@B Component Recipes

In-identity patterns. All use `--bab-*` tokens / `.bab-*` classes from
`brand.css`. Adapt structure freely — keep the identity fixed.

---

## Navbar

Hairline bottom rule, wordmark left, mono links, one gold CTA.

Shipped pattern: gold cube logo left; uppercase Instrument Sans links; the
**"Apply →" link is gold** (the nav's one accent), not a filled button.

```html
<header style="border-bottom: 1px solid var(--bab-line-soft);">
  <div class="bab-container" style="display:flex; align-items:center; justify-content:space-between; height:72px;">
    <a href="/" aria-label="Blockchain at Berkeley" style="display:flex; height:32px;">
      <img src="assets/blockchain_icon.svg" alt="" style="height:100%; width:auto;"> <!-- gold recycling-triad mark -->
    </a>
    <nav style="display:flex; gap:36px; align-items:center; text-transform:uppercase;">
      <a class="bab-small" href="#about"  style="text-decoration:none; color:var(--bab-text-dim);">About</a>
      <a class="bab-small" href="#work"   style="text-decoration:none; color:var(--bab-text-dim);">Work</a>
      <a class="bab-small" href="#courses" style="text-decoration:none; color:var(--bab-text-dim);">Courses</a>
      <a class="bab-small" href="#depts"  style="text-decoration:none; color:var(--bab-text-dim);">Departments ⌄</a>
      <a class="bab-small bab-gold" href="#apply" style="text-decoration:none;">Apply →</a>
    </nav>
  </div>
</header>
```

Links are uppercase Instrument Sans ~14px at `--bab-text-dim`; "Apply →" is gold
with a trailing arrow. Alternate wordmark: "Blockchain at Berkeley" set in
Instrument Sans 500, or a mono lockup with a single gold `@`.

---

## Hero (editorial + one texture)

Mono eyebrow → giant Garamond line → Instrument lead → mono metadata, over a
hash-field or dithered image.

```html
<section class="bab-frame" style="position:relative; padding:clamp(60px,10vw,138px) var(--bab-pad);">
  <div class="bab-hashfield" aria-hidden="true"></div>
  <div style="position:relative; z-index:1; max-width:16ch;">
    <span class="bab-eyebrow">Berkeley · Est. 2016</span>
    <h1 class="bab-display-xl">The future is on chain.</h1>
    <p class="bab-lead bab-dim" style="max-width:52ch; margin-top:var(--bab-row);">
      We're Berkeley's blockchain engineering, research, and education group.
      We're looking for the next thing to build.
    </p>
    <div style="display:flex; flex-direction:column; max-width:280px; margin-top:var(--bab-row);">
      <a class="bab-btn" href="#">Apply to join</a>          <!-- white, trailing → -->
      <a class="bab-btn bab-btn-ghost" href="#">Learn more</a><!-- ghost, trailing → -->
    </div>
  </div>
</section>
```

Rules: exactly one oversized Garamond line; keep it under ~16ch so it wraps big;
one gold CTA max.

---

## Bordered cell grid (features / departments / stats)

Shared hairline borders, mono index + label, Garamond or Instrument content.

```html
<div class="bab-cells" style="grid-template-columns: repeat(3, 1fr); border-top:1px solid var(--bab-line-soft);">
  <article class="bab-cell" style="min-height:260px; display:flex; flex-direction:column; justify-content:space-between;">
    <span class="bab-index">01</span>
    <div>
      <h3 class="bab-display-s" style="margin:0 0 12px;">On-chain consulting</h3>
      <p class="bab-small">Prototype research and production engineering for teams shipping real protocols.</p>
    </div>
  </article>
  <!-- 02, 03 … -->
</div>
```

### Stats band (shipped pattern)

Big **Instrument Sans Light** numbers over mono uppercase labels, in bordered
cells. Promote at most one number to gold.

```html
<div class="bab-cells cells-4" style="grid-template-columns:repeat(4,1fr); border-top:1px solid var(--bab-line-soft);">
  <div class="bab-cell"><div class="bab-stat">5,000<span class="bab-gold">+</span></div><div class="bab-stat-label">Members</div></div>
  <div class="bab-cell"><div class="bab-stat">$1B+</div><div class="bab-stat-label">Assets advised</div></div>
  <div class="bab-cell"><div class="bab-stat">9</div><div class="bab-stat-label">Years active</div></div>
  <div class="bab-cell"><div class="bab-stat">40+</div><div class="bab-stat-label">Projects</div></div>
</div>
```
Numbers often count up on scroll (start at `0`). Keep the label mono; keep the
number Light and tight (`.bab-stat` handles this).

---

## Buttons

```html
<a class="bab-btn" href="#">Apply to join</a>              <!-- PRIMARY: solid white, black text, → -->
<a class="bab-btn bab-btn-ghost" href="#">Learn more</a>    <!-- SECONDARY: ghost, dim text, hairline top -->
<a class="bab-btn bab-btn-outline" href="#">Read the report</a> <!-- TERTIARY: hairline box, gold on hover -->
```
Square corners, Instrument Sans 500, trailing `→`. The primary is **white, never
gold** — gold lives on the logo and the nav "Apply". Often the primary+secondary
stack full-width in a narrow column (see hero).

---

## Pull quote / statement block

Let a Garamond line *be* the section.

```html
<section class="bab-frame" style="padding:clamp(80px,12vw,160px) var(--bab-pad);">
  <p class="bab-display-l" style="max-width:20ch;">
    Members have shipped for Samsung and Arbitrum, and modeled consensus attacks for Ripple.
  </p>
  <div class="bab-label" style="margin-top:var(--bab-row);">— Case studies, 2024–2025</div>
</section>
```

---

## Footer

Multi-column bordered cells, mono column heads at 50%, over a faint hash-field.
(This is the composition seen in the source — reuse the *system*, not the exact cells.)

```html
<footer class="bab-frame" style="position:relative;">
  <div class="bab-hashfield" aria-hidden="true" style="opacity:0.5;"></div>
  <div class="bab-cells" style="position:relative; grid-template-columns:repeat(3,1fr);">
    <div class="bab-cell" style="min-height:224px;">
      <div class="bab-label" style="margin-bottom:32px;">Sections</div>
      <nav style="display:flex; flex-direction:column; gap:18px;">
        <a class="bab-link" href="#">Home</a>
        <a class="bab-link" href="#">About</a>
        <a class="bab-link" href="#">Apply</a>
      </nav>
    </div>
    <div class="bab-cell"><div class="bab-label" style="margin-bottom:32px;">Contact</div>…</div>
    <div class="bab-cell"><div class="bab-label" style="margin-bottom:32px;">Terms</div>…</div>
  </div>
  <div class="bab-container" style="position:relative; padding-block:32px;">
    <p class="bab-display-l" style="margin:0;">Let's build.</p>
  </div>
</footer>
```

---

## Tags & metadata

```html
<div style="display:flex; gap:8px; flex-wrap:wrap;">
  <span class="bab-tag">Solidity</span>
  <span class="bab-tag">ZK</span>
  <span class="bab-tag">Consensus</span>
</div>
<div class="bab-label" style="margin-top:16px;">
  0xF4B3…0A0A · <span class="bab-gold">● Live</span>
</div>
```

---

## Forms / inputs

Hairline box, mono label, gold focus ring (from `brand.css`).

```html
<label class="bab-label" for="email" style="display:block; margin-bottom:10px;">Email</label>
<input id="email" type="email" placeholder="you@berkeley.edu"
  style="width:100%; background:var(--bab-surface-1); color:var(--bab-white);
         border:1px solid var(--bab-line); border-radius:var(--bab-radius);
         font-family:var(--bab-sans); letter-spacing:var(--bab-track);
         padding:14px 16px;">
```

---

## Do / Don't

- **Do** frame everything in hairlines; keep corners square; ration the gold.
- **Do** let one Garamond line dominate each section.
- **Don't** use rounded cards, drop shadows, glows, gradients-as-fills, or
  full-color imagery. Those read as generic dark SaaS and break the brand.
