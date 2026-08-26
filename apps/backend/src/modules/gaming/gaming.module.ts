import { Module } from "@nestjs/common";
import { GamingController } from "./gaming.controller";
import { GamingService } from "./gaming.service";

/** Gaming Mode.
 *
 * Read `docs/design/gaming-mode.md` before extending any of this. Three
 * things from it are load-bearing and are repeatedly assumed away:
 *
 * 1. **It is not a lower-ping feature.** Measured from Tehran, the direct
 *    path to Blizzard's EU game server is 72.0 ms; the best path through our
 *    fleet is 72.8 ms and the other four nodes are 28-66 ms worse. Nothing
 *    here may be used to support a latency claim.
 * 2. **It cannot touch the game's own connections, by construction.** A
 *    GameProfile lists hostnames, and a game's realm/world addresses arrive
 *    inside its session as literals that no resolver ever sees. That is the
 *    feature's best property given (1), not a shortcoming.
 * 3. **The whole thing is gated on a measurement nobody has taken** --
 *    instrument #1, consumer-ISP reachability from inside Iran. Every Iranian
 *    probe available so far is a datacenter network, and none of them found
 *    anything blocked. If the consumer-ISP test comes back the same way, the
 *    premise is dead and that is a legitimate outcome.
 *
 * What exists today is the backend and the client. **There is no node-side
 * implementation**: no resolver process, no SNI proxy, no agent command and
 * no installer support. Until one exists, `GamingResolver.confirmedAt` is
 * never set by anything, so `profileForCustomer` always answers
 * `unavailableReason: "noResolver"` in production and no client can arm. That
 * is deliberate -- the alternative is an app that claims a mode is on while
 * nothing on the other end is listening.
 *
 * ---
 *
 * ## The DNS half is a DEAD BRANCH. It is not unfinished work.
 *
 * Decided 2026-08-25. Everything below about resolvers, `dohUrl`,
 * `GamingResolver`, `GamingResolverToken` and `unavailableReason:
 * "noResolver"` is **kept deliberately and is not waiting to be finished by
 * whoever reads this next**. Do not pick it up as a loose end.
 *
 * Two separate findings put it here, and they are different claims:
 *
 * 1. **DNS steering cannot reach a game's own servers, ever.** Not "not
 *    yet" -- by construction. A game that receives its server as a literal
 *    `IP:port` never performs a lookup the resolver could answer.
 *    Measured, not assumed: Activision's own matchmaking white paper
 *    contains zero occurrences of "DNS"; Riot hands the client an address;
 *    Epic returns a raw IP over HTTPS. This is point 2 above, restated as
 *    the limit it actually is.
 * 2. **The node side is not being built.** No node advertises a resolver,
 *    none is planned, and `docs/research/gaming-providers.md` recommends
 *    against building it. This is a decision, and it is the one that makes
 *    the code dead -- not finding 1.
 *
 * Those are worth keeping apart, because finding 1 does **not** kill the
 * mechanism outright. DNS + SNI steering would still work for the tier
 * that is hostname-based: launcher, login, account, store and patch
 * negotiation. That tier is exactly what the `wow` row's eleven hostnames
 * were measured for -- all of them answering HTTPS on 443 with a readable
 * SNI -- and reaching it is what Gaming Mode is *for*, now that the mode is
 * understood as an access product and not a latency one (point 1 above).
 * So the premise is sound and unbuilt, which is a different thing from
 * wrong.
 *
 * **Why it was kept rather than deleted.** Deleting it means dropping
 * `GamingResolver` and `GamingResolverToken`, which is a destructive
 * migration against a live database with beta users on it, to remove code
 * that costs one indexed query on a path that already returns early. The
 * migration could not be exercised here (no reachable Postgres), and an
 * untested destructive migration is a worse thing to put on main than a
 * clearly-labelled dormant branch. It would also delete the only designed
 * path to the launcher tier described above, which is the half of the idea
 * that survived.
 *
 * **What the customer is told.** `gaming.noResolver` used to end in "yet".
 * That word was removed on 2026-08-25: it promised a delivery nobody
 * intends to make. The string now says the mode is not available and that
 * this is not a temporary outage, and points at Custom mode, which needs
 * none of this and works today.
 *
 * **What would revive this.** A node-side resolver plus SNI proxy, an
 * agent command to run them, installer support, and something that sets
 * `confirmedAt` on a sweep. If that is ever built, scope it to the
 * hostname-based launcher tier and say so; do not let it be described as
 * routing the game. */
@Module({
  controllers: [GamingController],
  providers: [GamingService],
  exports: [GamingService],
})
export class GamingModule {}
