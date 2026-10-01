---
name: blockchain-at-berkeley-brand
description: >-
  Design and build websites in the Blockchain at Berkeley (B@B) brand identity —
  a dark, editorial, "on-chain ledger" aesthetic. Near-black canvas, hairline
  grid rules, massive EB Garamond display type, Instrument Sans body, DM Mono
  metadata, and a single rare accent of California Gold that behaves like data.
  Use this whenever building any B@B web page, landing page, microsite, deck,
  or component — or any site that should carry the B@B identity. Prescriptive on
  identity (exact colors, type, spacing, motifs), flexible on layout so every
  site is on-brand but distinct, never a copy-paste clone.
---

# Blockchain at Berkeley — Brand & Web Identity

You are building for **Blockchain at Berkeley (B@B)** — UC Berkeley's blockchain
engineering, research, and education group. The brand is **editorial, technical,
and quietly grand**: a near-black canvas that reads like a terminal crossed with
a broadsheet newspaper, structured by hairline rules, anchored by enormous serif
headlines, and lit by a single rare accent — California Gold — that only appears
where there is *signal* or *value*, the way a live transaction hash glints in a
field of dark ones.

> **The one-line feel:** *A private ledger printed on black paper. Mostly
> monochrome, obsessively gridded, occasionally gold.*

This file is self-sufficient — you can build a beautiful, on-brand site from it
alone. The `references/` files go deeper when you need them:

- `references/brand.css` — **drop-in** CSS custom properties + base classes. Start here for plain CSS.
- `references/tailwind.css` — **Tailwind v4** (`@theme`) version of every token. Use if the project is on Tailwind v4.
- `references/tailwind.config.js` — **Tailwind v3** config with the same tokens. Use if the project is on Tailwind v3.
- `references/motifs.md` — how to build the signature textures (hash-field, dither, ASCII, halftone, grid). The charisma lives here.
- `references/components.md` — recipes for nav, buttons, cards, eyebrows, footers, tags.
- `references/voice.md` — copywriting & tone.
- `references/verification.md` — optional adversarial visual-QA loop: render, have a fresh subagent critique against the identity, fix, re-check once. Capability-gated (needs a subagent + a browser you already have).
- `examples/index.html` — one self-contained page that proves the whole system. Read it to see the parts working together; do **not** clone it.

**Choosing the token source:** plain CSS / any framework → `brand.css`. Tailwind
v4 → `tailwind.css`. Tailwind v3 → `tailwind.config.js`. All three carry the
identical values, so pick the one that matches the target project and never
hardcode a hex that has a token.

---

## 0. How to use this skill (read first)

### 0.0 — STOP and ask before you build

Before writing any code or entering a build loop, **ask the user the clarifying
questions below.** These change what you build; guessing wastes a whole agentic
loop. Use your framework's structured question tool if it has one (e.g.
`AskUserQuestion` in Claude Code — offer the options listed). If no such tool
exists, **interrupt in plain text and ask before proceeding** — do not disappear
into a long autonomous build and surface the questions afterward. Ask all of them
in one batch, then build. It is *your* responsibility to raise these, not the
user's to volunteer them.

1. **Logos — use the official B@B mark, or the design system only?**
   The `assets/` logo is the real, official Blockchain at Berkeley mark. Using it
   implies this *is* an official B@B property. Ask which they want:
   - **Official B@B site** → use the real logo/lockup from `assets/`.
   - **Design system only** (an unaffiliated, sub-brand, event, personal, or
     experimental site that should *look* B@B-adjacent but not claim to be B@B) →
     use the visual identity (color, type, grid, motifs) but **omit the logo**;
     use a text wordmark or the user's own mark instead. When in doubt, ask —
     don't put an official mark on something that isn't official.

2. **What are we building, and how much is there?** One landing page, a multi-page
   site, a single section/component, or a full app? Roughly how many
   pages/sections? This sets scope and structure.

3. **Tech stack / token source?** Plain HTML+CSS, React, Vue, something else — and
   Tailwind or not (v3 vs v4)? Determines whether you use `brand.css`,
   `tailwind.css` (v4), or `tailwind.config.js` (v3), and how you match the
   project's conventions. If you're dropping into an existing repo, detect this
   instead of asking.

