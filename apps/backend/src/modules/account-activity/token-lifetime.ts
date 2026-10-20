/** How long a refresh token lives, in milliseconds, from the value
 * `CUSTOMER_JWT_REFRESH_TTL` holds -- or null when it cannot be read.
 *
 * jsonwebtoken takes `expiresIn` as a number of seconds, or a string in
 * the `ms` package's format: "7d", "12h", "2 days", and -- the trap -- a
 * bare number in a string is MILLISECONDS ("604800" is ten minutes, not
 * a week). The environment always supplies a string, so a bare number is
 * read the way jsonwebtoken will read it.
 *
 * Its own parser rather than a dependency: `ms` is only a transitive one
 * here, and this needs nothing past the forms above. A value it cannot
 * read gives null, and the caller falls back to the longest a session can
 * live at all -- listing a device that may be signed out, never hiding
 * one that is not. */
export function tokenLifetimeMs(value: string | number | undefined | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value * 1000 : null;
  if (typeof value !== "string" || value.length > 100) return null;
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)\s*$/i.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = UNITS[match[2].toLowerCase()];
  if (unit === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  return amount * unit;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The `ms` package's units, every spelling it accepts. */
const UNITS: Record<string, number> = {
  "": 1,
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: SECOND,
  sec: SECOND,
  secs: SECOND,
  second: SECOND,
  seconds: SECOND,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
  w: 7 * DAY,
  week: 7 * DAY,
  weeks: 7 * DAY,
  y: 365.25 * DAY,
  yr: 365.25 * DAY,
  yrs: 365.25 * DAY,
  year: 365.25 * DAY,
  years: 365.25 * DAY,
};
