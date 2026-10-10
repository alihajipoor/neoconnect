import { requestFailed, STOPPED_ANSWERING, type RequestFailure } from "./api";
import type { TranslationKey } from "./i18n";

/** `t` from `useI18n()`, or anything shaped like it. */
type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** What a screen shows for a failed request, in the customer's language.
 *
 * The API layer words its failures in English, for the reports (see
 * `unreachable` in api.ts), and every screen used to put that sentence in
 * front of the customer as it was. In Persian mode the one message a
 * customer on a filtered network sees most, "Could not reach Neoxify",
 * was the one line on the screen in English.
 *
 * Three cases, decided by what happened and not by the sentence:
 *
 *  - Nothing answered (`noResponse`). "Could not reach Neoxify" -- or,
 *    when Neoxify answered this sign-in's challenge or this write's health
 *    check moments before, that it stopped responding. Only these two say
 *    Neoxify was not reached, because only here was it not.
 *  - Something answered with an error and nothing to say about it
 *    (`requestFailed`): a page from in front of the backend, a CDN's bot
 *    check, a proxy's 502. Said to be an error answer, with its status,
 *    and never as Neoxify being out of reach, because something replied.
 *    Not said to be Neoxify's either: it may not have been.
 *  - The backend's own refusal. Its sentence, as the backend wrote it.
 *
 * Takes any failure with an `error`; the flags are optional, so a result
 * from outside the API layer (a store purchase, a provider's refusal)
 * shows its own sentence, as before. */
export function failureText(
  failure: Pick<RequestFailure, "error"> & Partial<Pick<RequestFailure, "noResponse" | "status">>,
  t: Translate,
): string {
  if (failure.noResponse) {
    return t(failure.error === STOPPED_ANSWERING ? "api.stoppedAnswering" : "api.unreachable");
  }
  if (failure.status !== undefined && failure.error === requestFailed(failure.status)) {
    return t("api.serverError", { status: failure.status });
  }
  return failure.error;
}