4. **Real content, or on-brand placeholder?** Do they have copy, stats, and assets,
   or should you generate placeholder? **Critical:** the reference copy and
   `voice.md` name real B@B facts (Samsung, Arbitrum, Ripple, PayPal, cohort
   numbers). Do **not** reuse those as claims for a different org or an unaffiliated
   site — that's fabrication. Ask what's true here.

Also worth confirming when relevant (ask only if it matters for the task):
**how closely to hew to the reference** (faithful vs. more adventurous
composition), and **whether to run the adversarial verification loop** (§ref
`verification.md`) since it spends extra tokens/subagent calls.

If the user has already answered any of these in their request, don't re-ask —
just confirm your reading of it in a sentence and proceed.

### 0.1 — Then build

1. **Load the tokens, not the layout.** The identity below is fixed: colors,
   fonts, tracking, the grid, the motifs, the 0-radius edges. The *composition*
   is yours to invent per project. Two B@B sites should share a DNA, not a
   wireframe.
2. **Start from `brand.css`.** Link or inline it, then compose with its variables
   and utility classes. Never hardcode a hex that has a token.
3. **Pick 1–2 signature motifs per page, not all six.** A page earns its charisma
   from restraint. One hero texture + hairline grid is usually enough. See §5.
4. **Spend the gold like money.** If gold appears more than ~3 places per
   viewport, you've overspent. See §2.
5. **When unsure, make it more editorial and more restrained** — bigger type,
   more negative space, thinner rules, less color. The failure mode of this brand
   is "generic dark SaaS," and the cure is always *more newspaper, less dashboard.*

---

## 1. Non-negotiables (the identity fingerprint)

If a page has these six things, it reads as B@B — regardless of layout:

1. **Near-black canvas** `#0A0A0A` with pure-white text. Never a blue-black, never
   `#000` for large fields, never dark gray.
2. **Hairline grid rules** in `#2A2A2A` (soften to 65% opacity). Vertical rules at
   the page margins frame the content like a ledger; cells are divided by more
   hairlines. Structure is *visible*.
3. **One massive EB Garamond line per view** — sentence case, leading `0.81–0.92`,
   tracking `-0.03em`. It should feel almost too big.
4. **DM Mono metadata** — uppercase labels, indices, timestamps, hashes, numbers,
   at ~50% white opacity. This is the "machine" voice on the page.
5. **Universal −3% tracking** (`letter-spacing: -0.03em`) on *every* typeface. This
   single detail is a huge part of the fingerprint.
6. **California Gold, used as data** `#FDB515` — rare, small, meaningful. Never a
   big gold fill, never a gold gradient hero. Gold = a live signal.

Break any of these and it stops being B@B.

---

## 2. Color

All neutral, plus one gold family. Copy these into `:root` (they're in
`brand.css` already):

```css
/* Neutrals — the whole brand lives here */
--bab-black:      #0C0C0C;   /* canvas (shipped). Figma spec: #0A0A0A  */
--bab-black-true: #000000;   /* rare, for true voids / behind textures */
--bab-surface-1:  #111111;   /* raised surface, inset panels           */
--bab-surface-2:  #1B1B1B;   /* hover fill, active cell                 */
--bab-line:       #2A2A2A;   /* hairline rules & borders               */
--bab-line-soft:  rgba(42,42,42,0.65); /* softest rule (default border) */
--bab-line-lit:   #3B3B3B;   /* brighter rule, disabled text           */

--bab-white:      #FFFFFF;   /* primary text                           */
--bab-text-dim:   rgba(255,255,255,0.70); /* secondary body            */
--bab-text-mute:  rgba(255,255,255,0.50); /* mono labels, captions     */
--bab-text-faint: rgba(255,255,255,0.30); /* watermarks, placeholders  */

/* California Gold — the accent. Spend it like money. */
--bab-gold:       #FECB33;   /* THE accent — shipped brand gold (logo, "Apply") */
--bab-gold-sub:   #F8BE34;   /* "AT BERKELEY" subtitle gold (official guide)    */
--bab-gold-deep:  #EAA536;   /* shaded logo face / gold pressed-state           */
--bab-gold-cal:   #FDB515;   /* official Berkeley California Gold (heritage)     */
--bab-wordmark-dark:  #E5E5E5; /* "BLOCKCHAIN" wordmark on a dark canvas        */
--bab-wordmark-light: #3D3D3D; /* "BLOCKCHAIN" wordmark on a light canvas       */
--bab-gold-warm:  #F4B320;   /* data-texture gold, slightly warmer              */
--bab-gold-hot:   #FAE42C;   /* rare spark / hottest hash / highlight           */
--bab-amber-deep: #A43E04;   /* burnt amber — texture depth, gradients          */

/* Berkeley Blue — heritage secondary. Optional, rarely used. */
--bab-blue:       #003262;   /* only when you truly need a 2nd color     */
```

