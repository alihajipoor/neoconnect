/** What reflection can prove about persisted split-tunnel state, and
 * what it provably cannot.
 *
 * The rule under test is `docs/design/ban-safety.md` mechanism 4: an
 * exit lives on a game group and nowhere else, so a customer cannot put
 * `Rust.exe` and `RustClient.exe` on two exits by hand.
 *
 * **These tests are not the guard.** Types are erased before any of
 * this runs, so a test can only reflect over a *value*, and an optional
 * field is absent from values by definition -- reflection sees exactly
 * the fields that the realistic form of this regression
 * (`appExits?: AppExit[]`, additive, nothing complains) does not add.
 * The guard is `split-tunnel.invariants.ts`, which the compiler
 * enforces because the compiler is the only thing that sees an optional
 * field.
 *
 * What is left here is the half reflection is good at, and it is not
 * nothing: the shipped constant agreeing with the pinned type, and the
 * two runtime paths refusing to carry a per-application exit that
 * reached them anyway -- from a store file written by a build that is
 * not this one, which is a real thing that happens on a downgrade. */
import { beforeEach, describe, expect, it, vi } from "vitest";

let stored: unknown = null;
const invoked: { cmd: string; payload: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/plugin-store", () => ({
  load: () =>
    Promise.resolve({
      get: () => Promise.resolve(stored),
      set: () => Promise.resolve(),
      save: () => Promise.resolve(),
    }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload: Record<string, unknown>) => {
    invoked.push({ cmd, payload });
    return Promise.resolve();
  },
}));

const { EMPTY_SPLIT_TUNNEL, loadSplitTunnel, pushSplitTunnel } = await import("./split-tunnel");

/** The persisted key set, written out by hand a second time.
 *
 * Deliberately duplicated from `split-tunnel.invariants.ts` rather than
 * derived from the type: derived, it would agree with any change
 * automatically, which is the opposite of a guard. */
const PERSISTED_KEYS = ["enabled", "apps", "mode", "scopes", "games"];

/** Rust is the standing example because its split is systematic rather
 * than a corner case: Steam launches the EAC wrapper `Rust.exe`, which
 * spawns `RustClient.exe`. Both, or neither. */
const RUST = {
  slug: "rust",
  displayName: "Rust",
  names: ["Rust.exe", "RustClient.exe"],
  exit: "de-1",
};
const RUST_PATHS = [String.raw`C:\Steam\Rust\Rust.exe`, String.raw`C:\Steam\Rust\RustClient.exe`];

beforeEach(() => {
  stored = null;
  invoked.length = 0;
});

describe("the persisted settings shape", () => {
  it("ships exactly the fields the invariants file pins", () => {
    // Catches the *required* form of the regression, which has to be
    // added here too or the constant stops type-checking. The optional
    // form does not reach this test at all, which is the whole reason
    // the real assertion is a type and not this.
    expect(Object.keys(EMPTY_SPLIT_TUNNEL).sort()).toEqual([...PERSISTED_KEYS].sort());
  });

  it("has no field holding an exit outside the game groups", () => {
    const { games, ...rest } = EMPTY_SPLIT_TUNNEL;
    expect(games).toEqual([]);
    for (const key of Object.keys(rest)) {
      expect(key.toLowerCase()).not.toContain("exit");
    }
  });
});

describe("loadSplitTunnel", () => {
  it("drops a per-application exit a different build wrote to the file", async () => {
    // The downgrade case. split-tunnel.json outlives the build that
    // wrote it, so a field this build does not know about is not
    // hypothetical -- and reading one back as an exit preference would
    // apply a split nobody running this build could have made.
    stored = {
      enabled: true,
      apps: RUST_PATHS,
      mode: "onlySelected",
      scopes: [],
      games: [RUST],
      appExits: [
        { app: "Rust.exe", exit: "de-1", group: "rust" },
        { app: "RustClient.exe", exit: "nl-2", group: "rust" },
      ],
    };

    const settings = await loadSplitTunnel();

    expect(Object.keys(settings).sort()).toEqual([...PERSISTED_KEYS].sort());
    expect(settings).not.toHaveProperty("appExits");
    // The part it does understand still arrives, so this is a drop and
    // not a bail-out.
    expect(settings.games).toEqual([RUST]);
  });
});

describe("pushSplitTunnel", () => {
  it("derives the wire exits and forwards nothing else", async () => {
    // Even handed a settings object carrying a hand-built split at
    // runtime, the wire is built from exitsForGames. This is the last
    // place before the service, and it reads the groups, never a
    // per-application field.
    const smuggled = {
      enabled: true,
      apps: RUST_PATHS,
      mode: "onlySelected" as const,
      scopes: [],
      games: [RUST],
      appExits: [{ app: "RustClient.exe", exit: "nl-2", group: "rust" }],
    };

    await pushSplitTunnel(smuggled);

    expect(invoked).toHaveLength(1);
    const { cmd, payload } = invoked[0];
    expect(cmd).toBe("vpn_set_split_tunnel");
    // Pinned exactly, and it has to stay exact: the whole assertion is
    // that a smuggled `appExits` does not reach the service by simply
    // riding along. Loosening this to a containment check would let
    // exactly the field this file exists to refuse through.
    //
    // `egress` is a legitimate member. It is the one exit the *tunnel*
    // came up on -- one value for the whole connection, not a value per
    // application -- and it is a parameter of this function rather than
    // a field of the settings, so it is not persisted state and cannot
    // express a per-binary split. Its value semantics are asserted in
    // `split-tunnel-egress.test.ts`; what is asserted here is only that
    // the key set is these six and no more.
    expect(Object.keys(payload).sort()).toEqual(
      ["apps", "egress", "enabled", "exits", "mode", "scopes"].sort(),
    );
    // Nothing was established, so the honest answer is none -- and a
    // per-application exit could never appear here whatever it held.
    expect(payload.egress).toBeNull();

    // Both of Rust's binaries, on the group's one exit -- not the
    // smuggled `nl-2` for either of them.
    const exits = payload.exits as { app: string; exit: string; group: string }[];
    expect(exits.map((e) => e.exit)).toEqual(["de-1", "de-1"]);
    expect(new Set(exits.map((e) => e.app))).toEqual(new Set(RUST_PATHS));
    expect(exits.every((e) => e.group === "rust")).toBe(true);
  });
});
