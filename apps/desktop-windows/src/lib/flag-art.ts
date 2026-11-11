import type { FlagArt } from "./flag-set";

/** Fetches the bundled flag set the first time a flag from it is wanted.
 *
 * The set (`flag-set.ts`) is a chunk of the app's own package: loading it
 * reads a file the app shipped with, never the network, so it works before
 * a tunnel is up and on a network that reaches nothing. It is loaded on
 * demand because most lists never need it -- the countries with servers
 * today are all drawn by hand in `Flag.tsx`. */

export type FlagSet = Readonly<Record<string, FlagArt>>;

/** `undefined` until the set has been asked for and has arrived; `null`
 * if it could not be loaded, which leaves the globe. */
let set: FlagSet | null | undefined;
let loading: Promise<FlagSet | null> | null = null;
const listeners = new Set<() => void>();

/** Starts the load once; every later call is the same promise. */
export function loadFlagSet(): Promise<FlagSet | null> {
  loading ??= import("./flag-set")
    .then(
      (module) => module.FLAG_SET,
      () => null,
    )
    .then((loaded) => {
      set = loaded;
      for (const listener of listeners) listener();
      return loaded;
    });
  return loading;
}

/** The set as it stands now, for `useSyncExternalStore`. */
export function flagSet(): FlagSet | null | undefined {
  return set;
}

export function subscribeFlagSet(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
