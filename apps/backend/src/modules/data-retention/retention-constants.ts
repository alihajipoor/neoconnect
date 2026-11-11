/** The owner's rule of 2026-11-11 (docs/usage-retention.md). No imports,
 * so the readers can use these without pulling in the retention job. */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 35 days of full detail in usage_records. Never fewer. */
export const USAGE_KEEP_DAYS = 35;
/** Finished agent_commands go after 7 days. */
export const COMMAND_KEEP_DAYS = 7;

/** A rolled-up hour can only be one before this far back: the usage
 * cutoff is never later than USAGE_KEEP_DAYS ago, rounded down to the
 * hour, and a reader counts an hour by its middle. A window starting
 * later than this reads the detailed rows alone, exactly as before. */
export const ROLLED_UP_BEFORE_MS = USAGE_KEEP_DAYS * DAY_MS - HOUR_MS;
