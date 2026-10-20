/** What Custom mode's own counters say is wrong, in the customer's
 * language.
 *
 * The service reads the counters on the path a chosen app's packets
 * actually travel and reports a code with an English sentence beside it
 * (`split_tunnel_problem_code`, `split_tunnel_problem`). The sentence used
 * to be shown as it came, so a Persian customer was told in English that
 * their chosen apps' traffic was going nowhere. The code is worded here in
 * both languages; a code this app does not know -- from a newer service --
 * is shown as the service's own sentence, which is the most it can say. */

import type { TranslationKey } from "./i18n";

const WORDS: Record<string, TranslationKey> = {
  injectionRefused: "dash.customProblemInjectionRefused",
  noReplies: "dash.customProblemNoReplies",
  noAppTraffic: "dash.customProblemNoAppTraffic",
  adapterGone: "dash.customProblemAdapterGone",
};

export type CustomModeProblem = { code: string | null; sentence: string };

/** The problem a status reports, or null when it reports none. A code
 * without its sentence is not a problem the service reported. */
export function readCustomModeProblem(status: { splitTunnelProblem?: string; splitTunnelProblemCode?: string }): CustomModeProblem | null {
  const sentence = typeof status.splitTunnelProblem === "string" ? status.splitTunnelProblem.trim() : "";
  if (!sentence) return null;
  const code = typeof status.splitTunnelProblemCode === "string" ? status.splitTunnelProblemCode : null;
  return { code, sentence };
}

/** The words for a problem: the app's own for a code it knows, else the
 * service's sentence. */
export function customModeProblemText(problem: CustomModeProblem, t: (key: TranslationKey) => string): string {
  const key = problem.code !== null && Object.prototype.hasOwnProperty.call(WORDS, problem.code) ? WORDS[problem.code] : null;
  return key ? t(key) : problem.sentence;
}
