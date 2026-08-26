/** Compile-time proof that a customer cannot hand-build a game split.
 *
 * The rule this file holds, stated once: **an exit lives on a game
 * group and nowhere else in persisted state.** A field that can hold an
 * exit per *application* is a field in which `Rust.exe` and
 * `RustClient.exe` can name two different exits, and one account's
 * connections arriving from two source addresses at the same instant is
 * the account-sharing signature publishers ban for. See
 * `docs/design/ban-safety.md` mechanism 4 and
 * `docs/design/per-game-exits.md` section 5.1.
 *
 * # Why this exists as types rather than as more shell
 *
 * `scripts/check-exit-groups.sh` used to be the only thing asserting
 * this, by grepping `SplitTunnelSettings` for a line matching
 * `^\s*exits\s*:`. That catches exactly one spelling of one shape of
 * the mistake. It does not catch `appExits?: AppExit[]` -- a different
 * name, and an optional marker the pattern never allowed for -- and
 * `tsc` did not catch it either, because an optional field nothing
 * reads is legal everywhere. Optional-and-additive is how such a field
 * would realistically arrive: someone adds it for a plausible reason,
 * nothing complains, and the structural guarantee is gone with no test
 * failing.
 *
 * A runtime test cannot close that hole either, and it is worth being
 * explicit about why, because it is the obvious thing to reach for.
 * Types are erased, so a test can only reflect over a *value* --
 * `EMPTY_SPLIT_TUNNEL`, a stored file -- and an optional field is
 * absent from values by definition. Reflection sees exactly the fields
 * an optional regression does not add. `split-tunnel.test.ts` reflects
 * over the value anyway, for the things reflection *can* prove (the
 * constant matching the type, and the read path dropping keys it does
 * not know), but it cannot be the guard.
 *
 * The compiler is the only instrument that sees an optional field, so
 * the assertion belongs here. `tsc --noEmit` runs in CI as part of
 * `turbo run typecheck`, and `check-exit-groups.sh` additionally asserts
 * this file still exists and still asserts, so deleting it is as loud as
 * breaking it.
 *
 * # How to read a failure
 *
 * Every assertion below is `Proof<...>`, which only accepts `true`. A
 * break reads as *"Type 'false' does not satisfy the constraint 'true'"*
 * on the named alias. The alias name says which rule broke and the
 * comment above it says why it matters.
 */

import type { GameExitGroup } from "./game-apps";
import type { AppExit, AppScope, SplitTunnelSettings } from "./split-tunnel";

/** Accepts only `true`. Instantiating it with `false` is a type error,
 * which is the whole mechanism. */
type Proof<T extends true> = T;

/** Identical, not merely mutually assignable.
 *
 * The deferred-conditional trick rather than a pair of `extends`
 * checks: `{ a: string }` and `{ a: string; b?: never }` are assignable
 * both ways, and an optional field is precisely what has to be visible
 * here. */
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** The element type of an array-valued field, or the field's own type.
 * Distributes, so a union of fields becomes a union of shapes. */
type Element<T> = T extends readonly (infer U)[] ? U : T;

/** Every shape reachable in the persisted settings, one array level
 * down, with `undefined` stripped -- so an *optional* field contributes
 * its shape here exactly as a required one does. That is the whole
 * point: this is the step the shell pattern could not take. */
type PersistedShape = Element<NonNullable<SplitTunnelSettings[keyof SplitTunnelSettings]>>;

/* ------------------------------------------------------------------ *
 * 1. The persisted key set, pinned exactly.
 *
 * Name-agnostic and shape-agnostic: *any* new field on the settings
 * that go to disk breaks this, optional or required, whatever it is
 * called and whatever it holds. That is deliberate and it is the
 * tripwire the other assertions rely on -- a field can only reach the
 * shape rules below by first being named here, which is a line someone
 * has to write on purpose while looking at this file.
 *
 * If you are adding a legitimate field: add it here, and read the rest
 * of this file before you do.
 * ------------------------------------------------------------------ */

export type PersistedSettingsKeysArePinned = Proof<
  Identical<keyof SplitTunnelSettings, "enabled" | "apps" | "mode" | "scopes" | "games">
>;

/** The two shapes the settings carry, pinned for the same reason. An
 * exit smuggled into one of *these* would not change
 * `keyof SplitTunnelSettings` at all. */
export type ScopeKeysArePinned = Proof<Identical<keyof AppScope, "app" | "destinations">>;

export type GroupKeysArePinned = Proof<
  Identical<keyof GameExitGroup, "slug" | "displayName" | "names" | "exit">
>;

/* ------------------------------------------------------------------ *
 * 2. No per-application exit in persisted state.
 *
 * The rule itself, stated structurally rather than by field name, so
 * that it holds against a field called `appExits`, `perAppExit`,
 * `exitFor`, or anything else somebody thinks of.
 * ------------------------------------------------------------------ */

/** The wire type is a *wire* type. It is produced by `exitsForGames`,
 * handed straight to the service, and never written to disk. Reaching
 * it from `SplitTunnelSettings` -- by any field, under any name,
 * optional or required -- is the split becoming representable. */
export type WireExitIsNotPersisted = Proof<Identical<Extract<PersistedShape, AppExit>, never>>;

/** Shapes with a key that names an exit. `keyof` sees optional keys,
 * which is what the source pattern could not. */
type ExitKey = `${string}exit${string}` | `${string}Exit${string}`;

type ExitBearing<T> = T extends unknown
  ? [Extract<keyof T, ExitKey>] extends [never]
    ? never
    : T
  : never;

/** The one shape allowed to carry an exit: a group keyed on a *game*
 * -- a catalogue slug and the whole list of binaries that slug covers.
 * Membership is what makes an exit safe to hold, because it is what
 * makes "all of this game or none of it" expressible at all. */
type GameKeyed<T> = T extends { slug: string; names: string[] } ? T : never;

/** Anything else carrying an exit is a per-application exit whatever it
 * is called -- `{ app, exit }`, `{ path, exit }`, an `exit` grown onto
 * `AppScope`. All of them let one game's binaries name two exits. */
export type ExitLivesOnlyOnTheGameGroup = Proof<
  Identical<Exclude<ExitBearing<PersistedShape>, GameKeyed<PersistedShape>>, never>
>;

/* ------------------------------------------------------------------ *
 * 3. One exit per group, and one group per wire entry.
 *
 * The split has two more shapes that add a field to nothing and so
 * would pass both the source pattern and the key-set pin above.
 * ------------------------------------------------------------------ */

/** `exit: string[]` on the group would put one game on several exits
 * without any per-application field existing anywhere -- the exact
 * outcome this whole feature refuses, arriving through the one field
 * that is *supposed* to hold an exit. Singular or absent, nothing
 * else. */
export type GroupHasOneExitOrNone = Proof<Identical<GameExitGroup["exit"], string | null>>;

/** `group` must stay required on the wire entry. An `AppExit` with no
 * group is a preference for one executable that claims nothing about a
 * game: the service's own all-or-nothing check has nothing to hold it
 * against, and `SplitTunnelConfig::validate` cannot tell a whole game
 * from a launcher placed alone. Making it `group?: string` is a
 * one-character, entirely optional edit that removes the trust
 * boundary's only handle. */
export type WireExitAlwaysNamesItsGame = Proof<
  Identical<AppExit, { app: string; exit: string; group: string }>
>;
