/** Which control-plane addresses one request actually tried, and how
 * each attempt ended -- for the `apiEndpoint` field of an unreachable
 * report.
 *
 * What that field carried before was the list a request *would* try,
 * recomputed after the failure (`attemptedEndpoints`, now gone). That
 * says nothing about what happened: not which addresses were dialled,
 * not whether they hung or were refused, not whether the six-second
 * refresh budget ran out while the first was still pending. And it
 * dropped the port, so mirrors sharing a hostname looked like one.
 *
 * A trace is filled in by `api.ts` as the request runs. The caller makes
 * one, passes it down, and renders it when it has decided the request
 * failed. Nothing in it is secret: an address and an outcome class per
 * attempt. Never a token, a path, a query, a resolved IP, a response
 * body or a raw error string -- the plugin's errors embed the full URL.
 *
 * The rendered form, which is what a person reads in the panel:
 *
 *     req: a.example=h401@820 b.example:2053=cancel@830; refresh: a.example=timeout@8001
 *
 * one `phase:` group per leg of the request, each address as
 * `host[:port]=outcome@milliseconds`, in the order they were started.
 */

/** Which leg of a request an attempt belongs to.
 *
 * An authenticated request is up to three of them: the request itself,
 * the token refresh its 401 triggers, and the retry with the new token.
 * After fifteen minutes idle the access token has expired, so the
 * pre-connect refresh is usually all three -- each a fresh connection --
 * and which leg ran out of time is the thing worth knowing.
 *
 * A sign-in or sign-up has a leg before its request: the race for the
 * proof-of-work challenge, which is also what decides where the request
 * is sent. When nothing answered that race, it is the only leg there is.
 *
 * Any other write may have one too: a race for the health check, run
 * when no race has found an answering address in the last minute, to
 * decide where the write is sent (see `sendWrite` in api.ts). It comes
 * just before the leg it was run for -- `health: ...; refresh: ...` is
 * the token refresh's. A health check after a leg is the other use: a
 * refused token refresh, checked against the one address that refused
 * it before the session is ended (`refusedByBackend` in api.ts). Not
 * called `probe`, which is the socket-level section that may follow the
 * trace (control-plane-probe.ts). */
export type TracePhase = "challenge" | "health" | "req" | "refresh" | "retry";

/** How one address's attempt ended, in the classes this side can tell
 * apart.
 *
 * - `h<status>`: an HTTP answer. The address is reachable and is us.
 * - `timeout`: no answer in the time allowed. Either aborted by us at the
 *   request's own deadline (eight seconds in a walk, twenty in a race),
 *   or given up by the HTTP plugin at the connection deadline it is
 *   passed (`CONNECT_TIMEOUT_MS`, ten seconds), which is what a
 *   blackholed address now usually shows. See `failedAs` in api.ts.
 * - `scope`: refused before leaving the device, because the address is
 *   not in the app's HTTP permission. A build problem, not a network one.
 * - `cancel`: another address answered first, so this one was stopped.
 * - `net`: any other transport failure. DNS, TCP and TLS all land here:
 *   the HTTP plugin reports every one as the same sentence (reqwest's
 *   Display drops the cause), so telling them apart takes the
 *   socket-level probe in control-plane-probe.ts, whose answer follows
 *   the trace as a `probe:` section when it ran.
 * - `blockpage`: the address's name resolves to Iran's DNS block page and
 *   nothing else, so a race stopped the request, or did not send it (see
 *   `resolvesToBlockPage` in endpoint-demotion.ts). Found by a lookup of
 *   its own beside the request's, through the same system resolver.
 * - `pending`: not settled yet. Rendered as `budget` when a caller gives
 *   up waiting -- see `renderTrace`.
 */
export type TraceOutcome = `h${number}` | "timeout" | "scope" | "cancel" | "net" | "blockpage" | "pending";

export interface TraceEntry {
  phase: TracePhase;
  /** The endpoint base as tried, e.g. `https://a.example:2053/api`. */
  base: string;
  startedAt: number;
  outcome: TraceOutcome;
  settledAt?: number;
}

