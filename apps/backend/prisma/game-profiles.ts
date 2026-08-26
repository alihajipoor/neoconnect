import type { PrismaClient } from "@prisma/client";
import { catalogueEntries, toSeedRow, validateCatalogue, validateProcessNames } from "./catalogue";

/** The curated game catalogue, seeded so a fresh install is not an empty
 * picker.
 *
 * Every hostname below came from the reachability sweep in
 * `docs/design/gaming-mode.md` §2.2 -- sixteen Blizzard hostnames probed from
 * four Iranian networks against German, Turkish and Finnish controls -- and
 * not from a blog post or a guess. Where a host is deliberately NOT
 * redirected, the reason is recorded beside it, because the omissions are the
 * part somebody will otherwise "fix" later and break.
 *
 * Idempotent: upserted by slug, so re-running it is safe and an operator's
 * edits to display fields are not clobbered by a redeploy. */
export async function seedGameProfiles(prisma: PrismaClient) {
  const profiles = [
    {
      slug: "wow",
      displayName: "World of Warcraft",
      publisher: "Blizzard Entertainment",
      iconKey: "wow",

      /* Launcher, login, account, web and store. Every one of these speaks
       * HTTPS on 443 with a readable SNI, which is what the node's proxy
       * forwards on. Anything that does not is in the exclude list below. */
      hostnames: [
        "oauth.battle.net",
        "account.battle.net",
        "us.battle.net",
        "eu.battle.net",
        "shop.battle.net",
        "eu.shop.battle.net",
        "worldofwarcraft.blizzard.com",
        "render.worldofwarcraft.com",
        "us.api.blizzard.com",
        "eu.api.blizzard.com",
        "us.forums.blizzard.com",
      ],

      /* Two different reasons to leave a host alone, and both matter.
       *
       * The CDN hosts are a billing decision: they serve multi-gigabyte
       * patches, and carrying those through a node eats a metered plan's cap.
       * The bill would be the customer's and the fault would be ours.
       *
       * The `*.actual.battle.net` pair is a correctness decision, and it is
       * the one that would actually break the product. Those hosts carry the
       * Battle.net service connection on port 1119, speaking Battle.net's own
       * protocol -- the measurement recorded them answering with non-HTTP
       * bytes on 1119 and timing out on 443 from every country including the
       * controls, which is to say they do not serve HTTPS at all. The node's
       * proxy routes on the SNI in a TLS ClientHello. There is no
       * ClientHello here, so redirecting these would hand the launcher an
       * address that cannot speak to it, and the customer would see a
       * Battle.net app that will not connect the moment they enable gaming
       * mode. They are listed explicitly rather than merely left out so that
       * anyone extending this list finds the reason before adding them. */
      excludeHostnames: [
        "blzddist1-a.akamaihd.net",
        "level3.blizzard.com",
        "cdn.blizzard.com",
        "us.cdn.blizzard.com",
        "eu.cdn.blizzard.com",
        "us.actual.battle.net",
        "eu.actual.battle.net",
      ],

      /* One row covers launcher and game together. The handover records
       * customers selecting one and getting half a product in Custom mode,
       * because nothing there said you needed both.
       *
       * `Agent.exe` -- the Blizzard Update Agent -- was here until
       * 2026-08-25 and was removed rather than kept. Blizzard's own
       * manifest names it, so its provenance was never the problem; the
       * problem is that the name is also used by a great deal of
       * enterprise monitoring, backup and MDM software. The client
       * resolves a catalogue name against every running process and
       * adds the full path of whatever matched, so a customer picking
       * World of Warcraft on a work laptop would have silently put
       * their employer's agent on the tunnel. It cannot be rescued by
       * writing it as a full path either: the catalogue validator
       * rejects a path where a bare filename belongs, and the client's
       * `curatedNames()` strips a path back to its basename before
       * matching. What is lost is the patcher, which carries downloads
       * that the CDN exclusions above already keep off the tunnel on
       * purpose. It is now on the generic-names denylist, so it cannot
       * come back by hand. */
      processNames: ["Battle.net.exe", "Wow.exe", "WowClassic.exe", "WowT.exe"],

      /* Recorded so the prefix list can be audited. It stays EMPTY, and
       * `prefixComplete` stays false -- and as of 2026-08-25 that is no
       * longer "we have not fetched the list yet". It is a measured
       * result: **a complete list cannot be built for this game.**
       *
       * Fetching AS57976's prefixes is trivial (RIPEstat: 151 IPv4 + 31
       * IPv6, window ending 2026-08-25T16:00Z). The problem is what they
       * do not contain. Of nineteen resolvable hostnames in this profile,
       * exactly two are inside AS57976 -- `cdn.blizzard.com` and
       * `telemetry-in.battle.net`, both things you would leave direct
       * anyway. The rest are Amazon, Akamai or Google.
       *
       * The disqualifying one is `*.actual.battle.net`, right above in
       * `excludeHostnames`. That port-1119 service connection is what
       * carries WoW's realm addresses to the client as literals -- and it
       * resolves into **Google Cloud AS396982**, not AS57976, from Germany
       * and from all four Iranian probe networks alike. So an AS57976
       * filter would route the realm connection and not the connection
       * that told the client which realm to dial, and would put the
       * account session and the game session on two source addresses at
       * once. That is precisely the account-sharing signature this flag
       * exists to prevent, manufactured by the filter itself.
       *
       * Three more disqualifiers, any one of which would be enough on its
       * own. Login (`oauth.battle.net`, the canary below) is AWS AS16509.
       * In-game voice is **Vivox, i.e. Unity/Multiplay AS35028**, UDP
       * 12000-54000 -- so an AS57976 filter breaks voice silently while
       * the game still connects, which is the worst thing this product
       * can do. And the addresses do not hold still: `eu.actual.battle.net`
       * alone answered from 8 different Google /16s within minutes, so
       * there is no stable set to enumerate -- while a list containing
       * Amazon plus Google plus Akamai plus Unity is a full tunnel with
       * extra steps, and would drag the metered patch downloads in with it.
       *
       * Checked, so nobody re-checks it: Blizzard's other two ASNs
       * (AS32163, AS55497) announce zero prefixes. AS57976 is the whole
       * in-house footprint; what is missing from it is missing from
       * Blizzard's network.
       *
       * Full evidence, and the procedure for judging the next game:
       * docs/research/gaming-destination-prefixes.md
       *
       * WHAT WOULD CHANGE THIS: Blizzard moving auth and the 1119 service
       * connection back onto its own network. Nothing short of that. Do
       * not flip this flag without re-running §6 of that document. */
      destinationAsn: "AS57976",
      destinationCidrs: [] as string[],
      prefixComplete: false,

      /* Chosen because it is the login surface: it answered 200 with an
       * identical 1048-byte body from all four Iranian networks on three
       * consecutive rounds, so a failure here is a real failure and not
       * noise. */
      canaryHostname: "oauth.battle.net",

      sortOrder: 10,
      isActive: true,
      notes:
        "Hostnames verified reachable from four Iranian datacenter networks on 2026-08-24 with German/Turkish/Finnish controls; every status matched its control. Consumer-ISP behaviour is UNMEASURED (design doc instrument #1) and is the gate on selling this.",
    },
    /* The two Riot rows exist for Custom mode, not for DNS mode, and that
     * is why they carry no hostnames at all.
     *
     * `hostnames` in this file means "names the node's SNI proxy will be
     * asked to forward", and the standard for putting one here is that it
     * was probed from Iranian networks against controls. No Riot name has
     * been. Worse, a resolution sweep on 2026-08-25 put Riot's login,
     * entitlements, client-config and the whole VALORANT control plane
     * (`auth.riotgames.com`, `entitlements.auth.riotgames.com`,
     * `clientconfig.rpg.riotgames.com`, `pd.*.a.pvp.net`,
     * `glz-*.a.pvp.net`) behind Cloudflare rather than on Riot's own
     * AS6507 -- and a community report of a Riot login still failing
     * *after* a successful split tunnel is exactly what a Cloudflare
     * refusal of datacenter address space looks like. Redirecting those
     * names before that is measured would be guessing.
     *
     * What these rows do carry is `processNames`, which needs no node at
     * all: the desktop client resolves them against running processes and
     * puts the real full paths into the split tunnel. */
    {
      slug: "valorant",
      displayName: "VALORANT",
      publisher: "Riot Games",
      iconKey: "valorant",

      hostnames: [] as string[],
      excludeHostnames: [] as string[],

      /* Taken from Riot's own "Configure your Firewall" support article,
       * which lists the paths Riot says a VALORANT install needs open.
       *
       * `UnrealCEFSubProcess.exe` came from Riot's "Your Firewall VS.
       * VALORANT" article and was removed on 2026-08-25. First-party
       * provenance does not make a name safe: this one belongs to
       * Unreal Engine's embedded-browser helper, not to VALORANT, and
       * every UE title that ships a CEF pane runs a process with the
       * same name. It identifies an engine, not a game. Matching it
       * would route whichever unrelated Unreal game happened to be
       * open. It carries the in-game browser pane, not gameplay
       * traffic, so dropping it costs nothing that matters here; it is
       * now on the generic-names denylist.
       *
       * Deliberately NOT the seven-executable list circulating in the
       * community and repeated in docs/research/gaming-providers.md. That
       * list drops `vgc.exe` and `vgm.exe` -- Vanguard's own two
       * network-facing user-mode binaries -- in favour of two crash
       * reporters. If the premise is that Vanguard must share the game's
       * path, omitting Vanguard is the one thing that cannot be omitted.
       *
       * `vgk.sys` is not here and cannot be: it is a kernel driver, not a
       * process with an image path, and nothing in the split tunnel can
       * match it. */
      processNames: [
        "VALORANT.exe",
        "VALORANT-Win64-Shipping.exe",
        "RiotClientServices.exe",
        "vgc.exe",
        "vgm.exe",
      ],

      /* Empty on purpose, exactly as the World of Warcraft row above is,
       * and for a sharper reason.
       *
       * Riot's AS6507 announces 36 IPv4 prefixes plus `2a04:82c0::/29`,
       * and that list is easy to fetch. It is also provably NOT the whole
       * of Riot. This was previously an inference; it was **measured on
       * 2026-08-25 and it holds more strongly than it was stated**: of 22
       * Riot hostnames resolved, exactly ONE is in AS6507
       * (`prod.euw1.lol.riotgames.com`, a League game server). Login,
       * entitlements, client config and the entire VALORANT control plane
       * -- `auth.riotgames.com`, `entitlements.auth.riotgames.com`,
       * `clientconfig.rpg.riotgames.com`, `pd.*.a.pvp.net`,
       * `glz-*.a.pvp.net` -- all carry explicit `.cdn.cloudflare.net`
       * CNAMEs into **AS13335**, which is proof of Cloudflare proxying and
       * not merely of Cloudflare-hosted address space.
       *
       * So an AS6507 filter would route the game session and none of the
       * things that have to happen before there is a session. That is
       * precisely the plausible subset the schema warns about.
       * `prefixComplete` stays false and the client refuses to route by
       * destination while it is.
       *
       * The consequence worth carrying forward: a Riot profile's missing
       * half is exit-IP reputation at Cloudflare, not routing, and nothing
       * in `destinationCidrs` can address that.
       * See docs/research/gaming-destination-prefixes.md §3. */
      destinationAsn: "AS6507",
      destinationCidrs: [] as string[],
      prefixComplete: false,

      canaryHostname: null as string | null,

      sortOrder: 20,
      isActive: true,
      notes:
        "Executables from Riot's first-party 'Configure your Firewall' + 'Your Firewall VS. VALORANT' articles, read 2026-08-25. NOT from the community error-68 list. UNPROVEN: no Riot title has been run behind this split tunnel, and Riot's own VAN 68 page never mentions VPNs -- do not let support claim this fixes error 68. Riot's stated position is to turn VPNs off. Login is Cloudflare-fronted, so a working split tunnel may still meet a refusal at auth.riotgames.com; that is the first thing to measure.",
    },
    {
      slug: "league-of-legends",
      displayName: "League of Legends",
      publisher: "Riot Games",
      iconKey: "league-of-legends",

      hostnames: [] as string[],
      excludeHostnames: [] as string[],

      /* Riot's own firewall article lists exactly seven paths for League.
       * That is almost certainly where the "seven executables" figure in
       * circulation came from -- it is a firewall exception list, not a
       * VPN remedy, and Riot never presents it as one.
       *
       * Eight names rather than seven because Riot's own pages disagree
       * with themselves on one file: the current firewall article says
       * `LeagueClientUxRenderer.exe`, their older connections
       * troubleshooting guide says `LeagueClientUxRender.exe`, and every
       * third-party file database says the shorter one. Only one of the
       * two exists on any given machine. Both are listed because the
       * client resolves names against processes that are actually
       * running: the spelling that does not exist simply never matches
       * and is reported as not found, whereas guessing wrong would leave
       * the renderer outside the tunnel with nothing said. */
      processNames: [
        "LeagueClient.exe",
        "LeagueClientUx.exe",
        "LeagueClientUxRender.exe",
        "LeagueClientUxRenderer.exe",
        "League of Legends.exe",
        "RiotClientServices.exe",
        "vgc.exe",
        "vgm.exe",
      ],

      /* Same measured verdict as the valorant row -- and League is the
       * title that supplies the lone AS6507 hit
       * (`prod.euw1.lol.riotgames.com`). One game server inside the ASN
       * and the whole login path outside it is the worst possible split,
       * not a promising start.
       * See docs/research/gaming-destination-prefixes.md §3. */
      destinationAsn: "AS6507",
      destinationCidrs: [] as string[],
      prefixComplete: false,

      canaryHostname: null as string | null,

      sortOrder: 30,
      isActive: true,
      notes:
        "Executables from Riot's first-party 'Configure your Firewall' article, read 2026-08-25. Two spellings of the LCU renderer are listed because Riot's own pages disagree; exactly one will ever resolve. UNPROVEN on a real install -- see the valorant row.",
    },
  ];

  /* The hand-written rows go through the same executable-name rules as the
   * bulk catalogue, and for the same reason the bulk catalogue does: a
   * generic name here routes whatever unrelated program is running under
   * it, and the customer is never told.
   *
   * These three rows predate `generic-names.json` and were the only rows it
   * did not cover, which is exactly how `Agent.exe` and
   * `UnrealCEFSubProcess.exe` stayed in the product after the denylist
   * landed. They could not simply be passed to `validateCatalogue`: that
   * refuses a reserved slug, and these three rows own all three reserved
   * slugs, so it would have reported the reservation rather than the name.
   * Hence the narrower `validateProcessNames`.
   *
   * Thrown rather than warned, matching `seedCatalogue` below. The seed is
   * the last point at which a bad name is still cheap; past here it is in
   * the database and on its way to every client. */
  const nameProblems = profiles.flatMap((profile) =>
    validateProcessNames(profile.processNames).map((problem) => `  ${profile.slug}: ${problem}`),
  );
  if (nameProblems.length > 0) {
    throw new Error(
      `Hand-written game profiles failed executable-name validation ` +
        `(${nameProblems.length} problems):\n${nameProblems.join("\n")}`,
    );
  }

  for (const profile of profiles) {
    await prisma.gameProfile.upsert({
      where: { slug: profile.slug },
      // Only the operational lists are refreshed on re-seed. Display fields
      // and `isActive` are left alone so a redeploy cannot un-hide a game the
      // operator deliberately switched off.
      update: {
        hostnames: profile.hostnames,
        excludeHostnames: profile.excludeHostnames,
        processNames: profile.processNames,
        destinationAsn: profile.destinationAsn,
        // Refreshed together, and they have to be: the pair is one
        // safety statement. Re-seeding a corrected prefix list while
        // leaving a stale `prefixComplete` behind would either strand a
        // complete list as unusable or, far worse, leave a partial one
        // marked whole.
        destinationCidrs: profile.destinationCidrs,
        prefixComplete: profile.prefixComplete,
        canaryHostname: profile.canaryHostname,
      },
      create: profile,
    });
  }

  return profiles.length + (await seedCatalogue(prisma));
}

