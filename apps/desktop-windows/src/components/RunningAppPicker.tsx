import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, RefreshCw, Search, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { listRunningApps, type RunningApp } from "../lib/split-tunnel";
import { Button } from "./ui";

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

  // Rendered into the body rather than where it sits in the tree.
  // `position: fixed` is measured against the nearest ancestor with a
  // transform or filter rather than the viewport, and the card this
  // lives inside has both -- which clipped the dialog's own header and
  // its Cancel button off the top of the screen while the list in the
  // middle still looked fine.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col gap-3 rounded-xl border border-white/10 bg-popover p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-sm font-semibold">{t("settings.customRunningTitle")}</p>
          <button
            type="button"
            aria-label={t("settings.customRunningRefresh")}
            onClick={() => void refresh()}
            className="press flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("settings.customCancel")}
            onClick={onClose}
            className="press flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("settings.customSearch")}
            className="w-full rounded-lg border border-white/8 bg-white/[0.03] py-1.5 pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground focus:border-white/20"
          />
        </div>

        {apps === null ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : shown && shown.length === 0 ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {query.trim() ? t("settings.customSearchEmpty") : t("settings.customRunningEmpty")}
          </p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {(shown ?? []).map((app) => {
              const picked = already.has(app.path.toLowerCase());
              return (
                <li key={app.path}>
                  <button
                    type="button"
                    disabled={picked}
                    onClick={() => onPick(app.paths?.length ? app.paths : [app.path])}
                    className={[
                      "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left",
                      picked
                        ? "cursor-default border-white/5 bg-white/[0.015] opacity-50"
                        : "press border-white/8 bg-white/[0.025] hover:bg-white/[0.05]",
                    ].join(" ")}
                  >
                    {/* The icon Windows draws for it, so the list is
                        something to recognise rather than to read. */}
                    {app.icon ? (
                      <img
                        src={`data:image/png;base64,${app.icon}`}
                        alt=""
                        className="size-6 shrink-0 rounded"
                      />
                    ) : (
                      <div className="flex size-6 shrink-0 items-center justify-center rounded bg-white/8 text-[10px] font-semibold text-muted-foreground">
                        {app.name.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold">{app.name}</p>
                      {/* The full path is what gets matched, so it is
                          shown -- two programs can share a file name. */}
                      {/* One product is often several executables, and
                          the count is the honest way to say so -- it is
                          what stops "I picked Discord and half of it
                          still went round the VPN". */}
                      <p className="truncate text-[10px] text-muted-foreground" dir="ltr">
                        {app.paths && app.paths.length > 1
                          ? t("settings.customAppParts", { count: String(app.paths.length) })
                          : app.path}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {failed ? (
          <p className="text-[11px] text-muted-foreground">{t("settings.customRunningEmpty")}</p>
        ) : null}

        <Button variant="outline" onClick={onClose} className="w-full justify-center">
          {t("settings.customCancel")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}
