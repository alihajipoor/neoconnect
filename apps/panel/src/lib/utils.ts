import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Formats a byte count (as a decimal string, since it may exceed
 * Number.MAX_SAFE_INTEGER for large plans) into a human-readable size. */
export function formatBytes(value: string | number): string {
  let bytes = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let unitIndex = 0;
  while (bytes >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    bytes /= 1024;
    unitIndex += 1;
  }
  return `${bytes % 1 === 0 ? bytes : bytes.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

/** Parses a human size like "10GB" or "512 MB" back into a byte count
 * string, for form input -> API payload conversion. */
export function parseBytesInput(input: string): string | null {
  const match = input.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!match) return null;
  const [, numStr, unitStr] = match;
  const num = Number(numStr);
  if (!Number.isFinite(num) || num < 0) return null;
  const unit = (unitStr ?? "GB").toUpperCase();
  const exponent = BYTE_UNITS.indexOf(unit as (typeof BYTE_UNITS)[number]);
  if (exponent < 0) return null;
  return Math.round(num * 1024 ** exponent).toString();
}
