/**
 * What to tell an operator when the backend refuses a sign-in step.
 *
 * Every refusal used to read "Invalid email or password." (or, at the code
 * step, "Invalid code"), including the 400 LoginGuard sends when it wants
 * proof of work and the 429 of the per-address limit -- so an operator
 * with the right password was told it was wrong at exactly the moment
 * they were being kept out. Only a 401 means the credentials were wrong.
 */

interface ErrorBody {
  message?: unknown;
}

function messageOf(body: unknown): string | string[] | undefined {
  const message = (body as ErrorBody | null)?.message;
  if (typeof message === "string") return message;
  if (Array.isArray(message) && message.every((m) => typeof m === "string")) return message as string[];
  return undefined;
}

export function passwordFailure(status: number, body: unknown): string {
  const message = messageOf(body);
  if (status === 401) return "Invalid email or password.";
  if (status === 429) return "Too many sign-in attempts from your address. Wait a minute and try again.";
  if (status === 400) {
    // The ValidationPipe's list: a password under eight characters, which
    // no admin account has, so it cannot be the right one.
    if (Array.isArray(message) || message === undefined) return "Invalid email or password.";
    // LoginGuard asking for proof of work the form did not send. Its own
    // wording points customers at neoxify.net, which is not where an
    // operator signs in.
    if (message.startsWith("Too many recent sign-in attempts")) {
      return "Too many recent failed sign-ins for this account or from your address, and the security check could not be completed. Wait a few minutes and try again.";
    }
    // The security check itself: expired, already used, or minted easier
    // than the account's recent failures now require. Each says to try
    // again, which works: the form fetches a fresh one on every submit.
    return message;
  }
  return `The backend could not complete the sign-in (HTTP ${status}). Please try again.`;
}

export interface MfaFailure {
  error: string;
  /** Whether the code step is still usable. False sends the form back to
   * the password step. */
  keepToken: boolean;
}

export function mfaFailure(status: number, body: unknown): MfaFailure {
  const message = messageOf(body);
  if (status === 401) {
    if (message === "Invalid MFA code") return { error: "Invalid code. Please try again.", keepToken: true };
    if (typeof message === "string" && message.startsWith("Too many wrong codes")) {
      return { error: "Too many wrong codes for this account. Wait 15 minutes, then sign in again.", keepToken: false };
    }
    return { error: "This sign-in expired. Please sign in again.", keepToken: false };
  }
  if (status === 429) {
    return { error: "Too many attempts from your address. Wait a minute, then enter a fresh code.", keepToken: true };
  }
  if (status === 400) return { error: "Enter the 6-digit code from your authenticator app.", keepToken: true };
  return { error: `The backend could not check the code (HTTP ${status}). Please try again.`, keepToken: true };
}
