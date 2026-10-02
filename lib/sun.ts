// Where the sun is over the clubroom, worked out from the clock alone (no network call). app/Background.tsx
// uses it, through lib/wave-palette.ts, to colour the waves by the light outside rather than by the hour on the
// clock, so dawn and dusk fall where they really do in every season.
//
// The formulas are NOAA's "General Solar Position Calculations" (the short Fourier series behind its solar
// calculator). They are good to about a third of a degree with refraction ignored, a minute or two of time at
// the horizon, which is far finer than the colour steps they drive.

/** The room the screen hangs in: Berkeley, California. Degrees, north and east positive. */
export const LATITUDE = 37.87;
export const LONGITUDE = -122.26;

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;

export type Sun = {
  /** Degrees above the horizon; negative once the sun is below it. */
  elevation: number;
  /** Degrees the sun is past due south: 0 at solar noon, negative in the morning, +/-180 at solar midnight. */
  hourAngle: number;
  /**
   * The hour angle, 0 to 180, at which the sun stands at this elevation today; the morning crossing is its
   * negative. An elevation the sun does not reach today gives 0 (too high) or 180 (too low).
   */
  hourAngleAt: (elevation: number) => number;
};

/** The sun's position for an instant. Everything is worked out in UTC, so the computer's time zone does not matter. */
export function sunAt(date: Date): Sun {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  // The fraction of the year gone, as an angle. It runs from noon so that a day's values centre on its midday.
  const year = (2 * Math.PI / 365) * ((date.getTime() - yearStart) / DAY_MS - 0.5);
  const declination = 0.006918 - 0.399912 * Math.cos(year) + 0.070257 * Math.sin(year)
    - 0.006758 * Math.cos(2 * year) + 0.000907 * Math.sin(2 * year)
    - 0.002697 * Math.cos(3 * year) + 0.00148 * Math.sin(3 * year);
  // Minutes by which a sundial runs ahead of a clock (the equation of time).
  const sundialLead = 229.18 * (0.000075 + 0.001868 * Math.cos(year) - 0.032077 * Math.sin(year)
    - 0.014615 * Math.cos(2 * year) - 0.040849 * Math.sin(2 * year));
  const utcMinutes = (date.getTime() % DAY_MS) / 60_000;
  const solarMinutes = (((utcMinutes + sundialLead + 4 * LONGITUDE) % 1440) + 1440) % 1440;
  const hourAngle = solarMinutes / 4 - 180;

  const sinSin = Math.sin(LATITUDE * RAD) * Math.sin(declination);
  const cosCos = Math.cos(LATITUDE * RAD) * Math.cos(declination);
  return {
    elevation: Math.asin(sinSin + cosCos * Math.cos(hourAngle * RAD)) / RAD,
    hourAngle,
    hourAngleAt: (elevation) => Math.acos(Math.min(1, Math.max(-1, (Math.sin(elevation * RAD) - sinSin) / cosCos))) / RAD,
  };
}
