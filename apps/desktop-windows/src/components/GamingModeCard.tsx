import { useEffect, useState } from "react";
import { Gamepad2, Loader2, Plus, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { getGamingProfile, type GamingProfileResponse } from "../lib/customer";
import {
  buildGamingConfig,
  chosenGames,
  gamingArm,
  gamingStatus,
  loadGaming,
  MAX_GAMES,
  saveGaming,
  unavailableKey,
  type GamingSettings,
} from "../lib/gaming";
import { GamePicker, GameTile } from "./GamePicker";
import { Button, Card } from "./ui";

/** Gaming mode's settings pane: which games it covers.
 *
 * What this mode is, stated once so nothing below has to be read
 * charitably: it installs namespace-scoped DNS rules for the game
 * services named here. **No tunnel is brought up and no adapter is
 * created.** The machine's exit address does not change, which is why
 * that sentence is on this card in the accent colour rather than tucked
 * into a tooltip.
 *
 * Two states this card refuses to render quietly, both borrowed from the
 * Custom-mode card because both were learned the same way:
 *
 * * **On with nothing chosen does nothing.** It is a reachable state and
 *   it is not obvious from looking at it, so it says so in the warning
 *   chrome instead of sitting there looking enabled.
 * * **The reason it is unavailable is the server's reason, verbatim.**
 *   "Not available on your server yet" and "your plan does not include
 *   it" are different facts, and choosing between them ourselves would
 *   be inventing one.
 */
export function GamingModeCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<GamingSettings | null>(null);
  const [profile, setProfile] = useState<GamingProfileResponse | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);

  async function loadProfile() {
    setLoading(true);
    setProfileFailed(false);
    const result = await getGamingProfile();
    if (result.ok) {
      setProfile(result.data);
    } else {
      // Says the list could not be loaded, and nothing more. It does not
      // say a server was unreachable: whether anything was dialled is
      // not something this branch knows.
      setProfileFailed(true);
    }
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    void loadGaming().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });
    void loadProfile();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Saves the new selection and, if the service already has rules
   * installed, re-installs them from it.
   *
   * The second half is the same reasoning as `pushSplitTunnel` being
   * re-sent rather than sent once: somebody who removes a game while the
   * mode is on should stop having it redirected now, not discover after
   * a restart whether it worked. */
  async function apply(next: GamingSettings) {
    setSettings(next);
    await saveGaming(next);
    try {
      const live = await gamingStatus();
      if (!live.rulesPresent) return;
      const config = buildGamingConfig(profile, next.games);
      // Nothing left to install is not the same as nothing to do: the
      // rules that are up are now covering games the customer removed.
      // The card cannot tear them down on its own without claiming the
      // mode is off, so it re-arms with whatever is left and lets the
      // Dashboard report the result.
      if (config) await gamingArm(config);
    } catch {
      // The service may be stopped or restarting. The Dashboard polls it
      // and will report what is actually installed either way, which is
      // the only place that claim is allowed to come from.
    }
  }

  if (loading || !settings) {
    return (
      <Card className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </Card>
    );
  }

  const unavailable = unavailableKey(profile);
  const picked = chosenGames(profile, settings.games);
  const canAdd = !unavailable && !profileFailed && (profile?.games.length ?? 0) > 0;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
          <Gamepad2 className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{t("gaming.title")}</p>
          <p className="text-xs text-muted-foreground">{t("gaming.hint")}</p>
        </div>
      </div>

      {/* The anti-lie, and it is not conditional on the mode being on.
          Somebody reading this card is deciding whether to buy the idea,
          and the single most likely wrong belief they can leave with is
          that this changes where they appear to be. */}
      <p className="mt-1 text-xs text-highlight">{t("gaming.ipUnchanged")}</p>

      {profileFailed ? (
        <div className="flex flex-col gap-2">
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {t("gaming.profileFailed")}
          </p>
          <Button variant="outline" onClick={() => void loadProfile()} className="justify-center">
            {t("gaming.retry")}
          </Button>
        </div>
      ) : unavailable ? (
        <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          {t(unavailable)}
        </p>
      ) : null}

      {canAdd || picked.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {t("gaming.chosen")}
          </p>

          {picked.length === 0 ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t("gaming.noGames")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {picked.map((game) => (
                <li
                  key={game.slug}
                  className="group flex items-center gap-2.5 rounded-lg border border-white/8 bg-white/[0.04] px-2.5 py-2 transition-colors hover:border-white/14 hover:bg-white/[0.07]"
                >
                  <GameTile game={game} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">{game.displayName}</p>
                    {/* Exactly what is redirected for this row. The
                        game's own connection is not, and a row that let
                        that be assumed would be selling the thing we
                        measured ourselves unable to do. */}
                    <p className="truncate text-[10px] text-muted-foreground">
                      {t("gaming.redirects")}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`${t("gaming.remove")} ${game.displayName}`}
                    onClick={() =>
                      void apply({
                        ...settings,
                        games: settings.games.filter((s) => s !== game.slug),
                      })
                    }
                    className="press flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {notice ? <p className="text-xs text-destructive">{notice}</p> : null}

          {canAdd ? (
            <Button
              variant="outline"
              onClick={() => {
                setNotice(null);
                setPicking(true);
              }}
              className="justify-center gap-2"
            >
              <Plus className="size-4" />
              {t("gaming.addGame")}
            </Button>
          ) : null}

          {picked.length > 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("gaming.applies")}</p>
          ) : null}
        </div>
      ) : null}

      {picking && profile ? (
        <GamePicker
          games={profile.games}
          chosen={settings.games}
          onClose={() => setPicking(false)}
          onPick={(slug) => {
            setPicking(false);
            if (settings.games.includes(slug)) return;
            if (settings.games.length >= MAX_GAMES) {
              setNotice(t("gaming.tooMany", { max: MAX_GAMES }));
              return;
            }
            void apply({ ...settings, games: [...settings.games, slug] });
          }}
        />
      ) : null}
    </Card>
  );
}
