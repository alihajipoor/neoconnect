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
import { Note } from "./ui";
import { Hint, StateLine, StatusChip } from "./main/Hero";
import type { ChipGlyph, ShownTone } from "../lib/hero-model";
import { CAUTION_AFTER_MS } from "../lib/orb-caution";

/** The Dashboard's hero while the app is in gaming mode: its chip, line,
 * sentence, button and notes, drawn into the main page's hero column.
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

/** The status chip's word and glyph for each phase. Never "Connected":
 * gaming mode brings up no tunnel for the word to describe. */
const CHIP: Record<GamingPhase, { key: TranslationKey; glyph: ChipGlyph }> = {
  off: { key: "chip.gamingOff", glyph: "idle" },
  arming: { key: "chip.gamingArming", glyph: "spin" },
  active: { key: "chip.gamingOn", glyph: "dot" },
  partial: { key: "chip.gamingPartial", glyph: "ring" },
  unknown: { key: "chip.gamingUnknown", glyph: "dash" },
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

export function GamingStatusPanel({
  onOpenSettings,
  onTone,
  onSummary,
}: {
  onOpenSettings: () => void;
  /** The calm tone the main page wears while gaming mode shows. */
  onTone?: (tone: ShownTone) => void;
  /** What the tray says about this mode: how many games are chosen. */
  onSummary?: (summary: { picked: number; resolver: string | null }) => void;
}) {
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

  // The calm rule here too: a "partial" reading after "active" keeps the
  // active look for CAUTION_AFTER_MS before the warning colour shows. The
  // words say it at once.
  //
  // Worked out during the render, not in an effect after it: the first
  // "partial" render is the one that must already hold, or it paints the
  // warning colour for a frame -- on the Hint, and through `onTone` on the
  // whole app -- before the effect could take it back. The timer only
  // re-renders once the hold has run out.
  const lastSettledRef = useRef<GamingPhase>("off");
  const partialSinceRef = useRef<number | null>(null);
  if (phase === "partial") {
    if (partialSinceRef.current === null) partialSinceRef.current = Date.now();
  } else {
    partialSinceRef.current = null;
    if (phase !== "arming") lastSettledRef.current = phase;
  }
  const partialHeld =
    phase === "partial" &&
    lastSettledRef.current === "active" &&
    partialSinceRef.current !== null &&
    Date.now() - partialSinceRef.current < CAUTION_AFTER_MS;
  const [, setHoldExpired] = useState(0);
  useEffect(() => {
    if (!partialHeld || partialSinceRef.current === null) return;
    const left = CAUTION_AFTER_MS - (Date.now() - partialSinceRef.current);
    const timer = setTimeout(() => setHoldExpired((n) => n + 1), Math.max(0, left) + 20);
    return () => clearTimeout(timer);
  }, [partialHeld, phase]);

  const tone: ShownTone =
    phase === "active" || (phase === "partial" && partialHeld)
      ? "ok"
      : phase === "partial"
        ? "warn"
        : phase === "unknown"
          ? "muted"
          : "idle";
  useEffect(() => onTone?.(tone), [tone, onTone]);
  useEffect(
    () => onSummary?.({ picked: picked.length, resolver: profile?.resolver?.nodeRegion ?? null }),
    [picked.length, profile, onSummary],
  );

  return (
    <>
      <div className="nx-chiprow">
        <StatusChip glyph={CHIP[phase].glyph} label={t(CHIP[phase].key)} />
      </div>
      <StateLine line={{ kind: "words", key: HEADLINE[phase] }} words={t(HEADLINE[phase])} />
      <Hint tone={tone === "warn" ? "warn" : null}>{t(HINT[phase])}</Hint>

      <div className="nx-actions">
        <ConnectOrb
          state={ORB_FACE[phase]}
          disabled={busy || (!rulesUp && phase !== "unknown" && !config)}
          onToggle={() => void toggle()}
          label={orbLabel}
          look="pill"
          pill={{ variant: busy ? "busy" : "primary", arrow: !busy && !rulesUp && phase !== "unknown", progress: busy }}
        />
      </div>

      <div className="nx-notes">
        {/* Where the exit IP sits in VPN mode -- neutral, never the success
            colour. There is no single exit address in this mode: the
            redirected services are reached from the node and everything
            else is not. */}
        <span className="nx-bchip">
          <Route aria-hidden />
          {t("gaming.pathDirect")}
        </span>

        {/* The whole anti-lie, always present: what changes address, and
            the fact that none of this is a speed claim. */}
        <Note tone="info">{t("gaming.ipUnchanged")}</Note>
        <Note>{t("gaming.noSpeedClaim")}</Note>

        {/* On with nothing chosen does nothing at all, and is said rather
            than left looking enabled. */}
        {!unavailable && !profileFailed && picked.length === 0 ? <Note tone="caution">{t("gaming.noGamesDash")}</Note> : null}

        {/* The server's own reason, never one of ours. */}
        {unavailable ? <Note tone="caution">{t(unavailable)}</Note> : null}

        {profileFailed ? <Note tone="caution">{t("gaming.profileFailed")}</Note> : null}

        {/* The service's own words about why it could not confirm, under
            the sentence that already refuses to claim it did. */}
        {status?.detail && (phase === "partial" || phase === "unknown") ? (
          <details className="nx-errdetail">
            <summary>{t("err.showDetail")}</summary>
            <p data-ltr>{status.detail}</p>
          </details>
        ) : null}

        {armError ? <Note tone="danger">{armError}</Note> : null}

        <button type="button" className="nx-lnk text-[13px]" onClick={onOpenSettings}>
          <Gamepad2 className="size-4" aria-hidden />
          {t("gaming.games")} · {picked.length}
        </button>
      </div>
    </>
  );
}
