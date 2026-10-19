import { useEffect, useMemo, useState } from "react";
import { AppWindow, Check, Loader2, Search } from "lucide-react";
import { useI18n } from "@shared/lib/i18n";
import { CardHead, Message, PillButton, Switch } from "@shared/components/ui";
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
    <div className="nx-card nx-pcard nx-perapp">
      <div className="nx-perapp-head">
        {/* Not the Windows hint: that one ends with "still new, tell us if
            something looks wrong", which was earned by five releases of a
            hand-built redirector. This is Android's own API doing the
            routing, and borrowing the caveat would be theatre. */}
        <CardHead icon={<AppWindow />} title={t("settings.custom")} hint={t("settings.customHintNative")} />
        {/* The shared switch: its thumb runs from the inline start, so under
            Persian "on" sits where the eye reads "on". */}
        <Switch
          checked={settings.enabled}
          onChange={(enabled) => void apply({ ...settings, enabled })}
          label={t("settings.custom")}
        />
      </div>

      {settings.enabled ? (
        <div className="nx-perapp-body">
          {/* On with nothing chosen routes everything, and says so: an
              empty allow-list would route nothing, which looks identical
              to a broken tunnel. Information, not a fault. */}
          {settings.packages.length === 0 ? <Message tone="neutral">{t("settings.customAllApps")}</Message> : null}

          {error ? <Message tone="danger">{error}</Message> : null}

          {apps === null && !error ? (
            <p className="nx-perapp-wait" role="status">
              <Loader2 className="animate-spin" aria-hidden />
              {t("common.loading")}
            </p>
          ) : null}

          {apps !== null ? (
            <>
              <div className="nx-perapp-search">
                {/* At the edge the text starts from, in either language. */}
                <Search aria-hidden />
                <input
                  className="nx-input"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.customSearch")}
                  aria-label={t("settings.customSearch")}
                />
              </div>

              <ul className="nx-perapp-list">
                {visible.map((app) => {
                  const on = selected.has(app.packageName);
                  return (
                    <li key={app.packageName}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => toggleApp(app.packageName)}
                        className="nx-perapp-row"
                      >
                        {app.icon ? (
                          <img src={app.icon} alt="" className="ico" />
                        ) : (
                          <span className="ico none" aria-hidden>
                            <AppWindow />
                          </span>
                        )}
                        <span className="t">
                          <span className="n">{app.label}</span>
                          <span className="s" dir="ltr">
                            {app.packageName}
                          </span>
                        </span>
                        <span className="box" aria-hidden>
                          {on ? <Check /> : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {visible.length === 0 ? <li className="nx-perapp-none">{t("settings.customNoMatches")}</li> : null}
              </ul>

              {settings.packages.length > 0 ? (
                <PillButton variant="ghost" size="sm" className="nx-perapp-clear" onClick={() => void apply({ ...settings, packages: [] })}>
                  {t("settings.customClear")}
                </PillButton>
              ) : null}
            </>
          ) : null}

          {/* The allow-list is fixed when the tunnel is made: it applies
              from the next connection. */}
          <p className="nx-perapp-note">{t("settings.customApplies")}</p>
        </div>
      ) : null}
    </div>
  );
}
