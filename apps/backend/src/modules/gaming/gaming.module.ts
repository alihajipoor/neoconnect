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
 * nothing on the other end is listening. */
@Module({
  controllers: [GamingController],
  providers: [GamingService],
  exports: [GamingService],
})
export class GamingModule {}
