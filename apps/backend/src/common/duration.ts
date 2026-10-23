const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3_600, d: 86_400 };

/** "90s", "45m", "12h", "7d" (or a bare number of seconds) as seconds;
 * `fallback` for anything else, empty included -- an unset knob passed
 * through Compose arrives as "". */
export function durationSeconds(raw: string | undefined | null, fallback: number): number {
  const match = /^\s*(\d+)\s*([smhd]?)\s*$/i.exec(raw ?? "");
  if (!match) return fallback;
  const value = Number(match[1]) * (UNIT_SECONDS[match[2].toLowerCase()] ?? 1);
  return value > 0 ? value : fallback;
}
