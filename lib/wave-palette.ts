// The colours of the background waves (app/Background.tsx) through the day. The palette follows the light
// outside the room: it is read off the sun's position (lib/sun.ts), not the clock, so the dawn and dusk colours
// arrive when dawn and dusk do, at 5 pm in December and 8.30 pm in June.

import type { Sun } from "./sun";

/*
 * Colour is worked out in OKLab, where equal steps look equal, so every ribbon is the same lightness whatever its
 * hue and two ribbons crossing blend through a clean in-between hue instead of going dark and grey.
 *
 * LIGHTNESS is the waves' ceiling (the black canvas, #0C0C0C, is 0.154). MAX_LUMINANCE is the same ceiling as
 * relative luminance, the number contrast is computed from; it is a guard, and it is the level at which the faintest
 * text in the brand, the 50% white labels, still has 4.5:1 against the brightest wave. Text sits straight on the waves.
 *
 * Both hold at every time of day. The palettes below only ever go darker than LIGHTNESS, and the shader keeps
 * every pixel under MAX_LUMINANCE whatever colours it is given. Worked out for every keyframe and for each
 * minute between them, the lowest contrast of the day is the sunset palette's, which is the one these two
 * numbers were chosen for: 7.1:1 for this page's faintest text (68% white), 9.3:1 for its secondary text (80%),
 * 9.0:1 and 5.7:1 for the teal and coral price figures, and 4.45:1 for 50% white on the indigo ribbon.
 */
export const LIGHTNESS = 0.305;
export const MAX_LUMINANCE = 0.0257;

export type Ribbon = { hue: number; chroma: number };
export type Palette = { lightness: number; ribbons: Ribbon[] };

/**
 * A palette pinned to a point in the sun's day: solar noon, solar midnight, or the sun crossing an elevation
 * (degrees, negative below the horizon) on its way up or down.
 */
export type Keyframe = Palette & { name: string; at: "midnight" | "noon" | { rising: number } | { setting: number } };

/**
 * Every hue in every palette lies on one arc of the colour wheel: blue (262 degrees) through indigo, violet,
 * plum and rose, round to burnt amber (50). These are also the colours daylight itself moves through, sky blue
 * to twilight violet to the pink and amber of a low sun. The arc leaves out the far side of the wheel: greens
 * are no part of the sky or the brand and turn sickly this dark, and teal is the page's "price up" colour (hue
 * 175). It stops at 262 because a bluer blue cannot be shown this dark: under 260 sRGB has so little chroma
 * left that the ribbon reads as petrol, a teal, behind the tape's teal figures. It stops at 50 because a dark
 * yellow is olive.
 *
 * Hues are measured from this cut, in the middle of the gap, so that a hue moving between two palettes travels
 * along the arc and can never take the short way round through green.
 */
const ARC_CUT = 160;
const onArc = (hue: number) => (hue < ARC_CUT ? hue + 360 : hue);

/**
 * The ribbons' quietest and darkest state, held from solar midnight until the first light of dawn: the narrowest
 * arc of the day, at half the colour and nine tenths of the lightness. A screen in a dark room looks brighter and
 * more colourful than the same screen in daylight, so this is where the waves step back.
 */
const NIGHT: Palette = {
  lightness: 0.272,
  ribbons: [{ hue: 270, chroma: 0.085 }, { hue: 284, chroma: 0.08 }, { hue: 300, chroma: 0.07 }, { hue: 322, chroma: 0.064 }, { hue: 300, chroma: 0.07 }],
};

/**
 * The day, in order from solar midnight. Each palette lists the ribbons from the top of the screen to the bottom
 * as OKLCH hue and chroma, and each is built the way the first one (now "sunset") was:
 *
 * - One run along the arc, top ribbon to fourth, with the fifth stepping back to the third's colour. Neighbours
 *   on screen are never more than 65 degrees apart, so where two ribbons cross the blend is a clean in-between
 *   hue. Because a ribbon keeps its place in that order all day, the same holds at every moment in between.
 * - The cool end is always at the top and the warm end low, as in a sky. The top ribbon stays within a few
 *   degrees of indigo 268, the complement of the brand gold, all day.
 * - Chroma is at most four fifths of what sRGB can show at that hue and lightness. That limit is very uneven
 *   down here: 0.20 at indigo 270, 0.14 at blue 262, 0.12 across the reds, 0.08 at amber 50.
 * - No ribbon rests between hue 0 and 40, the reds around the "price down" coral (28), so no palette puts a red
 *   wash behind the figures. Only the fourth ribbon ever crosses that band, on its way to amber before sunset
 *   and back after it, for about an hour a day in all.
 *
 * The sun sets the temperature. High sun is the coolest and plainest (blue sky, white light): the narrowest arc
 * of the daytime, at reduced chroma, so that in a bright room the screen is closest to the brand's plain black.
 * A sun at the horizon spreads the arc widest and brings in the warm end. After dark the arc closes up around
 * indigo and plum and dims. Morning and evening differ, as they do outside: dawn is clear and comes up rose
 * with no amber in it, dusk is hazier and goes down amber. "Sunset" is the palette the waves were first
 * designed with, unchanged.
 */