export interface EndpointTrace {
  /** The phase new attempts are recorded under. Moved on by `api.ts`. */
  phase: TracePhase;
  entries: TraceEntry[];
}

export function newTrace(): EndpointTrace {
  return { phase: "req", entries: [] };
}

/** Starts recording one attempt. Undefined when nobody is tracing, so
 * every call site can stay unconditional. */
export function beginAttempt(
  trace: EndpointTrace | undefined,
  base: string,
  now = Date.now(),
): TraceEntry | undefined {
  if (!trace) return undefined;
  const entry: TraceEntry = { phase: trace.phase, base, startedAt: now, outcome: "pending" };
  trace.entries.push(entry);
  return entry;
}

/** Records how an attempt ended. The first settlement wins: a response
 * that arrived before the race was called stays a response, and the
 * abort that follows a timeout does not turn it into something else. */
export function settleAttempt(
  entry: TraceEntry | undefined,
  outcome: Exclude<TraceOutcome, "pending">,
  now = Date.now(),
): void {
  if (!entry || entry.outcome !== "pending") return;
  entry.outcome = outcome;
  entry.settledAt = now;
}

/** The class of a failed fetch, from what the HTTP plugin rejected with.
 *
 * The plugin rejects with its Rust error's Display string. The scope
 * refusal is the one worth separating: it is decided on the device,
 * says nothing about the network, and means the build's permission list
 * is wrong. Everything else is the network's doing and indistinguishable
 * from here. */
export function failureOutcome(err: unknown): "scope" | "net" {
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  return /not allowed on the configured scope/i.test(text) ? "scope" : "net";
}

/** `host` or `host:port` -- the unit that gets blocked. No scheme, no
 * path. The port is kept unless it is the scheme's default, because
 * mirrors share a hostname across ports and one may be blocked while the
 * other is not. */
export function endpointLabel(base: string): string {
  try {
    const url = new URL(base);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return "?";
  }
}

/** The trace as one line, at the moment `now`.
 *
 * Anything still pending is written as `budget`: the caller stopped
 * waiting for it, which is the answer to "why did the refresh fail"
 * that the old field could never give. Its milliseconds are how long it
 * had been running when that happened.
 *
 * Empty string when nothing was tried at all. */
export function renderTrace(trace: EndpointTrace, now = Date.now()): string {
  const groups: { phase: TracePhase; parts: string[] }[] = [];
  for (const entry of trace.entries) {
    let group = groups[groups.length - 1];
    if (!group || group.phase !== entry.phase) {
      group = { phase: entry.phase, parts: [] };
      groups.push(group);
    }
    const outcome = entry.outcome === "pending" ? "budget" : entry.outcome;
    const ms = Math.max(0, Math.round((entry.settledAt ?? now) - entry.startedAt));
    group.parts.push(`${endpointLabel(entry.base)}=${outcome}@${ms}`);
  }
  return groups.map((g) => `${g.phase}: ${g.parts.join(" ")}`).join("; ");
}

/** The longest `apiEndpoint` the current backend accepts. Matches
 * `API_ENDPOINT_MAX_LENGTH` in the backend's report DTO. */
export const API_ENDPOINT_MAX = 2000;

/** The limit every backend before that one enforced. See `send` in
 * attempts.ts for why a client still has to fit inside it. */
export const LEGACY_API_ENDPOINT_MAX = 200;

/** One piece of a rendered field, for cutting: an entry under its leg
 * (`challenge`, `health`, `req`, `refresh`, `retry`, `probe`), or a
 * piece with no leg -- "none dialled", or a cut mark, which carries how
 * many entries it stands for. */
interface Piece {
  leg: string | null;
  text: string;
  cut?: number;
}

const CUT_MARK = /^\[(\d+) cut\]$/;

function cutMark(count: number): Piece {
  return { leg: null, text: `[${count} cut]`, cut: count };
}

