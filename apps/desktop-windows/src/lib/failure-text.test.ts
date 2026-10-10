import { readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the screens say about a request that failed, and in which language.
 *
 * The API layer's sentences are English, for the reports, and every
 * screen used to show them as they were: in Persian mode "Could not reach
 * Neoxify" was the one English line on the sign-in screen and in the
 * server list, which is where a customer on a filtered network meets it.
 * The results here come from the real request functions against a
 * simulated network, so what is pinned is what a screen is actually
 * handed, not a hand-built failure that might drift from it.
 */

const ENDPOINTS = ["https://a.example", "https://b.example"];

type Reply = { status: number; body?: unknown; html?: true } | "unreachable";
const replies: Record<string, Reply[]> = {};

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (url: string) => {
    const path = new URL(url).pathname;
    // The health race a write runs first: answered unless a test says
    // otherwise.
    if (path === "/health" && !replies[path]?.length) {
      return Promise.resolve(
        new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    const reply = replies[path]?.shift();
    if (reply === undefined || reply === "unreachable") return Promise.reject(new TypeError("network error"));
    return Promise.resolve(
      reply.html
        ? new Response("<html>Bad gateway</html>", { status: reply.status, headers: { "content-type": "text/html" } })
        : new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
    );
  },
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(ENDPOINTS),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
}));
vi.mock("./session", () => ({
  getTokens: () => Promise.resolve({ accessToken: "access", refreshToken: "refresh" }),
  setTokens: () => Promise.resolve(),
  clearTokens: () => Promise.resolve(),
}));

const { apiRequest, publicRequest, resetRaceWinnerForTests, BLOCKED_BY_NETWORK } = await import("./api");
const { failureText } = await import("./failure-text");
const { DICTIONARIES } = await import("./i18n");
type Key = keyof (typeof DICTIONARIES)["en"];

