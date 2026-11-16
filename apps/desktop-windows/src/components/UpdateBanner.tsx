import { Download, RefreshCw } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { PillButton } from "./ui";
import type { UpdateState } from "../lib/updates";

/** A thin strip, not a dialog.
 *
 * An update is good news that can wait. Interrupting somebody who
 * opened the app to connect -- possibly because they cannot reach
 * anything without it -- to tell them about a new version would be the
 * wrong trade every time. It installs on quit whether or not this is
 * ever read; the button is only for someone who would rather have it
 * now.
 */
export function UpdateBanner({
  state,
  onRestart,
  busy,
  blocked,
  onOpenDownload,
  openFailed = false,
}: {
  state: UpdateState;
  onRestart: () => void;
  busy: boolean;
  /** Restart was asked for while a tunnel was up, and refused. */
  blocked: boolean;
  /** Opens the website's download page, for "available": a build that
   * cannot install its own updates (Linux) only says one exists. */
  onOpenDownload?: () => void;
  /** The download page was asked for and did not open. */
  openFailed?: boolean;
}) {
  const { t } = useI18n();
  if (state.status === "none") return null;

  if (state.status === "available") {
    return (
      <div className="nx-upd" role="status">
        <p className="flex items-center gap-2">
          <Download className="size-4 shrink-0 text-cobalt-ink" aria-hidden />
          <span>{openFailed ? t("update.openFailed") : t("update.available", { version: state.version })}</span>
        </p>
        {onOpenDownload ? (
          <PillButton variant="ghost" size="sm" onClick={onOpenDownload} disabled={busy}>
            {t("update.getIt")}
          </PillButton>
        ) : null}
      </div>
    );
  }

  const downloading = state.status === "downloading";

  return (
    // In the sidebar on a wide window, at the top of the hero on a narrower
    // one (pearl.css decides which copy shows).
    <div className="nx-upd" role="status">
      <p className="flex items-center gap-2">
        {downloading ? (
          <Download className="size-4 shrink-0 text-cobalt-ink" aria-hidden />
        ) : (
          <RefreshCw className="size-4 shrink-0 text-cobalt-ink" aria-hidden />
        )}
        <span>
          {downloading
            ? state.percent === null
              ? t("update.downloading", { version: state.version })
              : t("update.downloadingPercent", { version: state.version, percent: state.percent })
            : blocked
              ? t("update.connectedFirst")
              : t("update.ready", { version: state.version })}
        </span>
      </p>
      {!downloading && (
        <PillButton variant="ghost" size="sm" onClick={onRestart} disabled={busy}>
          {busy ? t("update.restarting") : t("update.restart")}
        </PillButton>
      )}
    </div>
  );
}
