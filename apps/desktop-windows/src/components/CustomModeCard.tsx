import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AppWindow, Plus, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import {
  appName,
  isEffective,
  loadSplitTunnel,
  MAX_APPS,
  pushSplitTunnel,
  saveSplitTunnel,
  type SplitTunnelSettings,
} from "../lib/split-tunnel";
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

  useEffect(() => {
    let cancelled = false;
    void loadSplitTunnel().then((loaded) => {
      if (!cancelled) setSettings(loaded);
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

  async function addApp() {
    setNotice(null);
    if (!settings) return;
    if (settings.apps.length >= MAX_APPS) {
      setNotice(t("settings.customTooMany", { max: MAX_APPS }));
      return;
    }

    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Programs", extensions: ["exe"] }],
    });
    if (typeof picked !== "string") return;

    // Compared case-insensitively because Windows paths are, and the
    // picker's casing does not always match what a running process
    // reports -- two entries for one app would look like a bug.
    if (settings.apps.some((a) => a.toLowerCase() === picked.toLowerCase())) {
      setNotice(t("settings.customAlready"));
      return;
    }
    await apply({ ...settings, apps: [...settings.apps, picked] });
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
          <span
            className={[
              "absolute top-0.5 size-4 rounded-full bg-white transition-[left]",
              settings.enabled ? "left-[1.375rem]" : "left-0.5",
            ].join(" ")}
          />
        </button>
      </div>

      {settings.enabled ? (
        <div className="flex flex-col gap-2">
          {settings.apps.length === 0 ? (
            <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {t("settings.customNoApps")}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {settings.apps.map((path) => (
                <li
                  key={path}
                  className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.025] px-2.5 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold">{appName(path)}</p>
                    {/* The full path is what actually gets matched, so
                        it is shown rather than hidden -- two games can
                        share an executable name. */}
                    <p className="truncate text-[10px] text-muted-foreground" dir="ltr">
                      {path}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`${t("settings.customRemove")} ${appName(path)}`}
                    onClick={() =>
                      void apply({ ...settings, apps: settings.apps.filter((a) => a !== path) })
                    }
                    className="press flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {notice ? <p className="text-xs text-destructive">{notice}</p> : null}

          <Button
            variant="outline"
            onClick={() => void addApp()}
            className="w-full justify-center gap-2"
          >
            <Plus className="size-4" />
            {t("settings.customAddApp")}
          </Button>

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
