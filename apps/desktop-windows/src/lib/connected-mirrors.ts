/** The connected server's own mirrors, while that server is reached
 * around the tunnel -- held where a race can ask about them.
 *
 * `apiEndpoints` puts them last meanwhile (`aroundServer` in
 * api-endpoints.ts): a request to one goes over the bare line, a TLS
 * handshake carrying the mirror's name beside the tunnel. A race then
 * re-sorted that list by what has failed on this network (`demotedLast`),
 * which moves every address not demoted ahead of every demoted one -- so
 * on a filtered line where only that mirror had answered before the
 * connect, it led the race again, alone, around the tunnel. A race puts
 * them back behind everything else (`connectedMirrorsLast`).
 *
 * A module of its own, rather than an export of api-endpoints.ts, because
 * two dozen test files stand in for that module whole: an export added
 * there has to be added to every stand-in, and one missed would fail
 * every request in that file. */

let current: ReadonlySet<string> = new Set();

/** Replaces the set: what `apiEndpoints` put last on its latest call, or
 * nothing once no server is reached around the tunnel. */
export function setConnectedMirrors(mirrors: Iterable<string>): void {
  current = new Set(mirrors);
}

/** Whether the service says the tunnel now up confines this PC's IPv4 to
 * it (`ipv4Confined: true`, `engines::confinement` in the service).
 *
 * Then the connected server's address is refused on this PC for everything
 * but the engine: a request to one of its mirrors fails at once with 10013
 * -- refused here, which says nothing about the network and must not be
 * recorded against it, as a block or as a demotion on this network. So
 * while it is so, those mirrors are not asked at all (`apiEndpoints`,
 * `connectedMirrorsLast`), unless they are all there is. Set from the
 * service's own status by the screen; false whenever it says anything
 * else, which puts them back last -- reachable around the tunnel again. */
let confined = false;

/** Tells the order whether the session is confined. See `confined`. */
export function setConfinedAround(value: boolean): void {
  confined = value;
}

/** Whether the session is confined, as last told. */
export function confinedAround(): boolean {
  return confined;
}

/** Whether `base` is one of the connected server's own mirrors, which
 * nothing sends to ahead of its turn: not a write's first stop for having
 * answered last (`recentWinner` in api.ts), and not a walk's next stop for
 * being remembered (`followRemembered`). */
export function isConnectedMirror(base: string): boolean {
  return current.has(base);
}

/** `ordered`, as `demotedLast` returns it with its first `healthy` not
 * demoted, with the connected server's mirrors moved behind everything
 * else, demoted addresses included; how many of the rest lead undemoted;
 * and where the mirrors begin, so a race can give them a stage of their
 * own (`stagesOf` in api.ts).
 *
 * When every other address is demoted, none of them is singled out --
 * `demotedLast`'s own rule for a list with nothing undemoted -- and they
 * are all asked before the mirrors. When the list is nothing but those
 * mirrors, it is left as it is: there is nothing else to ask first. */
export function connectedMirrorsLast(
  ordered: readonly string[],
  healthy: number,
): { ordered: string[]; healthy: number; aroundFrom: number } {
  const rest = ordered.filter((base) => !current.has(base));
  if (rest.length === 0 || rest.length === ordered.length) {
    return { ordered: [...ordered], healthy, aroundFrom: ordered.length };
  }
  const undemoted = ordered.slice(0, healthy).filter((base) => !current.has(base)).length;
  // Confined: not asked at all while anything else is left (`confined`).
  const mirrors = confined ? [] : ordered.filter((base) => current.has(base));
  return {
    ordered: [...rest, ...mirrors],
    healthy: undemoted === 0 ? rest.length : undemoted,
    aroundFrom: rest.length,
  };
}
