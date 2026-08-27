import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppWindow, FolderOpen, Gamepad2, ListChecks, MapPin, X } from "lucide-react";
import { RunningAppPicker } from "./RunningAppPicker";
import { GamePicker } from "./GamePicker";
import { useI18n } from "../lib/i18n";
import {
  appName,
  gamesFor,
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
import { loadSnapshot } from "../lib/credential-cache";
import { exitOptions, hasExitVocabulary, type ExitOption } from "../lib/exit-options";
import {
  fetchExitPlacements,
  gamePlacement,
  type AppPlacement,
} from "../lib/exit-placement";
import type { RouteOption } from "../lib/types";
import {
  curatedNames,
  exitsForGames,
  gameExitGroup,
  hasCuratedApps,
  isWholeGroup,
  resolveGameApps,
  scopesForGame,
  unresolvedNames,
  type GameExitGroup,
} from "../lib/game-apps";
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
  /**
   * A game from the catalogue that matched nothing running, kept until
   * something makes it stale.
   *
   * Separate from `notice` because it must outlive the click that
   * produced it. `notice` is a one-line transient that every subsequent
   * action clears, which is right for "already on the list" and wrong
   * for this: resolving nothing is the case where the customer is most
   * likely to believe the opposite of what happened, because the card
   * looks exactly as it did before they picked the game.
   */
  const [unmatched, setUnmatched] = useState<{ game: string; names: string[] } | null>(null);
  const [picking, setPicking] = useState(false);
  /** The server's curated game list, or null until it has been asked
   * for. Games with no executable list are dropped here rather than in
   * the picker: a row that would add nothing must not be offered. */
  const [games, setGames] = useState<GameProfileSummary[] | null>(null);
  const [pickingGame, setPickingGame] = useState(false);
  /** The routes this subscription can reach, read from the offline
   * snapshot rather than fetched.
   *
   * The snapshot is what the connect path already dials on when the
   * control plane is unreachable, and this screen has the same
   * requirement for the same reason: a customer in Iran whose API is
   * filtered must still be able to see and change where their games go.
   * An empty list simply means no exit picker, which is the state that
   * shipped before exits had names. */
  const [routes, setRoutes] = useState<RouteOption[]>([]);
  /** Where the service says each selected program is actually leaving
   * from, or `null` while it has not answered.
   *
   * Null is not "no preference" and is not rendered as one. The helper
   * is a Windows service with its own lifetime and can be restarting;
   * saying "no preference" for a game the customer chose an exit for
   * would tell them their choice was lost. */
  const [placements, setPlacements] = useState<AppPlacement[] | null>(null);

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
    // The cached answer, not a fresh request. Everything the picker
    // needs -- which routes exist and which of them are the same exit --
    // was already saved the last time the app talked to the control
    // plane, and asking again would make the screen depend on a network
    // the customer may not have.
    void loadSnapshot().then((snapshot) => {
      if (!cancelled && snapshot) setRoutes(snapshot.routes);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Re-asks the service where things are leaving from.
   *
   * Its own round trip rather than something on the status poll, which
   * runs continuously -- this answer costs a walk of the whole
   * selection, so it is asked when a screen showing it opens or
   * changes, which is when somebody is looking at it.
   *
   * A failure leaves `placements` null, which renders as "not
   * established" rather than as a match or a mismatch. */
  function refreshPlacements() {
    void fetchExitPlacements().then(
      (result) => setPlacements(result.apps),
      () => setPlacements(null),
    );
  }

  useEffect(() => {
    refreshPlacements();
    // The customer connects from the dashboard, so the interesting
    // change happens while this screen is not in front. Re-asking on
    // focus catches it without polling for something that changes once
    // a session.
    const onFocus = () => refreshPlacements();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  /** The exits this customer can choose between, grouped so that two
   * routes ending on one machine read as one place. */
  const exits = exitOptions(routes);

  /** What to call an exit in the list.
   *
   * A direct route is dialled at the machine it leaves from, so its
   * node name names the exit. A relay is dialled somewhere else
   * entirely, and its node name is the *entry* -- borrowing it would
   * tell a customer their traffic appears from Iran when it appears
   * from Germany. So an exit reached only through relays is named as
   * what it is: somewhere reached through those relays, without a
   * claim about where it is. That is the same thing the location list
   * has always said, and a smaller claim beats a wrong one.
   */
  function exitLabel(option: ExitOption): string {
    const base = option.hidden
      ? t("settings.customExitHidden", {
          via: option.routes.map((r) => r.location.nodeName).join(", "),
        })
      : option.directNames.join(", ");
    // Said, never enforced. A preference for an exit having a bad hour
    // is the ordinary case, and refusing it would take the customer's
    // whole selection down over something that fixes itself.
    return option.online ? base : `${base} ${t("settings.customExitDown")}`;
  }

  /** The badge on a game's row. Four answers, and the fourth is the
   * point: with nothing intercepting there is no match and no mismatch
   * to report, and saying either would be asserting something nobody
   * checked. */
  function placementBadge(placement: { placement: string }): { text: string; className: string } {
    switch (placement.placement) {
      case "onPreferred":
        return { text: t("settings.customExitOnPreferred"), className: "bg-highlight/15 text-highlight" };
      case "fallback":
        return { text: t("settings.customExitFallback"), className: "bg-warning/15 text-warning" };
      case "unknown":
        return { text: t("settings.customExitUnknown"), className: "bg-white/8 text-muted-foreground" };
      default:
        return { text: t("settings.customExitNoPreference"), className: "bg-white/8 text-muted-foreground" };
    }
  }

  /** Records a customer's choice of exit for one game.
   *
   * On the group, which is the only place it can be written. There is
   * no per-application exit field anywhere in this client's state, so
   * this cannot put a game's launcher and its client on two exits
   * however the screen is driven -- see `GameExitGroup`.
   */
  async function chooseExit(slug: string, exit: string | null) {
    if (!settings) return;
    await apply({
      ...settings,
      games: settings.games.map((game) => (game.slug === slug ? { ...game, exit } : game)),
    });
  }

  async function apply(next: SplitTunnelSettings) {
    setSettings(next);
    await saveSplitTunnel(next);
    // Pushed immediately as well as on connect. A customer who removes
    // an app while connected should stop having it routed, not wait for
    // a reconnect to find out whether it worked.
    try {
      // No egress named. This screen has no idea which route a live
      // session landed on -- the connect path does, and it re-sends the
      // selection with one attached the moment a candidate comes up.
      // Naming one here would be guessing, and the service reports a
      // preference it cannot compare as unknown, which is true.
      await pushSplitTunnel(next);
    } catch {
      // The service may not be running yet; connect re-sends anyway.
    }
    // The selection just changed, so which programs the service can
    // answer for changed with it.
    refreshPlacements();
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
  async function addPaths(picked: string[], gameScopes: AppScope[] = [], game?: GameExitGroup) {
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
    // The group the paths came from, kept rather than flattened away.
    //
    // This is the whole fix for a real ban risk: a game is routinely
    // several binaries -- Rust is its EAC wrapper plus `RustClient.exe`
    // -- and once a game's paths are merged into one undifferentiated
    // `apps` list, nothing can put those binaries on one exit together
    // because nothing knows they belong together any more. See
    // `GameExitGroup` and `docs/design/ban-safety.md` mechanism 4.
    //
    // Re-adding a game replaces its group rather than adding a second
    // one, so a customer who adds Rust at the launcher, starts it, and
    // adds it again ends up with one whole group and not two partial
    // ones.
    const games = game
      ? [...settings.games.filter((g) => g.slug !== game.slug), game]
      : settings.games;
    await apply({ ...settings, apps, scopes: scopesFor(apps, scopes), games: gamesFor(apps, games) });
    // Cleared here rather than only where it was set, so the warning
    // cannot outlive its own truth. Its whole point is that the
    // customer picked a game by hand afterwards -- and a red block
    // still saying nothing was added, above a list that now contains
    // the program they just added, would be the same failure this
    // change exists to fix, pointing the other way.
    setUnmatched(null);
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
      // Kept on screen rather than said once in the notice line, which
      // is the whole difference between this and what shipped.
      //
      // A game that resolves *nothing* creates no group, so unlike a
      // partly-resolved game there is no row left behind to carry a
      // warning -- the card simply returned to how it looked before,
      // with one small red sentence that the next click cleared. The
      // customer's reasonable reading of that is that it worked.
      //
      // `wanted` rather than `resolved.missing`: they are equal here by
      // construction, and naming the variable that means "what Neoxify
      // looked for" is what the message is actually about.
      setUnmatched({ game: game.displayName, names: wanted });
      return;
    }
    setUnmatched(null);
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
    // Built from the profile, so a group's members can only ever be the
    // catalogue's own list for one game. No exit is chosen here --
    // `null` is "no preference", which is what every application had
    // before per-game exits existed.
    const added = await addPaths(resolved.paths, gameScopes, gameExitGroup(game));
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
                      // And the group goes when its last binary does,
                      // for the same reason. A group that lost only
                      // some of its binaries is kept and becomes
                      // partial, which withholds its exit and says so
                      // -- see the warning above the list.
                      void apply({
                        ...settings,
                        apps,
                        scopes: scopesFor(apps, settings.scopes),
                        games: gamesFor(apps, settings.games),
                      });
                    }}
                    className="press flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Games that are only partly added, named.

              This is not tidiness. A binary that is not on the list is
              not carried, so when it starts it reaches the game's
              servers from the customer's own address while the rest of
              the game reaches them through Neoxify -- one account,
              two source addresses, at the same instant, which is the
              account-sharing signature publishers look for
              (`docs/design/ban-safety.md` mechanism 4). The card said
              which programs were missing at the moment the game was
              added; it did not keep saying it, and the customer who
              added a game at its launcher screen is exactly the
              customer who never saw that sentence again.

              Only for games added from the catalogue, because that is
              the only place this client knows what a whole game is. */}
          {settings.mode === "onlySelected"
            ? settings.games
                .filter((game) => !isWholeGroup(game, settings.apps))
                .map((game) => (
                  <div
                    key={game.slug}
                    className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2"
                  >
                    <p className="text-xs font-medium text-destructive">
                      {t("settings.customGameSplit", { game: game.displayName })}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("settings.customGameSplitBody", {
                        game: game.displayName,
                        names: unresolvedNames(game, settings.apps).join(", "),
                      })}
                    </p>
                  </div>
                ))
            : null}

          {/* Where each game leaves from, and where it actually is.

              Only under "only these apps": the other direction names
              the programs that are deliberately NOT carried, so they
              have no egress and a preference for one would be an
              invention. And only when the route list can name an exit
              at all -- an older backend, or one with no handle secret
              configured, gives this client no exit vocabulary, and the
              honest response to that is to offer no choice rather than
              a choice built out of route ids that would report a
              mismatch for a game sitting exactly where it was put. */}
          {settings.mode === "onlySelected" && settings.games.length > 0 && hasExitVocabulary(routes) ? (
            <div className="flex flex-col gap-2 rounded-lg border border-white/8 bg-white/[0.03] p-2.5">
              <div className="flex items-center gap-1.5">
                <MapPin className="size-3.5 text-primary" />
                <p className="text-xs font-semibold">{t("settings.customExitTitle")}</p>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("settings.customExitHint")}</p>

              <ul className="flex flex-col gap-1.5">
                {settings.games.map((game) => {
                  const placement = gamePlacement(game, settings.apps, placements);
                  const badge = placement ? placementBadge(placement) : null;
                  // A saved choice the route list no longer offers --
                  // a plan change, or a server that rotated the key
                  // these handles are minted under. Kept as an option
                  // rather than silently dropped: a select whose value
                  // matches nothing renders blank, and a customer would
                  // read that as their choice having been forgotten
                  // when what actually happened is that it can no
                  // longer be honoured.
                  const chosenIsGone =
                    typeof game.exit === "string" &&
                    game.exit.length > 0 &&
                    !exits.some((option) => option.exit === game.exit);
                  return (
                    <li
                      key={game.slug}
                      className="flex flex-col gap-1.5 rounded-md border border-white/8 bg-white/[0.04] px-2.5 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-[13px] font-semibold">{game.displayName}</p>
                        {badge ? (
                          <span
                            className={[
                              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                              badge.className,
                            ].join(" ")}
                          >
                            {badge.text}
                          </span>
                        ) : null}
                      </div>
                      <select
                        aria-label={t("settings.customExitFor", { game: game.displayName })}
                        value={game.exit ?? ""}
                        onChange={(event) => void chooseExit(game.slug, event.target.value || null)}
                        className="w-full rounded-md border border-white/10 bg-surface px-2 py-1.5 text-[12px] outline-none focus:border-primary/60"
                      >
                        <option value="">{t("settings.customExitNone")}</option>
                        {exits.map((option) => (
                          <option key={option.exit} value={option.exit}>
                            {exitLabel(option)}
                          </option>
                        ))}
                        {chosenIsGone ? (
                          <option value={game.exit ?? ""}>{t("settings.customExitGone")}</option>
                        ) : null}
                      </select>
                      {/* Said on the row, and only when it is true.

                          `unknown` is the one that must not be dressed
                          up. Nothing is intercepting, so there is no
                          match and no mismatch -- and a badge that read
                          "on your exit" here would be the same claim as
                          a "Connected" indicator nothing checked. */}
                      {placement?.placement === "unknown" ? (
                        <p className="text-[10px] text-muted-foreground">
                          {t("settings.customExitUnknownHint")}
                        </p>
                      ) : null}
                      {placement?.placement === "fallback" ? (
                        <p className="text-[10px] text-warning">
                          {t("settings.customExitFallbackHint", { game: game.displayName })}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {/* The ceiling, stated rather than discovered. One session
                  carries one tunnel and therefore leaves from one exit,
                  so two games wanting two exits means one of them is on
                  the other's. A picker that implied otherwise would be
                  selling something the service cannot deliver. */}
              <p className="text-[11px] text-muted-foreground">{t("settings.customExitOneAtATime")}</p>
            </div>
          ) : null}

          {/* A game that asked for an exit and did not get one.

              Both cases fail toward no preference, which is safe: the
              game is carried on the session's exit like everything
              else. Said out loud because a customer who asked for
              something and silently did not get it has been told the
              smaller half of what happened. */}
          {exitsForGames(settings.games, settings.apps).withheld.map((held) => (
            <p key={held.slug} className="text-[11px] text-muted-foreground">
              {held.reason === "partial"
                ? t("settings.customGameExitPartial", {
                    game: held.displayName,
                    names: held.missing.join(", "),
                  })
                : t("settings.customGameExitConflict", {
                    game: held.displayName,
                    others: held.withGames.join(", "),
                  })}
            </p>
          ))}

          {/* A game that resolved nothing at all.

              The catalogue's names come from Valve's appinfo for each
              game's Steam build, and every title with a non-Steam
              distribution is exposed to naming programs that are not on
              the customer's disk. Old School RuneScape is the one that
              has been checked: its row names oslaunch.exe and
              osclient.exe, Jagex's own installer ships
              JagexLauncher.exe, and the row therefore routes nothing at
              all for anyone who installed it the account-free way.

              So this names what was looked for. Without that the
              customer has no way to tell "the game is not running yet"
              -- which their next action fixes -- from "these names are
              not my game's", which no amount of retrying will. */}
          {unmatched ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-2">
              <p className="text-xs font-medium text-destructive">
                {t("settings.customGameNone", { game: unmatched.game })}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {t("settings.customGameNoneBody", {
                  game: unmatched.game,
                  names: unmatched.names.join(", "),
                })}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setUnmatched(null);
                  setNotice(null);
                  setPicking(true);
                }}
                className="mt-2 h-8 gap-2 px-2.5 text-xs"
              >
                <ListChecks className="size-3.5" />
                {t("settings.customGameNoneAction")}
              </Button>
            </div>
          ) : null}

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
          {/* Ping, and why it stops.

              Measured on the rig: a game whose TCP was fully tunnelled
              still sent 174 ICMP echo requests in the clear to roughly
              170 of its world servers, so a correctly-routed player was
              handing their real address to every one of them -- and the
              latency figures the game displayed were describing the
              direct path, not the tunnel. The service now refuses those
              packets rather than letting them out.

              It cannot be narrowed to the chosen apps. An ICMP packet
              carries no port and Windows keeps no ICMP equivalent of the
              endpoint tables the split tunnel attributes TCP and UDP
              with, so there is nothing to ask which program sent one.
              Blocking machine-wide is the honest version of that, and
              this paragraph is the half of it the customer is owed:
              a visible broken feature they were warned about beats an
              invisible leak they were not.

              Shown whenever the mode is on, beside the fail-open note
              and for the same reason -- it is a standing property of
              Custom mode, not an event. */}
          <p className="text-[11px] font-medium text-foreground">
            {t("settings.customIcmpTitle")}
          </p>
          <p className="text-[11px] text-muted-foreground">{t("settings.customIcmpBody")}</p>
        </div>
      ) : null}
    </Card>
  );
}
