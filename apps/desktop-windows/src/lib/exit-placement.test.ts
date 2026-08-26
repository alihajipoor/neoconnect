import { describe, expect, it } from "vitest";
import { gamePlacement, type AppPlacement } from "./exit-placement";
import type { GameExitGroup } from "./game-apps";

/** What the card is allowed to say about where a game is.
 *
 * The four answers are deliberate and the fourth is why. With nothing
 * intercepting, `onPreferred` claims a match nobody established and
 * `fallback` claims a mismatch nobody established -- the same class of
 * claim as a "Connected" indicator that nothing checked, and customers
 * in Iran act on those.
 */

const RUST_LAUNCHER = String.raw`C:\Steam\steamapps\common\Rust\Rust.exe`;
const RUST_CLIENT = String.raw`C:\Steam\steamapps\common\Rust\RustClient.exe`;

const GERMANY = "aaaaaaaaaaaaaaaaaaaaaa";

function group(exit: string | null): GameExitGroup {
  return { slug: "rust", displayName: "Rust", names: ["Rust.exe", "RustClient.exe"], exit };
}

const APPS = [RUST_LAUNCHER, RUST_CLIENT];

describe("gamePlacement", () => {
  it("says a game is on its exit only when every binary reports so", () => {
    const placements: AppPlacement[] = [
      { app: RUST_LAUNCHER, placement: "onPreferred" },
      { app: RUST_CLIENT, placement: "onPreferred" },
    ];
    expect(gamePlacement(group(GERMANY), APPS, placements)).toEqual({ placement: "onPreferred" });
  });

  it("says fallback, and names the exit that was asked for", () => {
    // Fail-open: the game is still carried, on this session's exit. The
    // exit it wanted is named so the customer can act on it rather than
    // being told a state and no way out of it.
    const placements: AppPlacement[] = [
      { app: RUST_LAUNCHER, placement: "fallback", preferred: GERMANY },
      { app: RUST_CLIENT, placement: "fallback", preferred: GERMANY },
    ];
    expect(gamePlacement(group(GERMANY), APPS, placements)).toEqual({
      placement: "fallback",
      preferred: GERMANY,
    });
  });

  it("reports unknown when the service has not answered", () => {
    // The helper is a Windows service with its own lifetime and can be
    // restarting. Reporting "no preference" for a game the customer
    // chose an exit for would tell them their choice was lost.
    expect(gamePlacement(group(GERMANY), APPS, null)).toEqual({
      placement: "unknown",
      preferred: GERMANY,
    });
  });

  it("reports unknown when nothing is intercepting, which is the no-session case", () => {
    // What the service actually returns with no live session: it gates
    // the egress on interception being live, so every preference comes
    // back unknown. This is the state a customer sees before they have
    // connected at all, and it must stay reachable -- claiming
    // `onPreferred` here would assert a match nobody established.
    const placements: AppPlacement[] = [
      { app: RUST_LAUNCHER, placement: "unknown", preferred: GERMANY },
      { app: RUST_CLIENT, placement: "unknown", preferred: GERMANY },
    ];
    expect(gamePlacement(group(GERMANY), APPS, placements)).toEqual({
      placement: "unknown",
      preferred: GERMANY,
    });
  });

  it("reports unknown for a chosen exit the service has not been told about", () => {
    // The selection has not reached the service yet, or Custom mode is
    // off. Nothing has been established either way.
    expect(gamePlacement(group(GERMANY), APPS, [])).toEqual({
      placement: "unknown",
      preferred: GERMANY,
    });
  });

  it("reports no preference when none was chosen, with or without an answer", () => {
    expect(gamePlacement(group(null), APPS, null)).toEqual({ placement: "noPreference" });
    expect(gamePlacement(group(null), APPS, [])).toEqual({ placement: "noPreference" });
    expect(
      gamePlacement(group(null), APPS, [
        { app: RUST_LAUNCHER, placement: "noPreference" },
        { app: RUST_CLIENT, placement: "noPreference" },
      ]),
    ).toEqual({ placement: "noPreference" });
  });

  it("takes the least favourable answer any binary gave", () => {
    // A group's members are placed together or not at all, so they
    // agree in practice. When they do not, a game with one binary on
    // the wrong exit IS a game on the wrong exit -- rounding that up to
    // "on your exit" would hide the two-source-IP state this feature
    // exists to prevent, which is the one thing it must never do.
    const split: AppPlacement[] = [
      { app: RUST_LAUNCHER, placement: "onPreferred" },
      { app: RUST_CLIENT, placement: "fallback", preferred: GERMANY },
    ];
    expect(gamePlacement(group(GERMANY), APPS, split)).toEqual({
      placement: "fallback",
      preferred: GERMANY,
    });

    const partlyEstablished: AppPlacement[] = [
      { app: RUST_LAUNCHER, placement: "onPreferred" },
      { app: RUST_CLIENT, placement: "unknown", preferred: GERMANY },
    ];
    expect(gamePlacement(group(GERMANY), APPS, partlyEstablished)).toEqual({
      placement: "unknown",
      preferred: GERMANY,
    });
  });

  it("says nothing at all about a game with no binary in the selection", () => {
    // There is no claim to make: nothing of this game is being carried,
    // so a row about where it leaves from would be about nothing.
    expect(gamePlacement(group(GERMANY), [], null)).toBeNull();
    expect(gamePlacement(group(GERMANY), [String.raw`C:\Chat\chat.exe`], [])).toBeNull();
  });

  it("matches a binary whatever the casing, because Windows paths are", () => {
    // The picker's spelling and what a process reports do not always
    // agree. A miss here would silently downgrade a real answer to
    // unknown.
    const placements: AppPlacement[] = [
      { app: RUST_LAUNCHER.toUpperCase(), placement: "onPreferred" },
      { app: RUST_CLIENT.toLowerCase(), placement: "onPreferred" },
    ];
    expect(gamePlacement(group(GERMANY), APPS, placements)).toEqual({ placement: "onPreferred" });
  });
});
