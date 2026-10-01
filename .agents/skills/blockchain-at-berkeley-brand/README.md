# Blockchain at Berkeley — Brand Skill

A self-contained Claude skill for designing and building websites in the
**Blockchain at Berkeley (B@B)** brand identity: a dark, editorial "on-chain
ledger" aesthetic — near-black canvas, hairline grid rules, massive EB Garamond
display type, Instrument Sans body, DM Mono metadata, and a single rare accent of
California Gold that behaves like data.

Distilled from the B@B site-redesign Figma. Prescriptive on **identity** (exact
colors, type, spacing, motifs), flexible on **layout** — every site is on-brand
but distinct, never a copy-paste clone.

## Start here

**[`SKILL.md`](./SKILL.md)** — the master prompt. Self-sufficient; read it first.

## Contents

| File | What it's for |
|------|---------------|
| `SKILL.md` | Master brand + web identity prompt (colors, type, grid, motifs, voice, checklist) |
| `assets/` | **Official logo files** (real B@B mark + lockups, SVG + PNG) — see `assets/README.md` |
| `references/brand.css` | Drop-in CSS custom properties + base classes (plain CSS / any framework) |
| `references/tailwind.css` | Tailwind **v4** `@theme` version of every token |
| `references/tailwind.config.js` | Tailwind **v3** config with the same tokens |
| `references/motifs.md` | Signature texture cookbook — hash-field, dither, ASCII, halftone, grid |
| `references/components.md` | Component recipes — nav, buttons, cards, footer, tags, forms |
| `references/voice.md` | Copywriting & tone guide |
| `references/verification.md` | Optional adversarial visual-QA loop (render → subagent critique → fix → recheck), capability-gated |
| `examples/index.html` | Self-contained reference page proving the whole system (read, don't clone) |

## Identity in one glance

- **Canvas** `#0A0A0A` near-black · pure-white text · hairline `#2A2A2A` grid rules
- **Accent** shipped brand gold `#FECB33` (Cal Gold `#FDB515` heritage) — *only* as signal/data, ≤3 spots per view
- **Logo** gold recycling-triad mark + `BLOCKCHAIN` / gold `AT BERKELEY` lockup (real files in `assets/`)
- **Type** EB Garamond (giant display, lh 0.81) · Instrument Sans (body) · DM Mono (labels @50%)
- **Fingerprint** universal `-0.03em` tracking · square corners · signature spacing 69 / 46 / 31
- **Motifs** transaction-hash field · dithered/ASCII imagery · monospace data chrome
