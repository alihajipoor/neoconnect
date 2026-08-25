import type { PrismaClient } from "@prisma/client";

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
        canaryHostname: profile.canaryHostname,
      },
      create: profile,
    });
  }

  return profiles.length;
}