export const KEYFRAMES: Keyframe[] = [
  { name: "night", at: "midnight", ...NIGHT },
  { name: "night", at: { rising: -18 }, ...NIGHT },
  {
    name: "first light", at: { rising: -6 }, lightness: 0.3,
    ribbons: [{ hue: 262, chroma: 0.105 }, { hue: 268, chroma: 0.14 }, { hue: 276, chroma: 0.14 }, { hue: 292, chroma: 0.125 }, { hue: 276, chroma: 0.14 }],
  },
  {
    name: "sunrise", at: { rising: 0 }, lightness: LIGHTNESS,
    ribbons: [{ hue: 264, chroma: 0.12 }, { hue: 284, chroma: 0.135 }, { hue: 318, chroma: 0.115 }, { hue: 355, chroma: 0.098 }, { hue: 318, chroma: 0.115 }],
  },
  {
    name: "morning", at: { rising: 12 }, lightness: LIGHTNESS,
    ribbons: [{ hue: 262, chroma: 0.1 }, { hue: 272, chroma: 0.13 }, { hue: 290, chroma: 0.12 }, { hue: 322, chroma: 0.105 }, { hue: 290, chroma: 0.12 }],
  },
  {
    name: "midday", at: "noon", lightness: LIGHTNESS,
    ribbons: [{ hue: 262, chroma: 0.08 }, { hue: 268, chroma: 0.1 }, { hue: 276, chroma: 0.1 }, { hue: 288, chroma: 0.095 }, { hue: 276, chroma: 0.1 }],
  },
  {
    name: "afternoon", at: { setting: 20 }, lightness: LIGHTNESS,
    ribbons: [{ hue: 264, chroma: 0.11 }, { hue: 278, chroma: 0.135 }, { hue: 310, chroma: 0.11 }, { hue: 350, chroma: 0.09 }, { hue: 310, chroma: 0.11 }],
  },
  {
    name: "golden hour", at: { setting: 6 }, lightness: LIGHTNESS,
    ribbons: [{ hue: 264, chroma: 0.12 }, { hue: 292, chroma: 0.135 }, { hue: 346, chroma: 0.1 }, { hue: 50, chroma: 0.065 }, { hue: 346, chroma: 0.1 }],
  },
  {
    name: "sunset", at: { setting: -1 }, lightness: LIGHTNESS,
    ribbons: [{ hue: 268, chroma: 0.16 }, { hue: 298, chroma: 0.13 }, { hue: 338, chroma: 0.105 }, { hue: 42.6, chroma: 0.068 }, { hue: 338, chroma: 0.105 }],
  },
  {
    name: "dusk", at: { setting: -6 }, lightness: LIGHTNESS,
    ribbons: [{ hue: 262, chroma: 0.105 }, { hue: 274, chroma: 0.15 }, { hue: 300, chroma: 0.125 }, { hue: 350, chroma: 0.095 }, { hue: 300, chroma: 0.125 }],
  },
  {
    name: "evening", at: { setting: -18 }, lightness: 0.295,
    ribbons: [{ hue: 266, chroma: 0.12 }, { hue: 284, chroma: 0.12 }, { hue: 310, chroma: 0.1 }, { hue: 345, chroma: 0.085 }, { hue: 310, chroma: 0.1 }],
  },
];

/** The keyframes with each hue as a place on the arc, the form they are blended in. */
const STOPS = KEYFRAMES.map(({ at, lightness, ribbons }) => ({
  at,
  lightness,
  ribbons: ribbons.map(({ hue, chroma }) => ({ arc: onArc(hue), chroma })),
}));

/** Where a keyframe falls in the sun's day: degrees of hour angle past solar midnight, 0 to 360, noon at 180. */
function dayAngle(at: Keyframe["at"], sun: Sun): number {
  if (at === "midnight") return 0;
  if (at === "noon") return 180;
  return "rising" in at ? 180 - sun.hourAngleAt(at.rising) : 180 + sun.hourAngleAt(at.setting);
}

/**
 * The palette for a position of the sun. Between two keyframes every ribbon's lightness, chroma and place on the
 * arc move in a straight line with the sun's hour angle, which near the horizon is as good as its elevation. So
 * the colour is continuous through the whole day, and a ribbon keeps its chroma on the way round the arc instead
 * of cutting across the wheel and sagging towards grey, as a straight blend of two colours would.
 *
 * The fastest any ribbon moves is the fourth around sunset, about two degrees of hue a minute; at the 10-second
 * refresh in Background.tsx that is a step far smaller than one 8-bit level. Chroma is blended as it stands, not
 * as a share of the gamut: the gamut's edge has a cliff at hue 264, where sRGB blue sits (0.15 at 263, 0.21 at
 * 265), and a ribbon scaled to it would jump as it crossed.
 */
export function wavePalette(sun: Sun): Palette {
  const now = sun.hourAngle + 180;
  let from = STOPS[0];
  let fromAngle = 0;
  let to = STOPS[0];
  let toAngle = 360;
  for (const stop of STOPS) {
    const angle = dayAngle(stop.at, sun);
    if (angle > now) { to = stop; toAngle = angle; break; }
    from = stop;
    fromAngle = angle;
  }
  const t = toAngle - fromAngle > 1e-6 ? (now - fromAngle) / (toAngle - fromAngle) : 1;
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    lightness: mix(from.lightness, to.lightness),
    ribbons: from.ribbons.map((ribbon, i) => ({ hue: mix(ribbon.arc, to.ribbons[i].arc) % 360, chroma: mix(ribbon.chroma, to.ribbons[i].chroma) })),
  };
}