**Rules for gold (critical to taste):**
- Gold is for **signal**: the **logo mark**, the nav **"Apply →"** link, an
  active/hover state, a hot glyph in a texture, a hairline underline on the key
  link, one focus ring, one live number. That's it.
- **The primary button is WHITE, not gold** (solid white fill, black text — see
  §Buttons / the shipped site). Gold is *rarer* than a CTA — it's the brand's
  signature glint, not a call-to-action color. Gold-on-hover is fine.
- **Never** a full-width gold banner, gold body text, gold headline, or gold
  gradient background. If you want warmth at scale, use `--bab-amber-deep` at
  low opacity *inside a texture*, not as a fill.
- A good page is ~95% monochrome. The gold should feel like you're rationing it.
- Berkeley Blue exists for heritage but the web identity is **gold-forward**.
  Reach for blue only for a genuinely needed second signal (e.g. an info state);
  most pages never use it.

**Contrast:** white on `#0C0C0C` is your workhorse. Dim to `--bab-text-mute` for
supporting copy. Gold `#FECB33` on black is strong for large/graphic use; for gold
*text* keep it ≥16px or bold, or use `--bab-gold-hot` for tiny gold type.

**Logo:** the mark is a gold **recycling-triad** — three chevron blocks in a
triangle, each built from two-tone gold parallelograms (`#FECB33` lit, `#EAA536`
shaded) with white arrow cuts. The wordmark is `BLOCKCHAIN` with a gold
`AT BERKELEY` subtitle (`#F8BE34`); the wordmark itself is `#E5E5E5` on dark
canvases, `#3D3D3D` on light. **Use the real files in `assets/` — never redraw
it:** `blockchain_icon.svg` (mark only) and `blockchain_lockup_dark.svg` (full
lockup for dark backgrounds) are the defaults. See `assets/README.md`. The mark
is the one place gold appears at full strength every time.

---

## 3. Typography

Three families, all free on Google Fonts (so any build stays self-contained):

| Role | Family | Weights | Where |
|------|--------|---------|-------|
| **Display** | `EB Garamond` | 500 (400/600 ok) | Hero lines, section titles, pull quotes |
| **Text / UI** | `Instrument Sans` | 300, 400, 500 | Body, nav, buttons, captions; **300 (Light) for big stat numbers** |
| **Mono** | `DM Mono` *or* `IBM Plex Mono` | 400, 500 | Eyebrows, labels, numbers, hashes, code, tags |

