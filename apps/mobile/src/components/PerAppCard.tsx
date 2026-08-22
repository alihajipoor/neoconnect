import { useEffect, useMemo, useState } from "react";
import { AppWindow, Check, Loader2, Search } from "lucide-react";
import { useI18n } from "@shared/lib/i18n";
import { Button, Card, Input } from "@shared/components/ui";
import {
  listInstalledApps,
  loadPerApp,
  savePerApp,
  type InstalledApp,
  type PerAppSettings,
} from "../lib/per-app";

/** Custom mode on Android: choose which apps use the VPN.
 *
 * A list of installed apps rather than the Windows client's file picker,
 * because that is what the platform actually offers -- Android has no
 * browsable executable path to point at, and `addAllowedApplication`
 * takes a package name. It is also simply a better experience: names and
 * icons the customer recognises, instead of hunting through Program
 * Files for a .exe.
 *
 * Two things stated out loud, both places where a VPN client is tempted
 * to stay quiet and let the customer assume:
 *
 * * **On with nothing chosen routes everything.** Reachable by flipping
 *   the toggle and getting distracted. An empty allow-list handed to
 *   VpnService would route *nothing*, which looks identical to a broken
 *   tunnel -- so the app falls back to a full tunnel and says so.
 * * **It applies from the next connection.** The allow-list is fixed
 *   when the TUN device is created; it cannot be retrofitted onto a
 *   tunnel already carrying everything.
 */
export function PerAppCard() {
  const { t } = useI18n();
  const [settings, setSettings] = useState<PerAppSettings | null>(null);
  const [apps, setApps] = useState<InstalledApp[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPerApp().then((loaded) => {
      if (!cancelled) setSettings(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only once the mode is on. Enumerating every installed package and
  // decoding its icon is real work on a phone, and doing it on a screen
  // the customer opened to change their password is work for nothing.
  useEffect(() => {
    if (!settings?.enabled || apps !== null) return;
    let cancelled = false;
    void listInstalledApps()
      .then((list) => {
        if (cancelled) return;
        // Alphabetical, and by the name shown rather than the package:
        // sorting by package name groups by vendor, which is not how
        // anybody looks for an app.
        setApps([...list].sort((a, b) => a.label.localeCompare(b.label)));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [settings?.enabled, apps]);

  async function apply(next: PerAppSettings) {
    setSettings(next);
    await savePerApp(next);
    // Deliberately not pushed to a live tunnel the way the Windows
    // client pushes its list. There is nothing to push to: the allow-list
    // is baked into the TUN device at creation, so changing it takes
    // effect on the next connection and claiming otherwise would be a
    // lie the UI could not back up.
  }

  const visible = useMemo(() => {
    if (!apps) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter(
      (a) =>
        a.label.toLowerCase().includes(needle) || a.packageName.toLowerCase().includes(needle),
    );
  }, [apps, query]);

  if (!settings) return null;
  const selected = new Set(settings.packages);

  function toggleApp(pkg: string) {
    if (!settings) return;
    const next = selected.has(pkg)
      ? settings.packages.filter((p) => p !== pkg)
      : [...settings.packages, pkg];
    void apply({ ...settings, packages: next });
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
          <AppWindow className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold">{t("settings.custom")}</p>
          </div>
          {/* Not the Windows hint: that one ends with "still new, tell us
              if something looks wrong", which was earned by five releases
              of a hand-built redirector. This is Android's own API doing
              the routing, and borrowing the caveat would be theatre. */}
          <p className="text-xs text-muted-foreground">{t("settings.customHintNative")}</p>
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
              reads "off". The Windows client had the same bug in its own
              copy of this card; both are fixed, separately, because this
              card is Android's own -- it lists installed packages where
              Windows browses for a .exe. */}
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
          {settings.packages.length === 0 ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t("settings.customAllApps")}
            </p>
          ) : null}

          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {apps === null && !error ? (
            <div className="flex items-center gap-2 px-1 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("common.loading")}
            </div>
          ) : null}

          {apps !== null ? (
            <>
              <div className="relative">
                {/* Logical inset, so the glyph sits at the edge the text
                    starts from -- under Persian a physical `left` put it
                    on top of the first characters typed, and the padding
                    that was meant to clear it opened a gap on the empty
                    side instead. */}
                <Search className="pointer-events-none absolute top-1/2 start-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.customSearch")}
                  className="ps-9"
                />
              </div>

              <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto">
                {visible.map((app) => {
                  const on = selected.has(app.packageName);
                  return (
                    <li key={app.packageName}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleApp(app.packageName)}
                        className={[
                          "press flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-start transition-colors",
                          on
                            ? "border-primary/40 bg-primary/10"
                            : "border-white/8 bg-white/[0.025] hover:bg-white/[0.05]",
                        ].join(" ")}
                      >
                        {app.icon ? (
                          <img src={app.icon} alt="" className="size-8 shrink-0 rounded-lg" />
                        ) : (
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/8 text-muted-foreground">
                            <AppWindow className="size-4" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold">{app.label}</p>
                          <p className="truncate text-[10px] text-muted-foreground" dir="ltr">
                            {app.packageName}
                          </p>
                        </div>
                        {on ? <Check className="size-4 shrink-0 text-primary" /> : null}
                      </button>
                    </li>
                  );
                })}
                {visible.length === 0 ? (
                  <li className="px-1 py-3 text-xs text-muted-foreground">
                    {t("settings.customNoMatches")}
                  </li>
                ) : null}
              </ul>

              {settings.packages.length > 0 ? (
                <Button
                  variant="ghost"
                  onClick={() => void apply({ ...settings, packages: [] })}
                  className="w-full justify-center border border-white/10 text-xs"
                >
                  {t("settings.customClear")}
                </Button>
              ) : null}
            </>
          ) : null}

          <p className="text-[11px] text-muted-foreground">{t("settings.customApplies")}</p>
        </div>
      ) : null}
    </Card>
  );
}
