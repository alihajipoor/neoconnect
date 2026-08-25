import { useCallback, useEffect, useRef, useState } from "react";
import { Gamepad2, Route } from "lucide-react";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { getGamingProfile, type GamingProfileResponse } from "../lib/customer";
import {
  buildGamingConfig,
  chosenGames,
  gamingArm,
  gamingDisarm,
  gamingStatus,
  loadGaming,
  unavailableKey,
  UNKNOWN_STATUS,
  type GamingPhase,
  type GamingStatus,
} from "../lib/gaming";
import { ConnectOrb, type ConnectionState } from "./ConnectOrb";
import { Stat } from "./ui";

/** The Dashboard's hero while the app is in gaming mode.
 *
 * The single fact that shapes every line of this file: **gaming mode
 * brings up no tunnel and no adapter.** It installs namespace-scoped DNS
 * rules and nothing else. So:
 *
 * * The word "Connected" does not appear, in either language. There is
 *   nothing it could truthfully mean.
 * * The exit-IP pill is not rendered. There is no single exit address
 *   in this mode -- the redirected services are reached from the node
 *   and nothing else is -- so any one address in that pill would be a
 *   plain lie about half the traffic. Its place is taken by a neutral
 *   path chip, not the success green, which from across a room *is* the
 *   claim.
 * * `gaming.ipUnchanged` is on screen the whole time the mode is
 *   selected, whatever the state. It is the anti-lie the feature hangs
 *   on and it is not conditional on anything.
 * * Nothing claims a lower ping or names a millisecond figure. Measured
 *   from Tehran: our best node reaches Blizzard EU in 72.8ms against
 *   72.0ms direct. The honest value of this mode is that it stops
 *   carrying what should not be carried -- not that it is faster.
 *
 * And the phase shown is the one the *service* reports, never the one
 * the switch implies. Rules can be present from a session that crashed,
 * and they can be absent under a switch that says "on"; the Dashboard
 * already works this way for `splitTunnelActive` and for the same
 * reason.
 */

/** How often the service is asked what it actually has installed. */
const STATUS_POLL_MS = 5_000;

/** Consecutive unanswered status calls before the screen stops standing
 * on the last one. Matched to the Dashboard's own threshold: the last
 * answer was an observation when it arrived, and half a minute later it
 * is only a memory. */
const STATUS_MISSES_BEFORE_UNKNOWN = 4;

const HEADLINE: Record<GamingPhase, TranslationKey> = {
  off: "gaming.off",
  arming: "gaming.arming",
  active: "gaming.active",
  partial: "gaming.partial",
  unknown: "gaming.unknown",
};

const HINT: Record<GamingPhase, TranslationKey> = {
  off: "gaming.offHint",
  arming: "gaming.armingHint",
  active: "gaming.activeHint",
  // Never softened. Rules present with a failed canary means the
  // redirection may not be reaching us at all.
  partial: "gaming.partialHint",
  unknown: "gaming.unknownHint",
};

/** Which face the one hero control wears.
 *
 * A translation, not a widening: `ConnectOrb` speaks `ConnectionState`
 * and its signature is shared with the mobile app, so gaming's own phase
 * is mapped here rather than pushed into it. `partial` takes the warning
 * face and `unknown` the grey one, which is what each of them means.
 */
const ORB_FACE: Record<GamingPhase, ConnectionState> = {
  off: "disconnected",
  arming: "connecting",
  active: "connected",
  partial: "degraded",
  unknown: "unknown",
};