Mono note: the Figma labels DM Mono; the **shipped site uses IBM Plex Mono** for
the hash-field. Both are correct — pick one per project and use it for *all* mono.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=EB+Garamond:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Instrument+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
```

```css
--bab-display: "EB Garamond", Georgia, "Times New Roman", serif;
--bab-sans:    "Instrument Sans", -apple-system, "Segoe UI", Helvetica, sans-serif;
--bab-mono:    "DM Mono", "SF Mono", ui-monospace, Menlo, monospace;
--bab-track:   -0.03em;   /* apply to EVERYTHING */
```

**Universal rules**
- `letter-spacing: -0.03em` on all three families. Always.
- Display is **sentence case**, never ALL CAPS. Let the size do the shouting.
- Mono labels are **UPPERCASE**, ~12px, at `--bab-text-mute`.
- Display leading is **ultra tight** and gets tighter as it gets bigger
  (0.92 at 40px → 0.81 at 140px+). Body leading is comfortable (1.4–1.5).

**Type scale** (use `clamp()` for responsiveness; px values are the 1512-wide target):

```css
--fs-display-xl: clamp(3.5rem, 9.5vw, 9rem);   /* 56→144  hero          lh .81 */
--fs-display-l:  clamp(3rem,  6.4vw, 6rem);     /* 48→96   big statement lh .86 */
--fs-display-m:  clamp(2.25rem,4.2vw, 4rem);    /* 36→64   section title lh .92 */
--fs-display-s:  clamp(1.75rem,2.6vw, 2.5rem);  /* 28→40   sub-head      lh 1.0 */
--fs-lead:       clamp(1.2rem, 1.5vw, 1.44rem); /* 19→23   intro para    lh 1.4 */
--fs-body:       1rem;                          /* 16      body          lh 1.5 */
--fs-small:      0.875rem;                      /* 14      small          */
--fs-label:      0.75rem;                       /* 12      mono UPPERCASE lh 1  */
--fs-micro:      0.6875rem;                     /* 11      mono caption    */
```

**Pairing logic**
- Big idea → **Garamond** (emotional, human, editorial).
- Explanation → **Instrument Sans** (clear, neutral, engineered).
- Fact / label / number / address → **DM Mono** (machine, ledger, proof).
- A classic B@B block is: mono eyebrow → giant Garamond line → Instrument
  lead paragraph → mono metadata row. Three voices, one thought.

---

## 4. Grid, spacing & shape

The layout system is an **editorial ledger**: strict columns, visible hairline
rules, generous margins, square corners.

```css
--bab-margin: clamp(20px, 5vw, 69px);  /* page gutter; rules live here     */
--bab-pad:    31px;                     /* padding inside a cell            */
--bab-row:    46px;                     /* vertical rhythm step             */
--bab-radius: 0px;                      /* SHARP. corners are square.       */
--bab-hair:   1px;                      /* rule / border weight             */
--bab-maxw:   1374px;                   /* content width (1512 − 2×69)      */
```

**Spacing scale** (px): `4 · 8 · 12 · 16 · 24 · 32 · 46 · 64 · 92 · 138`.
The **signature numbers are 69 / 46 / 31** — reach for those before round numbers
to keep the rhythm recognizably B@B.

**Grid rules**
- Wrap content in a centered container at `--bab-maxw` with `--bab-margin` gutters.
- Draw **vertical hairlines at the left and right content edges** — the ledger
  frame. Divide multi-column sections with more hairlines (`--bab-line-soft`).
- Prefer a **12-column** grid; let cells share visible borders (like the 3-up
  footer in the source: three bordered cells, `31px` padding, `46px` row steps).
- **Corners are 0.** Sharpness is brand. Allow `2px` only if a component truly
  needs to feel soft; never more.
- Negative space is a feature — big empty gutters and tall section padding are
  correct, not "unfinished."

**Layout instincts**
- Asymmetry over centering. Anchor a giant headline to the left rule and let it
  run wide; hang metadata in a narrow mono column.
- Baseline-align across columns; let hairlines mark the shared baselines.
- Full-bleed textures (hash-field, dither) can break the margin; text never does.

---

## 5. Signature motifs (the charisma) — pick 1–2 per page

These are what make it *sing*. Build them from `references/motifs.md`. Do **not**
use all six on one page — choose the one or two that serve the content.

1. **Hairline grid / ledger frame** — always-on baseline. Vertical margin rules +
   divided cells. Nearly free, and it's the skeleton everything hangs on.
2. **Transaction-hash field** — ambient rows of hex (`0-9a-f`) in tiny mono,
   mostly `--bab-text-faint`/dark-warm, with *rare* gold glints
   (`--bab-gold-warm`). Sits behind heroes/footers at low contrast. This is the
   single most B@B texture — it literally renders the chain. **Signature move
   (shipped):** modulate the field's brightness by an image mask so the hashes
   *resolve into a subject* — a portrait, a logo, a map — visible only as denser/
   brighter hex. See `motifs.md` → "hash portrait." One of these per page is a
   showstopper.
3. **Dithered / 1-bit imagery** — all photography is monochrome and dithered
   (Floyd–Steinberg / ordered / halftone dots). No full-color photos, ever. A
   dot-halftone world map or a dithered portrait is peak on-brand.
4. **ASCII imagery** — photos/logos rendered as ASCII glyphs in DM Mono, dim gold
   on black. Great for a portrait, a logo reveal, or a loading state.
5. **Giant Garamond statement** — one oversized editorial line as the visual
   anchor of a section (it *is* the hero, not just a caption).
6. **Monospace data chrome** — index numbers (`01 — 02 — 03`), timestamps,
   wallet-style truncated addresses (`0xF4…B320`), counters, and tags in mono.
   Small, precise, at 50% opacity, turning gold on the live/hover one. Big **stat
   numbers** are the exception: set those in Instrument Sans **Light (300)**,
   large and tight, over a mono uppercase label (e.g. `5,000+` / `MEMBERS`).

**One more shipped detail — the arrow.** Buttons and the nav "Apply" link carry a
trailing **`→`** (right arrow). It's a small, consistent tell; use it on primary
actions and forward links.

**Motif discipline:** the grid is always on; add exactly one "hero texture"
(hash-field *or* dither *or* ASCII) plus mono data chrome. That's the recipe.

---

## 6. Motion (restrained, precise)

Architectural, never playful. If in doubt, do less.

- **Easing:** `cubic-bezier(0.2, 0.6, 0, 1)` (a decisive, engineered ease-out).
  Durations `150–500ms`. Hovers `150ms`, reveals `400–500ms`.
- **Text reveals:** mask-up (clip from below) with a small stagger between lines.
  Garamond lines love a slow reveal.
- **Hover:** hairline `#2A2A2A` → `#FDB515`, or text white → gold, in 150ms. Fills
  appear as `--bab-surface-2`. Keep it subtle.
