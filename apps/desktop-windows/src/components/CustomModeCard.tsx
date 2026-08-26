import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppWindow, FolderOpen, Gamepad2, ListChecks, X } from "lucide-react";
import { RunningAppPicker } from "./RunningAppPicker";
import { GamePicker } from "./GamePicker";
import { useI18n } from "../lib/i18n";
import {
  appName,
  isEffective,
  listRunningApps,
  loadSplitTunnel,
  MAX_APPS,
  pushSplitTunnel,
  saveSplitTunnel,
  scopeOf,
  scopesFor,
  type AppScope,
  type SplitTunnelMode,
  type SplitTunnelSettings,
} from "../lib/split-tunnel";
import { getGamingProfile, type GameProfileSummary } from "../lib/customer";
import { curatedNames, hasCuratedApps, resolveGameApps, scopesForGame } from "../lib/game-apps";
import { Button, Card } from "../components/ui";

/** Custom mode: pick the apps that go through the VPN, leave the rest
 * on the normal connection.
 *
 * Two things this deliberately says out loud, because both are places a
 * VPN client is tempted to stay quiet and let the customer assume:
 *
 * * **On with nothing chosen does nothing.** It is a reachable state --
 *   flip the toggle, then get distracted -- and a switch that looks
 *   active while routing nothing is the same lie as a false "Connected".
 * * **It applies from the next connection.** Turning it on mid-session
 *   cannot retrofit itself onto a tunnel already carrying everything.
 */