export function GamingStatusPanel({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<GamingProfileResponse | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [games, setGames] = useState<string[]>([]);
  const [status, setStatus] = useState<GamingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);
  const missesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void loadGaming().then((loaded) => {
      if (!cancelled) setGames(loaded.games);
    });
    void getGamingProfile().then((result) => {
      if (cancelled) return;
      if (result.ok) setProfile(result.data);
      // Says the list could not be loaded and stops there. Whether any
      // server was dialled is not something this branch knows, so it
      // does not say one could not be reached.
      else setProfileFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const read = useCallback(async () => {
    try {
      const live = await gamingStatus();
      missesRef.current = 0;
      setStatus(live);
    } catch {
      // Failing to ask is not an answer. The last one stands for a few
      // rounds and then becomes "we don't know" -- which is its own
      // state and is never folded into "off".
      missesRef.current += 1;
      if (missesRef.current >= STATUS_MISSES_BEFORE_UNKNOWN) setStatus(UNKNOWN_STATUS);
    }
  }, []);

  // Polled whether or not this app believes it armed anything. Rules
  // outlive the process that installed them, so a session that crashed
  // leaves them in place -- and reporting "off" over live rules is the
  // same class of wrongness as reporting "on" over none.
  useEffect(() => {
    void read();
    const id = setInterval(() => void read(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [read]);

  const unavailable = unavailableKey(profile);
  const config = buildGamingConfig(profile, games);
  const picked = chosenGames(profile, games);

  // What the service says, with one exception: while an arm or disarm is
  // in flight, the screen names the operation. That is a statement about
  // what the app is doing, not about what is installed -- the same
  // distinction "Connecting..." already carries.
  const phase: GamingPhase = busy ? "arming" : (status?.state ?? "unknown");
  const rulesUp = phase === "active" || phase === "partial";

  async function toggle() {
    setArmError(null);
    setBusy(true);
    try {
      if (rulesUp || phase === "unknown") {
        // Disarm is the safe half of an unknown state: it removes rules
        // rather than asserting anything about them.
        await gamingDisarm();
      } else if (config) {
        // Re-pushed in full on every arm rather than trusted to have
        // survived -- the helper service is a Windows service with its
        // own lifetime and can restart underneath a running app knowing
        // nothing. Same reasoning as re-sending the split-tunnel
        // selection on every connect.
        setStatus(await gamingArm(config));
        return;
      }
    } catch {
      setArmError(t("gaming.armFailed"));
    } finally {
      setBusy(false);
    }
    await read();
  }

  const orbLabel = busy
    ? t("gaming.arming")
    : rulesUp || phase === "unknown"
      ? t("gaming.turnOff")
      : t("gaming.turnOn");

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4">
      <ConnectOrb
        state={ORB_FACE[phase]}
        disabled={busy || (!rulesUp && phase !== "unknown" && !config)}
        onToggle={() => void toggle()}
        label={orbLabel}
      />

      <div className="px-4 text-center">
        <p
          className={
            phase === "active"
              ? "text-base font-semibold tracking-tight text-success"
              : phase === "partial"
                ? "text-base font-semibold tracking-tight text-warning"
                : phase === "unknown"
                  ? "text-base font-semibold tracking-tight text-muted-foreground"
                  : "text-base font-semibold tracking-tight text-foreground"
          }
        >
          {t(HEADLINE[phase])}
        </p>
        <p className="mt-1 text-xs text-pretty text-muted-foreground">{t(HINT[phase])}</p>

        {/* Where the exit-IP pill sits in VPN mode -- same chrome, and
            deliberately neutral rather than success-green. There is no
            single exit address in this mode to put in a pill: the
            redirected services are reached from the node and everything
            else is not. So it states the one fact a pill can carry
            here, and nothing reads as a win. */}
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-2.5 py-1 text-[11px] text-muted-foreground">
          <Route className="size-3" />
          {t("gaming.pathDirect")}
        </p>

        {/* The whole anti-lie, always present: what changes address,
            and the fact that none of this is a speed claim. */}
        <p className="mt-1 text-xs text-highlight">{t("gaming.ipUnchanged")}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{t("gaming.noSpeedClaim")}</p>

        {/* On with nothing chosen does nothing at all, and the warning
            chrome is how that gets said instead of the screen sitting
            there looking enabled. */}
        {!unavailable && !profileFailed && picked.length === 0 ? (
          <p className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t("gaming.noGamesDash")}
          </p>
        ) : null}

        {/* The server's own reason, never one of ours. */}
        {unavailable ? (
          <p className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t(unavailable)}
          </p>
        ) : null}

        {profileFailed ? (
          <p className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t("gaming.profileFailed")}
          </p>
        ) : null}

        {/* The service's own words about why it could not confirm, under
            the sentence that already refuses to claim it did. */}
        {status?.detail && (phase === "partial" || phase === "unknown") ? (
          <p className="mt-1 font-mono text-[10px] break-words text-muted-foreground" data-ltr>
            {status.detail}
          </p>
        ) : null}

        {armError ? <p className="mt-1 text-xs text-destructive">{armError}</p> : null}
      </div>

      {/* The two facts worth glancing at in this mode, in the same tiles
          the VPN row uses -- so switching modes rearranges the meaning
          without rearranging the furniture. Neither is a claim about
          traffic: one is a count of what was chosen, the other names the
          server whose resolver the rules point at. */}
      <div className="grid w-full grid-cols-2 gap-2">
        <Stat
          icon={<Gamepad2 className="size-3" />}
          label={t("gaming.games")}
          value={<span className="tabular-nums">{picked.length}</span>}
          onClick={onOpenSettings}
          actionLabel={t("dash.change")}
        />
        <Stat
          icon={<Route className="size-3" />}
          label={t("gaming.resolver")}
          value={
            profile?.resolver ? (
              <span dir="ltr">{profile.resolver.nodeRegion}</span>
            ) : (
              "—"
            )
          }
        />
      </div>
    </div>
  );
}