function toPieces(text: string): Piece[] {
  const pieces: Piece[] = [];
  for (const section of text.split("; ")) {
    const mark = CUT_MARK.exec(section);
    if (mark) {
      pieces.push(cutMark(Number(mark[1])));
      continue;
    }
    const leg = /^([a-z]+): ([\s\S]*)$/.exec(section);
    if (!leg) {
      if (section !== "") pieces.push({ leg: null, text: section });
      continue;
    }
    for (const part of leg[2].split(" ")) if (part !== "") pieces.push({ leg: leg[1], text: part });
  }
  return pieces;
}

/** Back to one line, in the rendered form: a leg's label before its
 * first entry, and again after anything that interrupts it. Two cut
 * marks that end up side by side become one. */
function fromPieces(pieces: Piece[]): string {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (piece.cut !== undefined && last?.cut !== undefined) merged[merged.length - 1] = cutMark(last.cut + piece.cut);
    else merged.push(piece);
  }
  const sections: string[] = [];
  let leg: string | null = null;
  let parts: string[] = [];
  const close = () => {
    if (leg !== null && parts.length > 0) sections.push(`${leg}: ${parts.join(" ")}`);
    parts = [];
  };
  for (const piece of merged) {
    if (piece.leg === null) {
      close();
      leg = null;
      sections.push(piece.text);
      continue;
    }
    if (piece.leg !== leg) {
      close();
      leg = piece.leg;
    }
    parts.push(piece.text);
  }
  close();
  return sections.join("; ");
}

/** `pieces` with `n` of them taken out of the middle, and a mark saying
 * how many entries went in their place. An earlier mark that falls inside
 * the cut is counted into the new one. */
function cutMiddle(pieces: Piece[], n: number): Piece[] {
  if (n <= 0) return pieces;
  const start = Math.ceil((pieces.length - n) / 2);
  const count = pieces.slice(start, start + n).reduce((sum, p) => sum + (p.cut ?? 1), 0);
  return [...pieces.slice(0, start), cutMark(count), ...pieces.slice(start + n)];
}

/** Shortens a rendered trace to `max` characters, on entry boundaries.
 *
 * Length is the one thing that can make the server refuse the whole
 * report -- a 400, which `send` counts as delivered -- so the field is
 * fitted here rather than trusted to fit.
 *
 * What goes first is the middle of the attempt list. Its first entries
 * say where the walk started and its last say how it ended, which leg
 * ran out; the run of identical timeouts between them is what a long
 * trace is mostly made of. The `probe:` section, when there is one, is
 * kept whole for as long as anything else can give way: it is the one
 * part a trace cannot reconstruct, and it comes last, so cutting from
 * the end -- as this once did -- removed it first. Only when the
 * attempts are down to their first and last entry does the probe lose
 * its own middle; then the remaining attempts go, then the rest.
 *
 * Every cut leaves `[N cut]` where the N entries were. */
export function clipTrace(text: string, max: number): string {
  if (text.length <= max) return text;
  const pieces = toPieces(text);
  const probeAt = pieces.findIndex((p) => p.leg === "probe");
  const tried = probeAt === -1 ? pieces : pieces.slice(0, probeAt);
  const probe = probeAt === -1 ? [] : pieces.slice(probeAt);

  let fromTried = 0;
  let fromProbe = 0;
  const render = () => fromPieces([...cutMiddle(tried, fromTried), ...cutMiddle(probe, fromProbe)]);
  const fits = () => render().length <= max;
  // First and last entry of each part, kept until there is no other way.
  const KEEP = 2;
  while (!fits() && fromTried < tried.length - KEEP) fromTried++;
  while (!fits() && fromProbe < probe.length - KEEP) fromProbe++;
  while (!fits() && fromTried < tried.length) fromTried++;
  while (!fits() && fromProbe < probe.length) fromProbe++;
  // Only a `max` too small for a single mark gets here still too long.
  return render().slice(0, max);
}