export function CustomModeCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<SplitTunnelSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  /** The server's curated game list, or null until it has been asked
   * for. Games with no executable list are dropped here rather than in
   * the picker: a row that would add nothing must not be offered. */
  const [games, setGames] = useState<GameProfileSummary[] | null>(null);
  const [pickingGame, setPickingGame] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSplitTunnel().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });
    // Failure is silent on purpose and leaves `games` null, which hides
    // the button. The catalogue is an extra way in, not the only one --
    // both existing pickers still work with no network at all, and a
    // customer in Iran whose API call was blocked should not be shown a
    // control that cannot do anything.
    void getGamingProfile().then((result) => {
      if (cancelled || !result.ok) return;
      setGames(result.data.games.filter(hasCuratedApps));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function apply(next: SplitTunnelSettings) {
    setSettings(next);
    await saveSplitTunnel(next);
    // Pushed immediately as well as on connect. A customer who removes
    // an app while connected should stop having it routed, not wait for
    // a reconnect to find out whether it worked.
    try {
      await pushSplitTunnel(next);
    } catch {
      // The service may not be running yet; connect re-sends anyway.
    }
  }

  /** Shared by both pickers, so a program chosen from the running list
   * and the same program found on disk cannot end up on the list twice
   * under different spellings. */
  /** Adds every executable of one product.
   *
   * A product is routinely more than one binary, and adding only the
   * one that happened to be listed routes half of it -- which looks
   * exactly like the feature not working. The file picker passes a
   * single path; the app picker passes the whole group. */
  async function addPaths(picked: string[], gameScopes: AppScope[] = []) {
    if (!settings) return;
    // Compared case-insensitively because Windows paths are, and the
    // picker's casing does not always match what a running process
    // reports -- two entries for one app would look like a bug.
    const have = new Set(settings.apps.map((a) => a.toLowerCase()));
    const fresh = picked.filter((p) => !have.has(p.toLowerCase()));
    if (fresh.length === 0) {
      setNotice(t("settings.customAlready"));
      return false;
    }
    if (settings.apps.length + fresh.length > MAX_APPS) {
      setNotice(t("settings.customTooMany", { max: MAX_APPS }));
      return false;
    }
    const apps = [...settings.apps, ...fresh];
    // A scope is attached to each newly added program, never to one
    // already on the list. Someone who added VALORANT by hand and then
    // adds it again from the catalogue keeps the whole-application
    // routing they already had: narrowing a selection the customer
    // made under different terms, without saying so, is the kind of
    // quiet change this app does not make.
    // Only for programs that were actually added. `scopesForGame`
    // built one per resolved path, and `fresh` is the subset that was
    // not already on the list.
    const chosen = new Set(fresh.map((p) => p.toLowerCase()));
    const scopes = [
      ...settings.scopes,
      ...gameScopes.filter((s) => chosen.has(s.app.toLowerCase())),
    ];
    await apply({ ...settings, apps, scopes: scopesFor(apps, scopes) });
    return true;
  }

  /** Adds every program of one game that is currently running.
   *
   * Running, and only running, because that is the only way this side
   * can learn a real path: the split tunnel matches on the full path,
   * its wire format rejects a bare filename outright, and there is no
   * filesystem access here to go looking for one. Matching on the name
   * alone would be the weaker design anyway -- it is what lets anything
   * renamed to a game executable be routed as that game.
   *
   * What was not found is named rather than counted, so the customer
   * knows which program to start. Adding a fraction silently is how a
   * feature gets reported as broken.
   */
  async function addGame(game: GameProfileSummary) {
    setNotice(null);
    if (!settings) return;
    const wanted = curatedNames(game);
    let running;
    try {
      running = await listRunningApps();
    } catch {
      setNotice(t("settings.customRunningEmpty"));
      return;
    }
    const resolved = resolveGameApps(game, running);
    if (resolved.paths.length === 0) {
      setNotice(t("settings.customGameNone", { game: game.displayName }));
      return;
    }
    // The one gate on destination scoping, and the only place this
    // client decides to narrow anything.
    //
    // `canRouteByDestination` is false unless the server states its
    // prefix list covers the publisher's whole announced space. A
    // partial list would route one of a game's simultaneous
    // connections and not the other -- World of Warcraft holds Home
    // and World open together -- presenting one account from two
    // source addresses at the same instant, which is the
    // account-sharing signature that gets people banned. So a game
    // whose list is incomplete is added exactly as it always was, with
    // every one of its programs carried in full.
    //
    // Note what this means today: no seeded profile is
    // prefix-complete, so this branch does not fire for any game
    // currently in the catalogue. That is deliberate -- the data is
    // the gate, and the code is ready for the day a list is finished.
    const gameScopes = scopesForGame(game, resolved.paths);
    const scoped = gameScopes.length > 0;
    const added = await addPaths(resolved.paths, gameScopes);
    // A refusal above already said why -- the cap, or nothing new. It
    // must not be followed by a sentence claiming a count was added.
    if (!added) return;
    const parts = [
      t("settings.customGameAdded", {
        count: resolved.found.length,
        total: wanted.length,
        game: game.displayName,
      }),
    ];
    if (resolved.missing.length > 0) {
      parts.push(t("settings.customGameMissing", { names: resolved.missing.join(", ") }));
    }
    // Said at the moment it becomes true, not only on the row. Which
    // of a game's traffic is carried is the whole difference this
    // makes, and a customer who is told "added 3 programs" and nothing
    // else has been told the smaller half of what happened.
    parts.push(
      scoped
        ? t("settings.customGameScoped", { game: game.displayName })
        : t("settings.customGameWholeApp"),
    );
    setNotice(parts.join(" "));
  }

  async function browseForApp() {
    setNotice(null);
    if (!settings) return;
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: t("settings.customFileFilter"), extensions: ["exe"] }],
    });
    if (typeof picked !== "string") return;
    await addPaths([picked]);
  }

  if (!settings) return null;
  const effective = isEffective(settings);

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
          <AppWindow className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{t("settings.custom")}</p>
            {/* Labelled beta because it is. It took five releases to
                stop it dropping people onto another protocol, and its
                failure mode is quiet -- selected apps going out
                unprotected -- so somebody turning it on deserves to
                know it is newer than the rest of the app. */}
            <span className="rounded-md border border-highlight/30 bg-highlight/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-highlight uppercase">
              {t("settings.customBeta")}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("settings.customHint")}</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          aria-label={t("settings.custom")}
          onClick={() => void apply({ ...settings, enabled: !settings.enabled })}
          className={[
            "press relative h-6 w-11 shrink-0 rounded-full border transition-colors",
            settings.enabled
              ? "border-transparent bg-[linear-gradient(120deg,var(--primary),var(--highlight))]"
              : "border-white/12 bg-white/8",
          ].join(" ")}
        >
          {/* Positioned from the inline start, not from the left. Under
              Persian the whole card mirrors, and a knob pinned to a
              physical edge slid the wrong way: "on" sat where the eye
              reads "off". */}
          <span
            className={[
              "absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.5)] transition-[inset-inline-start] duration-200",
              settings.enabled ? "start-[1.375rem]" : "start-0.5",
            ].join(" ")}
          />
        </button>
      </div>

      {settings.enabled ? (
        <div className="flex flex-col gap-2">
          {/* Which way the list reads. Two opposite meanings for the
              same list of apps, so both are spelled out as sentences
              underneath rather than left to the labels -- a customer who
              reads this backwards sends the traffic they wanted hidden
              out in the clear. */}
          <div className="flex gap-1 rounded-lg border border-white/8 bg-white/[0.025] p-1">
            {(
              [
                ["onlySelected", t("settings.customModeOnly")],
                ["allExcept", t("settings.customModeExcept")],
              ] as [SplitTunnelMode, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={settings.mode === value}
                onClick={() => void apply({ ...settings, mode: value })}
                className={[
                  "press flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                  // The chosen half sits on top of the groove rather
                  // than flush in it: which way the list reads is the
                  // one thing on this card that must never be misread,
                  // and a lifted pill says "this one" at a glance.
                  settings.mode === value
                    ? "bg-[linear-gradient(120deg,var(--primary),var(--highlight))] text-white shadow-[0_2px_10px_-4px_var(--primary)]"
                    : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {settings.mode === "allExcept"
              ? t("settings.customModeExceptHint")
              : t("settings.customModeOnlyHint")}
          </p>

          {settings.apps.length === 0 ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {/* Says what is actually happening, which is opposite in
                  the two directions: nothing routed, or everything. */}
              {settings.mode === "allExcept"
                ? t("settings.customNoAppsExcept")
                : t("settings.customNoApps")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {settings.apps.map((path) => (
                <li
                  key={path}
                  // Lifted off the card and lit on hover. At white/2.5
                  // the rows were all but invisible against the surface
                  // they sit on, so a list of chosen apps looked like
                  // stray text and the remove button beside each one
                  // looked like it belonged to nothing.
                  className="group flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.04] px-2.5 py-2 transition-colors hover:border-white/14 hover:bg-white/[0.07]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-[13px] font-semibold">{appName(path)}</p>
                      {/* Says what happens to this app, per app, rather
                          than leaving it to be inferred from a toggle
                          above. A tester picked a browser, opened it,
                          found the real IP and reported Custom mode
                          broken -- the direction is the one thing that
                          silently produces exactly that, and a label on
                          the row is where it stops being ambiguous. */}
                      <span
                        className={[
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          settings.mode === "allExcept"
                            ? "bg-white/8 text-muted-foreground"
                            : "bg-highlight/15 text-highlight",
                        ].join(" ")}
                      >
                        {settings.mode === "allExcept"
                          ? t("settings.customAppBypasses")
                          : t("settings.customAppUsesVpn")}
                      </span>
                      {/* A second badge, and only when it is true. "Uses
                          VPN" is now two different promises -- all of
                          this program's traffic, or only the part going
                          to its game servers -- and a customer who
                          checks their IP in the game's launcher while
                          only the game servers are carried would
                          otherwise conclude the feature is broken. It
                          is the same reason the badge beside it exists. */}
                      {scopeOf(settings, path) ? (
                        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          {t("settings.customAppScoped")}
                        </span>
                      ) : null}
                    </div>
                    {/* The full path is what actually gets matched, so
                        it is shown rather than hidden -- two games can
                        share an executable name. */}
                    <p className="truncate text-[10px] text-muted-foreground" dir="ltr">
                      {path}
                    </p>
                    {scopeOf(settings, path) ? (
                      <p className="text-[10px] text-muted-foreground">
                        {t("settings.customAppScopedHint")}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={`${t("settings.customRemove")} ${appName(path)}`}
                    onClick={() => {
                      // The scope goes with the app. Left behind it is
                      // inert -- the service drops a scope naming an
                      // app it was not given -- but it would come back
                      // to life if the customer re-added that program
                      // by hand later, silently narrowing a selection
                      // they made expecting the ordinary behaviour.
                      const apps = settings.apps.filter((a) => a !== path);
                      void apply({ ...settings, apps, scopes: scopesFor(apps, settings.scopes) });
                    }}
                    className="press flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {notice ? <p className="text-xs text-destructive">{notice}</p> : null}

          {/* Two ways in, because neither covers everything. The
              running list is how a person actually thinks about it --
              "that one, the game I have open" -- but it cannot offer
              something that is not running yet, and browsing can. */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setNotice(null);
                setPicking(true);
              }}
              className="flex-1 justify-center gap-2"
            >
              <ListChecks className="size-4" />
              {t("settings.customPickRunning")}
            </Button>
            <Button
              variant="outline"
              onClick={() => void browseForApp()}
              className="flex-1 justify-center gap-2"
            >
              <FolderOpen className="size-4" />
              {t("settings.customPickFile")}
            </Button>
          </div>

          {/* A third way in, and the only one that knows what a game
              needs. The other two ask the customer to already know:
              the handover records people choosing one executable,
              getting half a product routed, and reporting Custom mode
              as broken. */}
          {games && games.length > 0 ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setNotice(null);
                  setPickingGame(true);
                }}
                className="w-full justify-center gap-2"
              >
                <Gamepad2 className="size-4" />
                {t("settings.customPickGame")}
              </Button>
              <p className="text-[11px] text-muted-foreground">{t("settings.customGameHint")}</p>
            </>
          ) : null}

          {pickingGame && games ? (
            <GamePicker
              games={games}
              // Nothing is "already chosen" here: Custom mode does not
              // store a game, only the paths one resolved to. Marking
              // rows chosen would claim a memory this mode does not
              // keep, and would block re-adding a game after starting
              // the programs that were missing the first time.
              chosen={[]}
              emptyLabel={t("settings.customGameEmpty")}
              subtitle={(game) =>
                t("settings.customGameParts", { count: curatedNames(game).length })
              }
              onClose={() => setPickingGame(false)}
              onPick={(slug) => {
                setPickingGame(false);
                const game = games.find((g) => g.slug === slug);
                if (game) void addGame(game);
              }}
            />
          ) : null}

          {picking ? (
            <RunningAppPicker
              chosen={settings.apps}
              onClose={() => setPicking(false)}
              onPick={(paths) => {
                setPicking(false);
                void addPaths(paths);
              }}
            />
          ) : null}

          {effective ? (
            <p className="text-[11px] text-muted-foreground">{t("settings.customApplies")}</p>
          ) : null}
          {/* Shown whenever the mode is on, not only once. A customer in
              Iran needs to know traffic can leave in the clear during a
              server switch; for a gamer it is the reason their match
              does not stall. Same behaviour, and both deserve to be
              told rather than to find out. */}
          <p className="text-[11px] text-muted-foreground">{t("settings.customFailOpen")}</p>
        </div>
      ) : null}
    </Card>
  );
}
