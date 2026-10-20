import { beforeEach, describe, expect, it } from "vitest";
import { DICTIONARIES, type TranslationKey } from "./i18n";
import { currentNetwork, forgetShellProfile, noteWayOut, planLineText, rememberShellProfile } from "./shell-nav";

const say = (language: "en" | "fa") => (key: TranslationKey, vars?: Record<string, string | number>) =>
  DICTIONARIES[language][key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars?.[name] ?? ""));

/** The line under the avatar on the shell's other pages. It was kept as the
 * main page's sentence, so a language switched in Settings -- inside the
 * shell -- left it in the old one until the main page was drawn again. */
describe("the shell's plan line", () => {
  it("is worded in the language it is drawn in, digits included", () => {
    const plan = { daysLeft: 6, unlimited: true };
    expect(planLineText(plan, say("en"), "en")).toBe("6 days left · Unlimited");
    const fa = planLineText(plan, say("fa"), "fa");
    expect(fa).toContain("۶");
    expect(fa).toContain(DICTIONARIES.fa["dash.unlimited"]);
    expect(fa).not.toMatch(/[A-Za-z0-9]/);
  });

  it("says the plan when neither part is known, and nothing without one", () => {
    expect(planLineText({ daysLeft: null, unlimited: false }, say("en"), "en")).toBe(DICTIONARIES.en["tr.plan"]);
    expect(planLineText({ daysLeft: 1, unlimited: false }, say("en"), "en")).toBe(say("en")("tr.dayLeft", { n: "1" }));
    expect(planLineText(null, say("en"), "en")).toBeNull();
  });
});

/** Which network the Activity page reads this device's history under. It
 * took the main page's, from its last render: after a roam while another
 * page was open, the old network's results showed under "What works on
 * this network". */
describe("the network the pages outside the main page read", () => {
  const read = (id: string | null) => async () => id;
  const failing = async (): Promise<string | null> => {
    throw new Error("no helper");
  };

  beforeEach(() => {
    forgetShellProfile();
    rememberShellProfile({ email: null, plan: null, network: "home-wifi" });
    noteWayOut("eth0 via 192.0.2.1");
  });

  it("asks again, and takes what it is told over the main page's", async () => {
    expect(await currentNetwork(read("mobile-data"), read("eth0 via 192.0.2.1"))).toBe("mobile-data");
  });

  it("takes the main page's only while the way out is the one it last saw", async () => {
    // A tunnel owns the default route: the network cannot be read.
    expect(await currentNetwork(read(null), read("eth0 via 192.0.2.1"))).toBe("home-wifi");
    expect(await currentNetwork(failing, read("eth0 via 192.0.2.1"))).toBe("home-wifi");
    // Another way out: a network nobody has asked about.
    expect(await currentNetwork(read(null), read("wlan0 via 198.51.100.1"))).toBeNull();
    // None at all, or none that could be read.
    expect(await currentNetwork(read(null), read(""))).toBeNull();
    expect(await currentNetwork(read(null), failing)).toBeNull();
    expect(await currentNetwork(read(null))).toBeNull();
  });

  it("knows nothing the main page did not, nor after a sign-out", async () => {
    rememberShellProfile({ email: null, plan: null, network: null });
    expect(await currentNetwork(read(null), read("eth0 via 192.0.2.1"))).toBeNull();
    rememberShellProfile({ email: null, plan: null, network: "home-wifi" });
    forgetShellProfile();
    expect(await currentNetwork(read(null), read("eth0 via 192.0.2.1"))).toBeNull();
  });

  it("does not take a main page that never looked at the ways out", async () => {
    forgetShellProfile();
    rememberShellProfile({ email: null, plan: null, network: "home-wifi" });
    expect(await currentNetwork(read(null), read("eth0 via 192.0.2.1"))).toBeNull();
  });
});