/** Seeds the bulk catalogue from `catalogue/`.
 *
 * Separate from the three rows above because it is a different kind of data
 * and deserves to be read as one. Those three carry measurements -- probed
 * hostnames, a canary, an exclusion list with a reason beside it. These carry
 * one fact each: the executables a game runs under. Both are legitimate; only
 * the first kind can drive DNS mode, and mixing them in one array would blur
 * a distinction the schema depends on.
 *
 * The three hand-written slugs are reserved, so nothing here can displace
 * them -- `catalogueEntries()` drops any bulk entry that claims one, and
 * `validateCatalogue` fails the seed if one tries.
 *
 * Idempotent by slug, matching the loop above. `sortOrder` is assigned from
 * position: the curated tier and the online titles come first, so the picker
 * opens on games somebody might plausibly be here for rather than on
 * whatever sorts first alphabetically. It starts at 1000 to leave the
 * hand-written rows (10, 20, 30) and any future measured profile in front. */
async function seedCatalogue(prisma: PrismaClient): Promise<number> {
  const entries = catalogueEntries();

  // Checked here rather than only in the test suite, because the seed is the
  // last point at which a bad entry is still cheap. A malformed process name
  // that reaches the database reaches every client, and the failure it
  // produces there -- a game that looks supported and routes nothing -- is
  // invisible from the server side.
  const problems = validateCatalogue(entries);
  if (problems.length > 0) {
    const shown = problems.slice(0, 20).map((p) => `  ${p.slug}: ${p.problem}`);
    const rest = problems.length > shown.length ? `\n  ... and ${problems.length - shown.length} more` : "";
    throw new Error(`Game catalogue failed validation (${problems.length} problems):\n${shown.join("\n")}${rest}`);
  }

  const rows = entries.map((entry, index) => toSeedRow(entry, 1000 + index));

  // Chunked rather than one `Promise.all` over every row: a thousand
  // concurrent upserts exhausts the connection pool, and one transaction
  // holding a thousand statements is a long lock on a table the API reads.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.$transaction(
      rows.slice(i, i + CHUNK).map((row) =>
        prisma.gameProfile.upsert({
          where: { slug: row.slug },
          // Same rule as above: refresh the operational lists, leave display
          // fields and `isActive` alone so a redeploy cannot un-hide a game
          // an operator deliberately switched off.
          update: {
            processNames: row.processNames,
            destinationCidrs: row.destinationCidrs,
            prefixComplete: row.prefixComplete,
          },
          create: row,
        }),
      ),
    );
  }

  return rows.length;
}