- **Textures:** the hash-field may drift/flicker *very* slowly (a few px/sec, or
  occasional glyph flips to gold). Dither images can crossfade between frames.
  Nothing bounces, nothing springs.
- Respect `prefers-reduced-motion`: freeze textures, cut reveals to instant.

---

## 7. Voice (so copy matches the design)

Confident, concrete, technical-but-plain — engineers who ship, not marketers.
(Full guide in `references/voice.md`.)

- **Sentence case** everywhere, including headlines.
- **Proof over hype.** Name the real work: "shipped for Samsung and Arbitrum,
  modeled consensus attacks for Ripple, built the course PayPal ran internally."
  Specifics *are* the flex. Avoid "revolutionary / cutting-edge / synergy."
- Headlines can be **declarative and a little grand** ("The Future Is On Chain")
  — the restraint of the design earns the ambition of the words.
- Mono captions are terse and factual: labels, counts, dates, addresses.
- Short sentences. Active voice. End sections with forward motion
  ("We're looking for the next thing to build.").

---

## 8. Build checklist (run before you call a page done)

- [ ] Canvas is `#0C0C0C` (≈`#0A0A0A`); text is pure white; no stray blue-blacks.
- [ ] Vertical hairline rules frame/divide the content (a visible column grid).
- [ ] Exactly one oversized EB Garamond line anchors the primary view.
- [ ] Every typeface is tracked `-0.03em`; display is tight-leaded & sentence case.
- [ ] Mono labels are UPPERCASE at ~50% white; numbers/addresses are mono; big
      stats are Instrument Sans Light 300.
- [ ] Primary button is **white-filled** (not gold), square, with a trailing `→`.
- [ ] Gold appears in ≤3 spots per viewport (logo, "Apply", a glint) — never a button fill.
- [ ] One (max two) hero texture present; imagery is dithered/ASCII, never full color.
- [ ] Corners are square (0 radius); borders are 1px hairlines.
- [ ] Signature spacing (69 / 46 / 31) shows up in the rhythm.
- [ ] Motion is restrained, gold-on-hover, and honors reduced-motion.
- [ ] It reads like an editorial ledger, not a generic dark dashboard.

Then, if you have a subagent + a browser already available and it's non-invasive,
run the adversarial visual-QA loop in `references/verification.md` — render it,
let a fresh critic subagent tear it apart against this checklist, fix what's real,
re-check once, and stop. If you can't render, do the static self-audit there and
say so. Keep it tight (≤2 rounds) — don't burn tokens.

Build on-brand, then make it *distinct*. Same DNA, new composition.
