/** Relative time for "when did this last happen" columns. The exact
 * timestamp belongs on hover, next to it.
 *
 * Rendered on the server for the pages that use it, so "now" is the
 * moment the page was built, which is also the moment its data was read. */
export function ago(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A duration in seconds as "2h 5m" / "4m" / "40s". */
export function duration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Megabytes with one decimal, for the "last 10 minutes" figures, where
 * formatBytes jumping between KB, MB and GB row to row makes a column
 * hard to compare at a glance. */
export function megabytes(bytes: string | number): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  const mb = value / (1024 * 1024);
  if (mb < 0.1) return "<0.1 MB";
  return `${mb.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}
