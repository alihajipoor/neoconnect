import { useEffect, useRef, useState } from "react";
import type { ConnectionState } from "@shared/components/ConnectOrb";
import { isTunnelUp } from "@shared/lib/connection-evidence";
import { appPrefs } from "@shared/lib/app-prefs";
import { autoConnectDecision, autoConnectLatch, type AutoConnectSkip } from "@shared/lib/auto-connect";
import { adoptedSince } from "@shared/lib/session-clock";
import { createRecordBytes, loggedCredential, movedRoute, sessionLog } from "@shared/lib/session-log";
import { trafficMeter, type TrafficView } from "@shared/lib/traffic-meter";
import type { VpnAccess, VpnStatus } from "./vpn";

/** What the phone's main page does for the device settings, in one place
 * the page calls (`usePhoneMainExtras`): "Connect when Neoxify starts",
 * the session log, the speeds, and the timer for a tunnel found up.
 *
 * Built ahead of the page. The phone's main page (screens/Dashboard.tsx) is
 * being redesigned on another branch and this one does not touch it; the
 * merge adds the one call and sets `PHONE_MAIN_PAGE_EXTRAS` -- and until
 * both, Settings shows no "Connect when Neoxify starts" on a phone and
 * Activity no session log (phone-notices.ts, App.tsx): a switch nothing
 * honours is not drawn. A test holds the flag to the call.
 *
 * The same decisions as the Windows main page's, read from the same shared
 * modules (lib/auto-connect.ts, lib/session-log.ts, lib/traffic-meter.ts,
 * lib/session-clock.ts). What a phone adds:
 *  - auto-connect raises nothing: no VPN consent dialog, no "Add VPN
 *    Configurations", never over another VPN -- the same questions an
 *    automatic reconnect asks first (lib/reconnect-steps.ts), and the page
 *    dials as it does for one, passing over any rung that would prompt;
 *  - speeds are rates the app works out from the engines' running totals
 *    (vpn.ts, `rxBytes`): none at all where they are not counted --
 *    IKEv2, on either phone -- never a zero;
 *  - a tunnel lost while the app was in the background is recorded as
 *    ending when the app was last seen with it up, not when it was found
 *    gone: the later time would claim minutes nobody saw. */

/** Set by the merge that calls `usePhoneMainExtras` from the phone's main
 * page; it turns on the rows that page then honours. */
export const PHONE_MAIN_PAGE_EXTRAS = false;

/** The phone's own questions before an automatic connect, none of which
 * may raise anything. */
export interface PhoneAutoConnectDeps {
  /** Whether the device is out of every VPN (`tunnelGone`). */
  vpnGone: () => Promise<boolean>;
  /** What the app may start without asking (`vpnAccess`). */
  access: () => Promise<VpnAccess>;
}

export type PhoneAutoConnectSkip = AutoConnectSkip | "permission" | "otherVpn" | "unreadable";

export type PhoneAutoConnect =
  | { go: true; /** Whether IKEv2's rungs may be dialled (iOS). */ ikev2: boolean }
  | { go: false; why: PhoneAutoConnectSkip };

/** The screen's decision (`autoConnectDecision`), then the phone's: another
 * VPN up, or a dial that would need the customer's consent, and nothing is
 * dialled. A question that cannot be answered is a no. */
export async function phoneAutoConnect(
  screen: Parameters<typeof autoConnectDecision>[0],
  deps: PhoneAutoConnectDeps,
): Promise<PhoneAutoConnect> {
  const decision = autoConnectDecision(screen);
  if (!decision.go) return decision;
  let gone: boolean;
  let access: VpnAccess;
  try {
    gone = await deps.vpnGone();
    if (!gone) return { go: false, why: "otherVpn" };
    access = await deps.access();
  } catch {
    return { go: false, why: "unreadable" };
  }
  if (!access.granted) return { go: false, why: "permission" };
  if (access.chosenElsewhere === true) return { go: false, why: "otherVpn" };
  return { go: true, ikev2: access.ikev2 !== false };
}

/** A running total as the platform reported it. */
export interface TotalsReading {
  rx: number;
  tx: number;
  at: number;
}

/** Rates from two running totals, in the shape the speed meter reads
 * (`readTraffic`). Null when there is nothing to work from: no totals, a
 * first reading (no rate yet -- the totals stand, the rate is unknown), a
 * total that went backwards (a new tunnel), or readings too far apart or
 * too close to make a per-second rate of. */
