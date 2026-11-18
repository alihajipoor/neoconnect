import { apiRequest, type ApiResult } from "./api";
import type { ReportDetails } from "./report-details";

/** "Send diagnostics to support": a bundle the customer chooses to send
 * (POST /customer/diagnostics, docs/client-diagnostics.md C), answered
 * with a short reference they can quote.
 *
 * The body is built once from its parts and shown to the customer as it
 * is (`bundleBody`), so what the "What will be sent" section shows is
 * exactly what goes. */

/** The server's bounds (send-diagnostics.dto.ts). */
export const NOTE_MAX = 500;
export const PLATFORM_TEXT_MAX = 16_000;

export interface BundleParts {
  platform: string;
  appVersion: string;
  details?: ReportDetails;
  /** The text "Copy diagnostics" gives, on Windows and Linux. */
  platformDiagnostics?: string;
}

export interface BundleBody extends BundleParts {
  note?: string;
}

export function bundleBody(parts: BundleParts, note: string): BundleBody {
  const trimmed = note.trim().slice(0, NOTE_MAX);
  return {
    platform: parts.platform.slice(0, 32),
    appVersion: parts.appVersion.slice(0, 32),
    ...(trimmed ? { note: trimmed } : {}),
    ...(parts.details ? { details: parts.details } : {}),
    ...(parts.platformDiagnostics ? { platformDiagnostics: parts.platformDiagnostics.slice(0, PLATFORM_TEXT_MAX) } : {}),
  };
}

export interface SentBundle {
  id: string;
  reference: string;
}

export async function sendDiagnostics(body: BundleBody): Promise<ApiResult<SentBundle>> {
  const result = await apiRequest<unknown>("/customer/diagnostics", { method: "POST", body: JSON.stringify(body) });
  if (!result.ok) return result;
  const data = result.data as { id?: unknown; reference?: unknown } | null;
  if (!data || typeof data.reference !== "string" || data.reference.length === 0) {
    // An answer without a reference is not one this screen can show as sent.
    return { ok: false, error: "Request failed (no reference)" } as ApiResult<SentBundle>;
  }
  return { ok: true, data: { id: typeof data.id === "string" ? data.id : "", reference: data.reference } };
}
