import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { listRunningApps, type RunningApp } from "../lib/split-tunnel";
import { PickerDialog } from "./overlay";
import { Message, PillButton } from "./ui";

/** Pick an application from what is running, rather than hunting for its
 * executable.
 *
 * The list comes from the helper service, not from here: this app is not
 * elevated, so it can see that a process exists but not the image path
 * of one it does not own -- and the path is exactly what a selection is
 * made of. Asking the service is the only way to offer a list that can
 * actually be selected from.
 *
 * Applications already chosen stay visible but disabled rather than
 * disappearing, because a list that silently omits things reads as the
 * program not being found.
 *
 * A proper dialog (`PickerDialog`), drawn at the document root: inside the
 * card that opens it, `position: fixed` was measured against that card's
 * backdrop filter, which clipped the dialog's own header and its Cancel
 * button off the top of the screen while the list in the middle still
 * looked fine.
 */
export function RunningAppPicker({
  chosen,
  onPick,
  onClose,
}: {
  chosen: string[];
  /** Every executable of the chosen product, not just the one shown. */
  onPick: (paths: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [apps, setApps] = useState<RunningApp[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");

  async function refresh() {
    setApps(null);
    setFailed(false);
    try {
      setApps(await listRunningApps());
    } catch {
      // The service may be stopped or still starting. Say so plainly and
      // leave the file picker as the way through, rather than showing an
      // empty list that looks like nothing is running.
      setFailed(true);
      setApps([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const already = new Set(chosen.map((c) => c.toLowerCase()));

  // Matched on the name people actually read. Searching paths as well
  // would make "app" match half of Program Files.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !apps) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(needle));
  }, [apps, query]);

  return (
    <PickerDialog
      open
      title={t("settings.customRunningTitle")}
      onClose={onClose}
      closeLabel={t("settings.customCancel")}
      headActions={
        <button
          type="button"
          className="nx-ibtn sm"
          onClick={() => void refresh()}
          aria-label={t("settings.customRunningRefresh")}
          title={t("settings.customRunningRefresh")}
        >
          <RefreshCw aria-hidden />
        </button>
      }
      search={{ value: query, onChange: setQuery, placeholder: t("settings.customSearch") }}
      foot={
        <PillButton variant="ghost" size="sm" onClick={onClose}>
          {t("settings.customCancel")}
        </PillButton>
      }
    >
      {apps === null ? (
        <p className="nx-pick-wait" role="status">
          <span className="nx-spin" aria-hidden />
          <span className="nx-sr">{t("common.loading")}</span>
        </p>
      ) : failed || (shown && shown.length === 0) ? (
        <Message tone="neutral">{query.trim() && !failed ? t("settings.customSearchEmpty") : t("settings.customRunningEmpty")}</Message>
      ) : (
        <ul className="nx-pick-list">
          {(shown ?? []).map((app) => {
            const picked = already.has(app.path.toLowerCase());
            return (
              <li key={app.path}>
                <button
                  type="button"
                  className="nx-pick-row"
                  disabled={picked}
                  onClick={() => onPick(app.paths?.length ? app.paths : [app.path])}
                >
                  {/* The icon Windows draws for it, so the list is
                      something to recognise rather than to read. */}
                  <span className="nx-pick-tile" aria-hidden>
                    {app.icon ? <img src={`data:image/png;base64,${app.icon}`} alt="" /> : app.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="t">
                    <span className="n">{app.name}</span>
                    {/* The full path is what gets matched, so it is shown --
                        two programs can share a file name. One product is
                        often several executables, and the count is the
                        honest way to say so: it is what stops "I picked
                        Discord and half of it still went round the VPN". */}
                    <span className="s" dir={app.paths && app.paths.length > 1 ? undefined : "ltr"}>
                      {app.paths && app.paths.length > 1
                        ? t("settings.customAppParts", { count: String(app.paths.length) })
                        : app.path}
                    </span>
                  </span>
                  {picked ? (
                    <span className="tag">
                      <Check aria-hidden />
                      {t("pick.added")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </PickerDialog>
  );
}