export function trafficFromTotals(
  previous: TotalsReading | null,
  status: Pick<VpnStatus, "rxBytes" | "txBytes"> | null,
  at: number,
): { reading: TotalsReading | null; raw: Record<string, number | null> | null } {
  const rx = status?.rxBytes;
  const tx = status?.txBytes;
  if (typeof rx !== "number" || typeof tx !== "number" || !Number.isFinite(rx) || !Number.isFinite(tx) || rx < 0 || tx < 0) {
    return { reading: null, raw: null };
  }
  const reading = { rx, tx, at };
  const span = previous ? at - previous.at : 0;
  const usable = previous !== null && rx >= previous.rx && tx >= previous.tx && span >= 500 && span <= 5_000;
  return {
    reading,
    raw: {
      rx_bytes: rx,
      tx_bytes: tx,
      rx_per_sec: usable ? ((rx - previous!.rx) * 1000) / span : null,
      tx_per_sec: usable ? ((tx - previous!.tx) * 1000) / span : null,
    },
  };
}

/** How soon after the app comes back to the front a loss it then shows
 * counts as found on return, rather than seen happening. */
export const FOUND_ON_RETURN_MS = 15_000;

/** When a lost session is recorded as ending. Found gone on coming back to
 * the front -- shown lost within `FOUND_ON_RETURN_MS` of returning, having
 * gone to the background with it up -- it ended at some moment nobody saw,
 * and the record says when it was last seen up: the moment the app went to
 * the background. Seen going, it is now. */
export function lostSessionEnd(now: number, hiddenWhileUpAt: number | null, visibleAgainAt: number | null): number {
  if (hiddenWhileUpAt === null || visibleAgainAt === null) return now;
  if (visibleAgainAt < hiddenWhileUpAt || now - visibleAgainAt > FOUND_ON_RETURN_MS) return now;
  return Math.min(now, hiddenWhileUpAt);
}

export interface PhoneMainExtrasInput {
  /** The page has what a pass reads: its first load, the route memory and
   * the list. Nothing is decided before. */
  ready: boolean;
  connectionState: ConnectionState;
  /** When the screen's own connect saw the tunnel come up, or null. */
  connectedAt: number | null;
  /** The screen says the tunnel was lost (not disconnected by the customer). */
  tunnelDropped: boolean;
  /** The credential the page holds, read when it is needed. Not yet the
   * tunnel's: over a tunnel the page cannot name it is the pin its load
   * holds, which may be another country. */
  held: () => { routeId: string | null; protocol: string | null; transport?: string } | null;
  /** Whether the page can name the tunnel up (`tunnelNamed`). The hook puts
   * `held` through `loggedCredential` with it, so the call site cannot
   * skip the guard: a tunnel nobody can name is logged as no route, never
   * as the pin -- the 0.2.29 misnaming, in a log the customer keeps. */
  named: () => boolean;
  /** The rest of `autoConnectDecision`'s input, as the page knows it. */
  screen: () => {
    passRunning: boolean;
    reconnecting: boolean;
    hasCredential: boolean;
    subscriptionStatus: string | undefined;
    deviceLimitNotice: boolean;
  };
  /** Connects as an automatic pass does: no prompts, and IKEv2's rungs only
   * when `ikev2` is true. */
  connectQuietly: (ikev2: boolean) => Promise<void>;
  /** The page's adoption of a tunnel found up: the start time to show. */
  adopt: (since: number) => void;
  deps: PhoneAutoConnectDeps & {
    status: () => Promise<VpnStatus>;
    /** The status with the byte totals (`vpnStatusWithTotals`), which only
     * the speeds ask for: on iOS each is a round trip to the extension. */
    statusWithTotals: () => Promise<VpnStatus>;
    /** Whether to read the totals at all: both phones report them for
     * Xray and WireGuard; a status without them is no speed regardless. */
    counts: boolean;
  };
  now?: () => number;
}

/** How often the totals are read while the page shows a tunnel up and is
 * in front: the speeds are per second. */
export const SAMPLE_MS = 1_000;

/** The page's call. Returns whether an automatic connect is under way (for
 * the line that says so) and the speeds to show, or null for none. */
