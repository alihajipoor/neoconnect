import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProgressLineView } from "../components/main/ProgressLine";
import { I18nProvider } from "./i18n";
import type { CountdownLine } from "./reconnect-countdown";

/** The reconnect's arrow (motion.css `.nx-subline[data-now] > svg`) turns
 * while an attempt is under way -- being dialled, or due this moment -- and
 * stands still through the countdown to the next one. It once did the
 * opposite: it turned for the instant before an attempt and stood still
 * for the whole attempt. */

function line(count: CountdownLine): string {
  return renderToStaticMarkup(
    createElement(I18nProvider, null, createElement(ProgressLineView, { routes: [], autoConnecting: false, rung: null, count })),
  );
}

describe("the reconnect line's arrow", () => {
  it("turns while an attempt is dialled", () => {
    expect(line({ kind: "attempt", attempt: 2, max: 6 })).toMatch(/<p class="nx-subline" data-progress="reconnect" data-now="">/);
  });

  it("turns when the next attempt is due now", () => {
    expect(line({ kind: "now", attempt: 2, max: 6 })).toMatch(/data-now=""/);
  });

  it("stands still through the countdown", () => {
    const html = line({ kind: "next", attempt: 2, max: 6, seconds: 3 });
    expect(html).toMatch(/<p class="nx-subline" data-progress="reconnect">/);
    expect(html).not.toContain("data-now");
  });
});
