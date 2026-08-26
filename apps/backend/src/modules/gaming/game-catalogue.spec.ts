import { seedGameProfiles } from "../../../prisma/game-profiles";

/** What this file guards.
 *
 * `prefixComplete` is a safety claim, not metadata. The client's
 * `canRouteByDestination` gate trusts it: when it is true, traffic to
 * `destinationCidrs` is carried and everything else from that app goes
 * direct. If the list is not actually complete, the game's simultaneous
 * connections split across two source addresses -- for World of Warcraft
 * the Home and World connections -- and that is the account-sharing
 * signature that gets people banned.
 *
 * So the catalogue has invariants that no type can express, and this is
 * the only place they can be checked:
 *
 *  * A profile that claims completeness must actually carry a list, and
 *    every entry must parse. `prefixComplete: true` with a malformed or
 *    empty list is the worst of both worlds -- the gate opens and the
 *    filter matches nothing.
 *  * Today's three profiles must NOT claim completeness. That was
 *    measured, not assumed: see docs/research/gaming-destination-prefixes.md.
 *    Blizzard's port-1119 service connection (`*.actual.battle.net`) is on
 *    Google Cloud AS396982 and Riot's entire login path is on Cloudflare
 *    AS13335, so neither publisher-ASN list can be complete by
 *    construction.
 *
 * The second assertion is deliberately a tripwire rather than a
 * prohibition. If someone genuinely establishes completeness for a game
 * they will have to come here and say so explicitly -- which is the
 * moment to re-read the research doc and re-run its §6 procedure. A flag
 * flipped in passing cannot slip through silently.
 *
 * What this file canNOT do is detect that a once-correct list has gone
 * stale. Publishers announce and withdraw prefixes; only re-measurement
 * catches that.
 */

/** A capturing stand-in for Prisma. The seed's only side effect is a
 * series of `upsert` calls, so recording their arguments gives us the
 * catalogue exactly as it would reach the database -- including the
 * `update`/`create` split, which is itself part of the safety story. */
type Upsert = {
  where: { slug: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
};

function capturingPrisma() {
  const calls: Upsert[] = [];
  const prisma = {
    gameProfile: {
      upsert: (args: Upsert) => {
        calls.push(args);
        return Promise.resolve(args.create);
      },
    },
  };
  // The seed is typed against the real PrismaClient; this stub implements
  // the one method it touches.
  return { prisma: prisma as unknown as Parameters<typeof seedGameProfiles>[0], calls };
}

/** Deliberately strict, and stricter than `new URL`-style leniency.
 *
 * Rejects the things that would silently mis-scope a filter rather than
 * fail loudly: a prefix length out of range, an octet over 255, a
 * shorthand like `10/8`, and -- the subtle one -- host bits set below the
 * mask. `137.221.64.1/24` looks fine to a human and is ambiguous to a
 * matcher: it is not a prefix, it is an address with a prefix length
 * stapled on. */
function parsesAsCidr(cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash < 0) return false;
  const addr = cidr.slice(0, slash);
  const lenText = cidr.slice(slash + 1);
  if (!/^\d+$/.test(lenText)) return false;
  const len = Number(lenText);

  if (addr.includes(":")) {
    // IPv6: shape check only, but the prefix length still has to be sane.
    if (len < 0 || len > 128) return false;
    return /^[0-9a-fA-F:]+$/.test(addr) && (addr.match(/::/g) ?? []).length <= 1;
  }

  if (len < 0 || len > 32) return false;
  const octets = addr.split(".");
  if (octets.length !== 4) return false;
  const nums = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;

  // Host bits below the mask must be zero.
  const value = ((nums[0] << 24) >>> 0) + (nums[1] << 16) + (nums[2] << 8) + nums[3];
  const hostBits = 32 - len;
  if (hostBits === 32) return value === 0;
  return (value & ((1 << hostBits) - 1) >>> 0) === 0;
}

/** Mirrors `canRouteByDestination` in
 * `apps/desktop-windows/src/lib/game-apps.ts`. Restated rather than
 * imported because it lives in a different workspace, and because the
 * point of the assertion is that the *seeded data* is refused by the rule
 * as the client states it. If the two ever diverge, that divergence is
 * the bug. */