export function usePhoneMainExtras(input: PhoneMainExtrasInput): { autoConnecting: boolean; traffic: TrafficView | null } {
  const now = input.now ?? Date.now;
  const inputRef = useRef(input);
  inputRef.current = input;
  const [autoConnecting, setAutoConnecting] = useState(false);
  const up = isTunnelUp(input.connectionState);

  // "Connect when Neoxify starts": once per run, at the first main page of
  // a run that opened signed in (App.tsx disarms it otherwise), over
  // nothing, raising nothing.
  useEffect(() => {
    if (!input.ready || !autoConnectLatch.armed()) return;
    let alive = true;
    void appPrefs.load().then(async (prefs) => {
      if (!alive || !autoConnectLatch.take()) return;
      const current = inputRef.current;
      const decision = await phoneAutoConnect(
        { enabled: prefs.autoConnect, mode: "vpn", state: current.connectionState, disclosureAccepted: true, ...current.screen() },
        current.deps,
      );
      if (!decision.go || !alive) return;
      setAutoConnecting(true);
      void inputRef.current.connectQuietly(decision.ikev2).finally(() => setAutoConnecting(false));
    });
    return () => {
      alive = false;
    };
  }, [input.ready]);

  // The timer for a tunnel found up: the platform's own record of when it
  // came up, where it has one; otherwise the page shows it without a clock.
  useEffect(() => {
    if (!input.ready || !up || input.connectedAt !== null) return;
    let alive = true;
    void input.deps.status().then(
      (status) => {
        if (!alive || !status.connected) return;
        const since = adoptedSince(status, now());
        if (since !== null) inputRef.current.adopt(since);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.ready, up, input.connectedAt]);

  // Speeds: the platform's totals once a second while a tunnel is shown up
  // and the page is in front. None while no tunnel is up. The view is read
  // when the meter says it changed (a reading, or one going stale), and the
  // totals kept for the session log.
  const [traffic, setTraffic] = useState<TrafficView | null>(null);
  const lastBytes = useRef(createRecordBytes());
  useEffect(
    () =>
      trafficMeter.subscribe(() => {
        const view = trafficMeter.view(now());
        setTraffic(view);
        lastBytes.current.see(trafficMeter.generation(), view ? { rx: view.rxBytes, tx: view.txBytes } : null);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => {
    if (!up) {
      trafficMeter.reset();
      return;
    }
    if (!input.deps.counts) return;
    let previous: TotalsReading | null = null;
    let asking = false;
    const look = () => {
      if (asking || (typeof document !== "undefined" && document.visibilityState !== "visible")) return;
      asking = true;
      void inputRef.current.deps
        .statusWithTotals()
        .then(
          (status) => {
            const step = trafficFromTotals(previous, status.connected ? status : null, now());
            previous = step.reading;
            if (step.raw) trafficMeter.observe(step.raw, now());
          },
          () => undefined,
        )
        .finally(() => {
          asking = false;
        });
    };
    look();
    const id = setInterval(look, SAMPLE_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [up, input.deps.counts]);

  // The session log, only when the customer has turned it on: a record
  // opens when the page first shows a tunnel up and closes when it shows
  // it gone, with the totals last read. A tunnel moved to another route is
  // a new record.
  const hiddenWhileUpAt = useRef<number | null>(null);
  const visibleAgainAt = useRef<number | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenWhileUpAt.current = isTunnelUp(inputRef.current.connectionState) ? now() : null;
      } else {
        visibleAgainAt.current = now();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!input.ready) return;
    const user = loggedCredential(input.held(), input.named());
    const open = sessionLog.openRecord();
    const close = (ended: "disconnected" | "lost", bytes: { rx: number; tx: number } | null) => {
      const end = ended === "lost" ? lostSessionEnd(now(), hiddenWhileUpAt.current, visibleAgainAt.current) : now();
      hiddenWhileUpAt.current = null;
      void sessionLog.finish({ end, rxBytes: bytes?.rx ?? null, txBytes: bytes?.tx ?? null, ended });
    };
    if (up) {
      const moved = movedRoute(open, user);
      if (moved) close("lost", lastBytes.current.split());
      else if (open === null) lastBytes.current.restart();
      if (open === null || moved) {
        void sessionLog.begin({
          start: input.connectedAt ?? now(),
          routeId: user?.routeId ?? null,
          protocol: user?.protocol ?? null,
          transport: user?.transport,
        });
      }
    } else if (input.connectionState === "disconnected" && open !== null) {
      close(input.tunnelDropped ? "lost" : "disconnected", lastBytes.current.total());
      lastBytes.current.restart();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.ready, input.connectionState, input.tunnelDropped]);

  return { autoConnecting, traffic: up ? traffic : null };
}