/** `t` as `useI18n()` builds it, for one language. */
const translator =
  (language: keyof typeof DICTIONARIES) =>
  (key: Key, vars?: Record<string, string | number>): string => {
    let text = DICTIONARIES[language][key];
    for (const [name, value] of Object.entries(vars ?? {})) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
const en = translator("en");
const fa = translator("fa");

beforeEach(() => {
  resetRaceWinnerForTests();
  for (const key of Object.keys(replies)) delete replies[key];
});

async function failureOf(result: Promise<{ ok: boolean }>) {
  const settled = await result;
  if (settled.ok) throw new Error("expected a failure");
  return settled as Extract<Awaited<ReturnType<typeof apiRequest>>, { ok: false }>;
}

describe("a request nothing answered", () => {
  it("says Neoxify could not be reached, in Persian when the app is in Persian", async () => {
    replies["/customer/subscriptions"] = ["unreachable", "unreachable"];
    const failure = await failureOf(apiRequest("/customer/subscriptions"));

    // The result itself stays English: it is what the reports carry.
    expect(failure.error).toMatch(/^Could not reach Neoxify/);
    expect(failureText(failure, fa)).toBe(DICTIONARIES.fa["api.unreachable"]);
    expect(failureText(failure, fa)).toMatch(/[؀-ۿ]/);
    expect(failureText(failure, fa)).not.toMatch(/Could not reach/);
    expect(failureText(failure, en)).toBe("Could not reach Neoxify. Check your internet connection.");
  });

  it("says Neoxify stopped responding when it had answered moments before", async () => {
    // The health race is answered; the write itself is not, anywhere.
    replies["/customer/vpn/claim"] = ["unreachable", "unreachable"];
    const failure = await failureOf(apiRequest("/customer/vpn/claim", { method: "POST", body: "{}" }));

    expect(failure.noResponse).toBe(true);
    expect(failureText(failure, fa)).toBe(DICTIONARIES.fa["api.stoppedAnswering"]);
    expect(failureText(failure, en)).toBe(DICTIONARIES.en["api.stoppedAnswering"]);
    // It was reached, so this is not the sentence that says it was not.
    expect(failureText(failure, en)).not.toBe(DICTIONARIES.en["api.unreachable"]);
  });
});

describe("a request whose network blocks Neoxify", () => {
  /** Every address's name led to the network's DNS block page. Before:
   * "check your internet connection", about a connection that works. */
  it("says the network is blocking Neoxify, in Persian when the app is in Persian", () => {
    const failure = { ok: false as const, error: BLOCKED_BY_NETWORK, noResponse: true as const, blockPage: true as const };

    expect(failureText(failure, fa)).toBe(DICTIONARIES.fa["api.blockedByNetwork"]);
    expect(failureText(failure, en)).toBe(DICTIONARIES.en["api.blockedByNetwork"]);
    expect(failureText(failure, en)).not.toMatch(/internet connection/);
  });
});

describe("a session that could not be renewed just now", () => {
  /** The backend answered with a 401, and the token refresh got nothing.
   * Before: "Could not renew your session just now. Try again in a
   * moment." in English, in Persian mode too, and the same whether the
   * refresh got no answer or a page did. */
  it("says the renewal got no answer, in the customer's language", async () => {
    replies["/customer/subscriptions"] = [{ status: 401, body: { message: "Unauthorized" } }];
    replies["/customer-auth/refresh"] = ["unreachable", "unreachable"];
    const failure = await failureOf(apiRequest("/customer/subscriptions"));

    expect(failure.sessionExpired).toBeFalsy();
    expect(failureText(failure, fa)).toBe(DICTIONARIES.fa["api.renewalUnanswered"]);
    expect(failureText(failure, en)).toBe(DICTIONARIES.en["api.renewalUnanswered"]);
  });

  it("says the renewal did not work when something answered it with an error", async () => {
    replies["/customer/subscriptions"] = [{ status: 401, body: { message: "Unauthorized" } }];
    replies["/customer-auth/refresh"] = [
      { status: 502, html: true },
      { status: 502, html: true },
    ];
    const failure = await failureOf(apiRequest("/customer/subscriptions"));

    expect(failureText(failure, fa)).toBe(DICTIONARIES.fa["api.renewalFailed"]);
    expect(failureText(failure, en)).not.toBe(DICTIONARIES.en["api.renewalUnanswered"]);
  });
});

describe("a request something answered", () => {
  it("says an error answered, with its status, and never that Neoxify could not be reached", async () => {
    // Every address answers with a proxy's 502 page: something replied.
    replies["/customer/subscriptions"] = [
      { status: 502, html: true },
      { status: 502, html: true },
    ];
    const failure = await failureOf(apiRequest("/customer/subscriptions"));

    expect(failure.status).toBe(502);
    expect(failureText(failure, en)).toBe("The server answered with an error (502). Please try again in a moment.");
    expect(failureText(failure, fa)).toBe(DICTIONARIES.fa["api.serverError"].replace("{status}", "502"));
    expect(failureText(failure, en)).not.toMatch(/could not reach/i);
    expect(failureText(failure, fa)).not.toBe(DICTIONARIES.fa["api.unreachable"]);
  });

  it("shows the backend's own refusal as the backend wrote it", async () => {
    replies["/customer-auth/forgot-password"] = [{ status: 400, body: { message: "email must be an email" } }];
    const failure = await failureOf(
      publicRequest("/customer-auth/forgot-password", { method: "POST", body: "{}" }),
    );

    expect(failureText(failure, fa)).toBe("email must be an email");
  });

  it("does not take a backend sentence for an unworded answer because of its status", () => {
    // A 503 the backend wrote for the customer keeps its words.
    expect(failureText({ error: "Try again in a minute.", status: 503 }, en)).toBe("Try again in a minute.");
    // And a failure from outside the API layer, which has neither flag,
    // shows its own sentence.
    expect(failureText({ error: "Could not reach the App Store. Please try again." }, fa)).toBe(
      "Could not reach the App Store. Please try again.",
    );
  });
});

/** Every screen that shows a failed request goes through `failureText`.
 *
 * Read from the source because these components have no test harness of
 * their own, and the failure this guards against is a new screen, or a
 * new branch in an old one, putting `result.error` on screen as it is --
 * which compiles, works in English, and is caught only by somebody
 * reading the app in Persian. */
describe("the screens", () => {
  const dirs = ["../screens", "../components"];
  const files = [
    ...dirs.flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, import.meta.url))
        .filter((name) => name.endsWith(".tsx"))
        .map((name) => ({ name: `${dir.slice(3)}/${name}`, source: readFileSync(new URL(`${dir}/${name}`, import.meta.url), "utf8") })),
    ),
    // The app's frame puts notices on the sign-in screen too: the
    // verification link's among them, which said "Could not reach Neoxify"
    // in English in a Persian app, unseen by a check of the two folders.
    { name: "App.tsx", source: readFileSync(new URL("../App.tsx", import.meta.url), "utf8") },
  ];

  it("never put a request's own sentence on screen as it is", () => {
    // A setter handed `something.error`, a ternary choosing one, or one
    // spliced into a template string: the shapes these sites had.
    const raw = /\bset[A-Z]\w*\(\s*\w+\.error\b|\?\s*\w+Result\.error\b|\$\{\s*\w+\.error\s*\}/g;
    const offenders = files.flatMap(({ name, source }) => (source.match(raw) ?? []).map((m) => `${name}: ${m}`));
    expect(offenders).toEqual([]);
  });

  it("words the verification link's notice through failureText", () => {
    const app = files.find((f) => f.name === "App.tsx")!;
    expect(app.source).toContain("failureText(result, say)");
  });

  it("covers the sign-in, the registration and the server list", () => {
    // The three the reports were about. Pinned by name, so the check
    // above cannot pass by every one of them moving somewhere it does not
    // look.
    for (const name of ["screens/Login.tsx", "screens/Register.tsx", "components/LocationPicker.tsx"]) {
      const file = files.find((f) => f.name === name);
      expect(file, name).toBeDefined();
      expect(file!.source, name).toContain("failureText(error, t)");
    }
  });

  /** Worded as the screen renders, not when the failure came in. A
   * sign-in sent while the app was still in English, and switched to
   * Persian by country detection while it waited, failed in English under
   * a right-to-left Persian screen; so did the dashboard's first load, and
   * the server list. Kept as it came, the failure is worded in whatever
   * language the app is in when it is drawn. */
  it("is worded when it is drawn, in the language the app is in then", () => {
    const sites = [
      ...["screens/Login.tsx", "screens/Register.tsx", "components/LocationPicker.tsx", "screens/Dashboard.tsx"].map(
        (name) => files.find((f) => f.name === name)!,
      ),
      { name: "mobile Dashboard", source: readFileSync(new URL("../../../mobile/src/screens/Dashboard.tsx", import.meta.url), "utf8") },
    ];
    for (const { name, source } of sites) {
      expect(source, name).not.toMatch(/set(Error|SwitchError)\(\s*failureText\(/);
      expect(source, name).not.toMatch(/\?\s*failureText\(\w+Result, t\)/);
    }
    for (const name of ["screens/Dashboard.tsx", "mobile Dashboard"]) {
      const { source } = sites.find((site) => site.name === name)!;
      expect(source, name).toContain('{error === "loadFailed" ? t("dash.loadFailed") : failureText(error, t)}');
    }
  });
});

describe("the dashboard's banner over the cached snapshot", () => {
  /** Every address answered the load with a page from in front of the
   * backend, or the backend answered it with its own error. Something
   * replied. Before: "Can't reach Neoxify right now", the sentence for
   * nothing having answered. */
  it("says the load was answered with an error, and what it was, when something answered", async () => {
    replies["/customer/me"] = [{ status: 502, html: true }, { status: 502, html: true }];
    const failure = await failureOf(apiRequest("/customer/me"));
    const { offlineReason, offlineText } = await import("./failure-text");

    const said = offlineText(offlineReason(failure), fa);
    expect(said.title).toBe(DICTIONARIES.fa["dash.offlineAnswered"]);
    expect(said.title).not.toBe(DICTIONARIES.fa["dash.offlineTitle"]);
    expect(said.detail).toBe(failureText(failure, fa));
  });

  it("says Neoxify cannot be reached only when nothing answered", async () => {
    replies["/customer/me"] = ["unreachable", "unreachable"];
    const failure = await failureOf(apiRequest("/customer/me"));
    const { offlineReason, offlineText } = await import("./failure-text");

    expect(offlineText(offlineReason(failure), en)).toEqual({ title: DICTIONARIES.en["dash.offlineTitle"], detail: null });
  });

  /** On screen while the load still waits: nothing has answered yet, and
   * nothing has given up either. */
  it("says it is still trying while the load waits", async () => {
    const { offlineText } = await import("./failure-text");
    expect(offlineText("trying", fa)).toEqual({ title: DICTIONARIES.fa["dash.offlineTrying"], detail: null });
  });

  /** Read from the source, for both clients. */
  it("is what both clients' dashboards draw", () => {
    for (const path of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      const screen = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(screen, path).toContain("{offlineText(offlineReason, t).title}");
      expect(screen, path).not.toContain('{t("dash.offlineTitle")}');
      expect(screen, path).toContain('const reason = failed && !failed.ok ? reasonFor(failed) : "unreached";');
    }
  });
});
