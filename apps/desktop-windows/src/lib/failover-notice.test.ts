import { describe, expect, it, vi } from "vitest";
import { classifyConnectionError } from "./connection-errors";
import { failoverNotice, failoverText, rungFate, type FailedRung } from "./failover-notice";
import type { Language, TranslationKey } from "./i18n";

// attempts.ts and i18n.tsx reach for Tauri at import time through their
// store, version and API helpers; none of that is exercised here.
vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.reject(new Error("no store")) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("test") }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.reject(new Error("no network")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no tauri")) }));

const { failedDial } = await import("./attempts");
const { DICTIONARIES } = await import("./i18n");

/** What the screen says about where a connect landed, and what it says
 * when nothing could be dialled at all.
 *
 * The case this exists for, from the VM (p1-17): the network adapter was
 * switched off as Connect was pressed with fi-finland on screen. Every rung
 * failed at once in the service -- "no network connection with a gateway
 * was found", before anything was dialled -- and once the adapter came back
 * the pass landed on de-germany. The screen then said "Couldn't reach
 * fi-finland. Now on de-germany over Stealth": a claim about a server
 * nothing had asked. A server is named as unreachable only when it was
 * dialled and failed. */

const SERVICE_NO_NETWORK = "no network connection with a gateway was found";

function say(language: Language, key: TranslationKey, vars?: Record<string, string>): string {
  let text: string = DICTIONARIES[language][key];
  for (const [name, value] of Object.entries(vars ?? {})) text = text.split(`{${name}}`).join(value);
  return text;
}

/** The line as the dashboard renders it. */
function line(language: Language, failed: FailedRung[], crossed = true): string {
  const text = failoverText(
    failoverNotice({
      label: "Stealth",
      fromRegion: crossed ? "fi-finland" : null,
      toRegion: "de-germany",
      shownRouteId: "fi",
      failed,
    }),
  );
  const said = say(language, text.key, text.vars);
  return text.trailingLabel ? `${said} ${text.trailingLabel}` : said;
}

describe("a connect the service could not dial for want of a network", () => {
  it("is classified as no network, which dials nothing and blames no route", () => {
    const classified = classifyConnectionError(SERVICE_NO_NETWORK);
    expect(classified.kind).toBe("noNetwork");
    expect(classified.messageKey).toBe("err.noNetwork");
    expect(classified.detail).toBe(SERVICE_NO_NETWORK);
    expect(failedDial("fi", classified.kind)).toBeNull();
    expect(rungFate(classified.kind)).toBe("noNetwork");
  });

  it("says there is no network, in both languages", () => {
    const { messageKey } = classifyConnectionError(SERVICE_NO_NETWORK);
    expect(say("en", messageKey)).toBe("No network connection. Check that this device is online, then try again.");
    expect(say("fa", messageKey)).toBe(
      "اتصال شبکه برقرار نیست. مطمئن شوید این دستگاه به اینترنت وصل است و دوباره امتحان کنید.",
    );
  });
});

describe("a pass that landed elsewhere after rungs with no network", () => {
  /** p1-17's shape: five rungs refused for want of a network, two of them
   * on the server on screen, then the landing. */
  const noNetwork: FailedRung[] = [
    { routeId: "fi", fate: "noNetwork" },
    { routeId: "de", fate: "noNetwork" },
    { routeId: "fi", fate: "noNetwork" },
    { routeId: "fr", fate: "noNetwork" },
    { routeId: "tr", fate: "noNetwork" },
  ];

  it("says where it is now and does not blame the server on screen", () => {
    expect(line("en", noNetwork)).toBe(
      "No network connection at first, so fi-finland wasn't tried. Now on de-germany over Stealth",
    );
    expect(line("fa", noNetwork)).toBe(
      "ابتدا اتصال شبکه برقرار نبود، پس fi-finland امتحان نشد. اکنون de-germany با Stealth",
    );
    expect(line("en", noNetwork)).not.toContain("Couldn't reach");
  });

  it("does not say the usual protocol failed to get through, when it stayed in the country", () => {
    expect(line("en", noNetwork, false)).toBe("No network connection at first. Now using Stealth");
    expect(line("fa", noNetwork, false)).toBe("ابتدا اتصال شبکه برقرار نبود. اکنون از این استفاده می‌شود: Stealth");
  });
});

describe("a server named as unreachable", () => {
  it("is one that was dialled and failed", () => {
    const failed: FailedRung[] = [
      { routeId: "fi", fate: "noNetwork" },
      { routeId: "fi", fate: rungFate("serverUnreachable") },
    ];
    expect(line("en", failed)).toBe("Couldn't reach fi-finland. Now on de-germany over Stealth");
    expect(line("fa", failed)).toBe("دسترسی به fi-finland ممکن نشد. اکنون de-germany با Stealth");
  });

  it("is not one that failed before it was dialled for any other reason", () => {
    for (const kind of ["unknown", "serviceUnavailable", "engineMissing", "concurrentLimit"]) {
      const failed: FailedRung[] = [{ routeId: "fi", fate: rungFate(kind) }];
      expect(line("en", failed), kind).toBe(
        "Used de-germany over Stealth, not fi-finland. Pick a server to stay on it.",
      );
    }
  });

  it("is not one the pass never asked", () => {
    expect(line("en", [{ routeId: "fr", fate: "dialled" }])).toBe(
      "Used de-germany over Stealth, not fi-finland. Pick a server to stay on it.",
    );
  });

  /** A protocol that was dialled and failed before the landing is what the
   * old line says, and it still says it. */
  it("keeps the old line in the country when a rung was dialled", () => {
    expect(line("en", [{ routeId: "fi", fate: "noNetwork" }, { routeId: "fi", fate: "dialled" }], false)).toBe(
      "Your usual protocol didn't get through. Now using Stealth",
    );
  });
});