function canRouteByDestination(p: { destinationCidrs?: string[]; prefixComplete?: boolean }) {
  return p.prefixComplete === true && (p.destinationCidrs?.length ?? 0) > 0;
}

describe("seeded game catalogue", () => {
  let calls: Upsert[];

  beforeAll(async () => {
    const cap = capturingPrisma();
    await seedGameProfiles(cap.prisma);
    calls = cap.calls;
  });

  it("seeds the three curated profiles, keyed by slug", () => {
    expect(calls.map((c) => c.where.slug)).toEqual(["wow", "valorant", "league-of-legends"]);
  });

  describe("the prefixComplete invariant", () => {
    it("never claims completeness with an empty list", () => {
      // The pair is one statement. `true` plus an empty list would open
      // the gate onto a filter that matches nothing.
      for (const c of calls) {
        const complete = c.create.prefixComplete as boolean;
        const cidrs = c.create.destinationCidrs as string[];
        if (complete) {
          expect(`${c.where.slug}: ${cidrs.length} cidrs`).not.toBe(`${c.where.slug}: 0 cidrs`);
        }
      }
    });

    it("every CIDR in every profile parses, complete or not", () => {
      for (const c of calls) {
        for (const cidr of c.create.destinationCidrs as string[]) {
          expect({ slug: c.where.slug, cidr, parses: parsesAsCidr(cidr) }).toEqual({
            slug: c.where.slug,
            cidr,
            parses: true,
          });
        }
      }
    });

    it("re-seeding refreshes prefixComplete together with the list it describes", () => {
      // Refreshing one without the other would either strand a corrected
      // list as unusable or -- far worse -- leave a partial one marked
      // whole. Both keys must be in the `update` branch, not only `create`.
      for (const c of calls) {
        expect(Object.keys(c.update)).toEqual(
          expect.arrayContaining(["destinationCidrs", "prefixComplete"]),
        );
      }
    });
  });

  describe("today's verdict, measured 2026-08-25", () => {
    /* docs/research/gaming-destination-prefixes.md. If one of these fails,
     * do not edit the assertion -- re-read that document first. */
    it.each([
      ["wow", "AS57976", "*.actual.battle.net is Google Cloud AS396982"],
      ["valorant", "AS6507", "the whole login path is Cloudflare AS13335"],
      ["league-of-legends", "AS6507", "the whole login path is Cloudflare AS13335"],
    ])("%s (%s) is not prefix-complete: %s", (slug, asn) => {
      const c = calls.find((x) => x.where.slug === slug);
      expect(c).toBeDefined();
      expect(c!.create.destinationAsn).toBe(asn);
      expect(c!.create.prefixComplete).toBe(false);
      expect(c!.create.destinationCidrs).toEqual([]);
    });

    it("so the client's gate refuses destination routing for every seeded profile", () => {
      // The end-to-end statement: destination scoping is inert, on
      // purpose, because no seeded profile is prefix-complete.
      for (const c of calls) {
        expect({
          slug: c.where.slug,
          routes: canRouteByDestination(c.create as never),
        }).toEqual({ slug: c.where.slug, routes: false });
      }
    });
  });

  describe("the CIDR parser itself", () => {
    // A permissive parser would make the invariant above vacuous.
    it("accepts well-formed prefixes", () => {
      for (const ok of ["137.221.64.0/24", "0.0.0.0/0", "2a04:e802::/32", "104.160.128.0/19"]) {
        expect({ cidr: ok, parses: parsesAsCidr(ok) }).toEqual({ cidr: ok, parses: true });
      }
    });

    it("rejects the shapes that would silently mis-scope a filter", () => {
      for (const bad of [
        "137.221.64.0", // no prefix length
        "137.221.64.1/24", // host bits set -- not a prefix
        "137.221.64.0/33", // length out of range
        "137.221.300.0/24", // octet over 255
        "10/8", // shorthand
        "137.221.64.0/", // empty length
        "not-an-address/24",
      ]) {
        expect({ cidr: bad, parses: parsesAsCidr(bad) }).toEqual({ cidr: bad, parses: false });
      }
    });
  });
});
