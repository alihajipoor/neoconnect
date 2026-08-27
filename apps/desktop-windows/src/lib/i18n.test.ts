import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "./i18n";

/** Honesty and parity guards on the shipped strings.
 *
 * Key parity is already a compile error -- `fa` is declared
 * `Record<TranslationKey, string>`, so a missing key does not build. These
 * are the things the type system cannot see:
 *
 *  * A Persian value that is really the English one, pasted through. That
 *    compiles, ships, and is only caught by somebody who reads Persian.
 *  * A placeholder that survived in one language and not the other.
 *    `{count}` lost in translation renders as a sentence with a hole in it.
 *  * A claim the product has measured to be false. Gaming Mode is an
 *    access feature, not a latency one: Tehran to Blizzard EU is 72.0 ms
 *    direct and 72.8 ms through the best node in the fleet. Any string
 *    promising a faster or lower-ping connection is a lie, and users in
 *    Iran act on these strings.
 *  * The register. Persian here is plain formal «شما». Informal «تو» has
 *    been rejected three times.
 */

const { en, fa } = DICTIONARIES;
const keys = Object.keys(en) as (keyof typeof en)[];

/** `{name}`-style holes, which both languages must agree on. */
function placeholders(value: string): string[] {
  return (value.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();
}

describe("translation parity", () => {
  it("has a non-empty Persian string for every key", () => {
    const empty = keys.filter((k) => !fa[k] || fa[k].trim().length === 0);
    expect(empty).toEqual([]);
  });

  it("keeps the same placeholders in both languages", () => {
    const drifted = keys
      .filter((k) => placeholders(en[k]).join(",") !== placeholders(fa[k]).join(","))
      .map((k) => `${k}: en=${placeholders(en[k])} fa=${placeholders(fa[k])}`);
    expect(drifted).toEqual([]);
  });

  it("does not leave a Persian string as untranslated English", () => {
    // Compared on the letters only, so a shared number or a brand name in
    // Latin script does not read as a false positive.
    const lettersOnly = (v: string) => v.replace(/[^A-Za-z]/g, "").toLowerCase();
    const untranslated = keys.filter((k) => {
      const e = lettersOnly(en[k]);
      // Short values are legitimately identical across languages (a brand
      // name, "VPN", "IPv6"). Only a real sentence is evidence.
      return e.length > 12 && e === lettersOnly(fa[k]);
    });
    expect(untranslated).toEqual([]);
  });

  it("writes Persian in Persian script", () => {
    // Every Persian value that is a sentence must actually contain Persian
    // letters. Catches a key that was added to `en` and copied into `fa`
    // as a placeholder to make it compile.
    const notPersian = keys.filter((k) => fa[k].length > 12 && !/[؀-ۿ]/.test(fa[k]));
    expect(notPersian).toEqual([]);
  });
});

describe("what the strings are allowed to claim", () => {
  /** The measured verdict: the best path through the fleet is 0.8 ms worse
   * than not using it at all. See docs/design/gaming-mode.md and the
   * "never say" list in its section 11. */
  const SPEED_CLAIMS = [
    /\blower(s)? (your )?ping\b/i,
    /\bless lag\b/i,
    /\breduce(s)? (your )?(ping|lag|latency)\b/i,
    /\bfaster connection\b/i,
    /\bspeed(s)? up\b/i,
    /\boptimi[sz]ed route\b/i,
    /\bping بهتر\b/,
    /\bسریع‌تر می‌کند\b/,
    /\bپینگ (را )?کاهش\b/,
  ];

  /** Denials are the point, not the problem.
   *
   * `gaming.noSpeedClaim` exists precisely to say "does not promise a
   * faster connection", and a check that cannot tell a denial from a
   * promise would flag the one string doing the honest work -- and would
   * then be deleted by whoever hit it. So the scan is per sentence, and a
   * sentence carrying a negation is not a claim. */
  const NEGATIONS = /\b(not|never|no)\b|نمی|هیچ|نیست/i;

  it("never promises a faster connection or a lower ping", () => {
    const offenders: string[] = [];
    for (const k of keys) {
      for (const [langName, lang] of [
        ["en", en],
        ["fa", fa],
      ] as const) {
        for (const sentence of lang[k].split(/[.!?؟۔]|\s—\s/)) {
          if (NEGATIONS.test(sentence)) continue;
          for (const claim of SPEED_CLAIMS) {
            if (claim.test(sentence)) offenders.push(`${langName} ${k}: ${sentence.trim()}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /** Keys describing what the PRODUCT can do, where "yet" is a promise.
   *
   * Deliberately a list rather than a blanket ban. "No conversations yet"
   * is fine -- that empty state fills the moment the customer writes to
   * support. These are different: they describe capability that is not
   * being built, and "yet" turns each into a commitment. Every one of
   * these had the word and it was removed on 2026-08-25. */
  const NO_PROMISES = [
    "gaming.noResolver",
    "gaming.noResolverBody",
    "gaming.listEmpty",
    "settings.customGameEmpty",
    "settings.customGameWholeApp",
  ] as const;

  it("does not tell the customer to wait for something nobody is building", () => {
    for (const k of NO_PROMISES) {
      expect(`${k}: ${en[k]}`).not.toMatch(/\byet\b/i);
      expect(`${k}: ${fa[k]}`).not.toContain("هنوز");
    }
  });

  it("never tells a customer to wait for the resolver", () => {
    // "yet" promised a delivery nobody intends to make: no node serves the
    // DNS half of gaming mode and none is planned. See the DEAD BRANCH
    // section in apps/backend/src/modules/gaming/gaming.module.ts.
    expect(en["gaming.noResolver"]).not.toMatch(/\byet\b/i);
    expect(fa["gaming.noResolver"]).not.toContain("هنوز");
  });

  /** The DNS warning has to say both halves, and neither may drift.
   *
   * The tunnel is up when this shows -- the engines were made to bring
   * it up rather than refuse the connect -- so the string must not read
   * as "you are not connected". The lookups are NOT pinned to it, so it
   * must not read as "you are protected" either. A customer in Iran who
   * reads only the first clause still has to come away knowing which
   * part is not covered, because the missing rule is what lets their
   * ISP answer with a poisoned address for exactly the sites they
   * connected to reach. See engines::dns::TunnelDns. */
  it("says both halves of the unforced-DNS warning, in both languages", () => {
    // The good half: traffic is going through the VPN.
    expect(en["dash.tunnelDnsUnforced"]).toMatch(/through the VPN/i);
    expect(fa["dash.tunnelDnsUnforced"]).toContain("از VPN عبور می‌کند");

    // The bad half: DNS is not, and the provider can still answer.
    expect(en["dash.tunnelDnsUnforced"]).toMatch(/DNS/);
    expect(en["dash.tunnelDnsUnforced"]).toMatch(/internet provider/i);
    expect(fa["dash.tunnelDnsUnforced"]).toContain("DNS");
    expect(fa["dash.tunnelDnsUnforced"]).toContain("سرویس‌دهنده اینترنت");

    // And what to do about it, in both.
    expect(en["dash.tunnelDnsUnforced"]).toMatch(/reconnect/i);
    expect(fa["dash.tunnelDnsUnforced"]).toContain("دوباره وصل");

    // Never a reassurance. This string exists because something is not
    // covered; a "protected"/"secure"/"safe" in it would be the exact
    // dishonest state this product refuses to report.
    expect(en["dash.tunnelDnsUnforced"]).not.toMatch(/(protected|secure|safe|encrypted)/i);
    expect(fa["dash.tunnelDnsUnforced"]).not.toContain("محافظت");
    expect(fa["dash.tunnelDnsUnforced"]).not.toContain("امن");

    // Formal «شما», the register the rest of this dictionary uses.
    expect(fa["dash.tunnelDnsUnforced"]).toContain("شما");
    expect(fa["dash.tunnelDnsUnforced"]).not.toMatch(/تو/);
  });

  it("tells the customer what a catalogue entry actually is", () => {
    // The catalogue runs to 1,480 entries and nothing in it has been tested
    // against a running game. A long list reads as a compatibility list
    // unless something says otherwise.
    expect(en["gaming.pickerMeaning"]).toMatch(/none has been tested/i);
    expect(fa["gaming.pickerMeaning"]).toContain("آزمایش نشده");
  });

  it("says a game resolved nothing, and names what it looked for", () => {
    // A customer who picks a game and gets silence is being told
    // something false by omission. The catalogue's names come from the
    // Steam build of each title, so a non-Steam install can match none
    // of them -- proven for Old School RuneScape, whose row names
    // oslaunch.exe and osclient.exe while Jagex's own installer ships
    // JagexLauncher.exe. Retrying never fixes that, so the message has
    // to carry the names for the customer to see why.
    //
    // Read through an untyped view on purpose: before these keys
    // existed this was a failing assertion rather than a compile error,
    // which is what makes it evidence.
    const loose = en as Record<string, string | undefined>;
    const looseFa = fa as Record<string, string | undefined>;

    for (const dict of [loose, looseFa]) {
      const body = dict["settings.customGameNoneBody"];
      expect(body).toBeDefined();
      // What it looked for, and which game.
      expect(body).toContain("{names}");
      expect(body).toContain("{game}");
      expect(dict["settings.customGameNone"]).toContain("{game}");
      expect(dict["settings.customGameNoneAction"]).toBeDefined();
    }

    // And it must point at the path that actually works rather than at
    // the one that just failed. The old string said "start the game and
    // add it again", which is a loop when the names are wrong.
    expect(loose["settings.customGameNoneBody"]).toMatch(/running apps/i);
    expect(loose["settings.customGameNoneBody"]).not.toMatch(/add it again/i);
    expect(looseFa["settings.customGameNoneBody"]).toContain("در حال اجرا");
  });

  it("warns that Custom mode blocks ping, and does not pretend it is per-app", () => {
    // Measured on the rig: a game whose TCP was fully tunnelled still
    // sent 174 ICMP echo requests in the clear to ~170 of its world
    // servers. The tunnel cannot carry ICMP and nothing can attribute it
    // to a program, so it is blocked machine-wide -- and the customer has
    // to be told, because their in-game ping display stops working and
    // because any ping figure they do see is not the tunnel's.
    const loose = en as Record<string, string | undefined>;
    const looseFa = fa as Record<string, string | undefined>;

    for (const dict of [loose, looseFa]) {
      expect(dict["settings.customIcmpTitle"]).toBeDefined();
      expect(dict["settings.customIcmpBody"]).toBeDefined();
    }

    // The scope must be stated. "Your chosen apps' ping is blocked"
    // would be smaller than the truth and therefore a false promise.
    expect(loose["settings.customIcmpBody"]).toMatch(/every app on this computer/i);
    expect(looseFa["settings.customIcmpBody"]).toContain("همهٔ برنامه‌های این کامپیوتر");

    // And the standing Custom-mode line on the dashboard carries it too,
    // beside the IPv6 sentence, because it is a property of the mode
    // rather than news about this session.
    expect(en["dash.customActive"]).toMatch(/ping/i);
    expect(fa["dash.customActive"]).toContain("پینگ");
  });

  it("keeps Persian in the formal register", () => {
    // A sample of unambiguous informal (dovom-shakhs mofrad) verb endings.
    // «شما» takes «-ید»; these are the «تو» forms that have been rejected
    // three times. Deliberately narrow -- a broad pattern would fire on
    // legitimate words and get the test deleted.
    const INFORMAL = ["می‌کنی ", "می‌شی ", "بزنی ", "کنی.", "بزن.", "برو.", "ببین."];
    const offenders: string[] = [];
    for (const k of keys) {
      for (const form of INFORMAL) {
        if (fa[k].includes(form)) offenders.push(`${k}: ${fa[k]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
