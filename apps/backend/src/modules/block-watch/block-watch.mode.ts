/** BLOCK_WATCH, and what the reachability monitor needs to know of it,
 * apart from the service so that module can read it without importing
 * the block watch.
 *
 * off: nothing runs. record: verdicts are kept and shown in the panel,
 * nothing is sent. digest: also a daily digest, no pages (the calibration
 * stage). notify: pages for LIKELY_BLOCKED, the digest for the rest. */
export type BlockWatchMode = "off" | "record" | "digest" | "notify";
const MODES: readonly BlockWatchMode[] = ["off", "record", "digest", "notify"];

/** BLOCK_WATCH, read leniently: anything unrecognised is off. */
export function parseBlockWatchMode(raw: string | undefined | null): BlockWatchMode {
  const value = (raw ?? "").trim().toLowerCase() as BlockWatchMode;
  return MODES.includes(value) ? value : "off";
}

/** Written as a reachability alert's notifyError when it was not sent
 * because the block watch, paging, already has that server open: the
 * owner hears of it once, through the block watch, which lists these in
 * its daily digest. */
export const HELD_FOR_BLOCK_WATCH = "held: the block watch has this server open and tells the owner itself";
