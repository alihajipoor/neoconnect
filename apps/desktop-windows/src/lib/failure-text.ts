import { RENEWAL_FAILED, RENEWAL_UNANSWERED, requestFailed, STOPPED_ANSWERING, type RequestFailure } from "./api";
import type { TranslationKey } from "./i18n";

/** A failure as `failureText` reads it. A screen keeps one of these, not
 * the sentence, and words it as it renders: worded when the failure came
 * in, it was in the language the app was in when the request was sent,
 * and a sign-in sent in English while country detection switched the app
 * to Persian failed in English under a right-to-left Persian screen. */
export type ShownFailure = Pick<RequestFailure, "error"> &
  Partial<Pick<RequestFailure, "noResponse" | "status" | "blockPage">>;

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
 * Decided by what happened and not by the sentence:
 *
 *  - Nothing answered (`noResponse`). "Could not reach Neoxify" -- or,
 *    when Neoxify answered this sign-in's challenge or this write's health
 *    check moments before, that it stopped responding; or, when every
 *    address's name led to the network's DNS block page (`blockPage`),
 *    that the network is blocking Neoxify. Only these say Neoxify was not
 *    reached, because only here was it not.
 *  - The session could not be renewed (`RENEWAL_UNANSWERED`,
 *    `RENEWAL_FAILED`): the backend answered the request itself with a
 *    401, and its token refresh then got no answer, or an answer that was
 *    not a renewal. The API layer's own constants, so this is not matching
 *    a sentence somebody may reword.
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
export function failureText(failure: ShownFailure, t: Translate): string {
  if (failure.noResponse) {
    if (failure.blockPage) return t("api.blockedByNetwork");
    return t(failure.error === STOPPED_ANSWERING ? "api.stoppedAnswering" : "api.unreachable");
  }
  if (failure.error === RENEWAL_UNANSWERED) return t("api.renewalUnanswered");
  if (failure.error === RENEWAL_FAILED) return t("api.renewalFailed");
  if (failure.status !== undefined && failure.error === requestFailed(failure.status)) {
    return t("api.serverError", { status: failure.status });
  }
  return failure.error;
}

/** Why a dashboard is running on its cached snapshot, which its banner
 * says: still waiting for its load (`trying`), nothing answered the load
 * (`unreached`), the load was answered with an error, kept as it came --
 * or Neoxify has answered something since (`reached`), and the load is
 * being made again (offline-retry.ts).
 *
 * The banner says the last of these, not the first. Kept at `unreached`
 * once Neoxify had answered a claim and the queued reports, it said
 * "Can't reach Neoxify right now" above "You're protected" for as long as
 * the screen stayed open. */
export type OfflineReason = "trying" | "unreached" | "reached" | ShownFailure;

/** The banner's reason for a load that failed. "Can't reach Neoxify" only
 * when nothing answered it; an error answer -- the backend's, or a page
 * from in front of it -- is said as an error, with what it was. The banner
 * used to say Neoxify could not be reached for any failed load, a 500 from
 * the backend and a CDN's 502 page included. */
export function offlineReason(failure: ShownFailure): OfflineReason {
  return failure.noResponse ? "unreached" : failure;
}

/** The banner's words for `reason`: its title, and the failure in the
 * customer's language when the load was answered with one.
 *
 * No title for `reached`. Neoxify has just answered, so neither "can't
 * reach" nor "still trying" is true, and nothing is known yet about the
 * load being made again; what stays true until it lands is the line under
 * the title, that the servers and figures on screen are the saved ones
 * and may be out of date. */
export function offlineText(reason: OfflineReason, t: Translate): { title: string | null; detail: string | null } {
  if (reason === "trying") return { title: t("dash.offlineTrying"), detail: null };
  if (reason === "unreached") return { title: t("dash.offlineTitle"), detail: null };
  if (reason === "reached") return { title: null, detail: null };
  return { title: t("dash.offlineAnswered"), detail: failureText(reason, t) };
}
