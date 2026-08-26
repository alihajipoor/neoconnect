import type { PrismaClient } from "@prisma/client";
import { catalogueEntries, toSeedRow, validateCatalogue } from "./catalogue";

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
       * Used only by the per-game private exit, which is not built. */
      processNames: [
        "Battle.net.exe",
        "Agent.exe",
        "Wow.exe",
        "WowClassic.exe",
        "WowT.exe",
      ],

      /* Recorded so the prefix list can be derived and audited later.
       *
       * `destinationCidrs` is deliberately EMPTY and `prefixComplete` is
       * false. Blizzard announces roughly 151 prefixes and this codebase does
       * not have them; writing a plausible subset would be worse than writing
       * none, because a partial filter is exactly what puts WoW's Home and
       * World connections on opposite sides and manufactures the two-source-IP
       * signature that gets accounts flagged for sharing. The client refuses
       * to activate a private exit whose prefix set is incomplete, and this
       * row is the case that rule exists for. */
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
       * which lists the paths Riot says a VALORANT install needs open,
       * plus `UnrealCEFSubProcess.exe` from their "Your Firewall VS.
       * VALORANT" article.
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
        "UnrealCEFSubProcess.exe",
        "RiotClientServices.exe",
        "vgc.exe",
        "vgm.exe",
      ],

      /* Empty on purpose, exactly as the World of Warcraft row above is,
       * and for a sharper reason.
       *
       * Riot's AS6507 announces 36 IPv4 prefixes plus `2a04:82c0::/29`,
       * and that list is easy to fetch. It is also provably NOT the whole
       * of Riot: the per-region trace targets Riot itself publishes
       * include AWS Global Accelerator addresses (AS16509) for EU East,
       * Bahrain and Mumbai, and the login surface is on Cloudflare
       * (AS13335). So an AS6507 prefix list is precisely the plausible
       * subset the schema warns about -- a filter that would route some
       * of a session and not the rest. `prefixComplete` stays false, and
       * the client refuses to route by destination while it is. */
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
