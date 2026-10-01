# B@B Logo Assets (official)

Pulled from the official Blockchain at Berkeley brand drive.

> **Use the mark only on official B@B properties.** Placing this logo on a site
> implies it *is* Blockchain at Berkeley. For an unaffiliated, sub-brand, event,
> personal, or experimental site that should merely *look* B@B-adjacent, use the
> **design system without the logo** (a text wordmark or the user's own mark
> instead). If you're unsure whether the project is official, ask the user first
> — see SKILL.md §0.0.

**Use these files — do not redraw the mark.** The logo is a gold "recycling-triad": three chevron
blocks arranged in a triangle, each block built from two-tone gold parallelograms
(`#FECB33` lit faces, `#EAA536` shaded faces) with white arrow cuts. The wordmark
is `BLOCKCHAIN` with a gold `AT BERKELEY` subtitle.

## Which file to use

| File | Type | Use on | Notes |
|------|------|--------|-------|
| `blockchain_icon.svg` | vector | any bg | **Icon only** (the gold mark). Scales cleanly — prefer for nav/favicons. |
| `blockchain_lockup_dark.svg` | vector | **dark bg** | Full lockup, wordmark in `#E5E5E5`. **Default for B@B sites.** |
| `blockchain_lockup.svg` | vector | light bg | Full lockup, wordmark in `#3D3D3D`. |
| `logo_icon.png` | raster | any bg | Icon only, transparent. Fallback when SVG isn't an option. |
| `logo_light.png` | raster | dark bg | Full lockup, light wordmark. |
| `logo_dark.png` | raster | light bg | Full lockup, dark wordmark. |

Prefer the **SVG** files for the web (crisp at any size, tiny). On a `#0C0C0C`
canvas, reach for `blockchain_icon.svg` (nav) or `blockchain_lockup_dark.svg`
(footer / brand moments).

## Official color guide (verbatim)

```
Title Font (on dark):  #E5E5E5      Title Font (on light): #3D3D3D
Subtitle Font:         #F8BE34
Lighter Shade (mark):  #FECB33
Darker Shade (mark):   #EAA536
```

Clear space: keep at least the height of one chevron block clear on all sides.
Don't recolor the mark, add effects, or place the dark-wordmark lockup on a dark
background (it disappears). The mark itself is the one place gold appears at full
strength — everywhere else, ration it (see SKILL.md §2).
