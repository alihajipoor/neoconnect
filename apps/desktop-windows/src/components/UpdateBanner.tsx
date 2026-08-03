import { Download, RefreshCw } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { Button } from "./ui";
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
}: {
  state: UpdateState;
  onRestart: () => void;
  busy: boolean;
  /** Restart was asked for while a tunnel was up, and refused. */
  blocked: boolean;
}) {
  const { t } = useI18n();
  if (state.status === "none") return null;

  const downloading = state.status === "downloading";

  return (
    <div className="flex items-center gap-2.5 border-b border-white/8 bg-primary/10 px-4 py-2">
      {downloading ? (
        <Download className="size-3.5 shrink-0 animate-pulse text-primary" />
      ) : (
        <RefreshCw className="size-3.5 shrink-0 text-primary" />
      )}
      <p className="min-w-0 flex-1 truncate text-xs">
        {downloading
          ? state.percent === null
            ? t("update.downloading", { version: state.version })
            : t("update.downloadingPercent", { version: state.version, percent: state.percent })
          : blocked
            ? t("update.connectedFirst")
            : t("update.ready", { version: state.version })}
      </p>
      {!downloading && (
        <Button
          variant="ghost"
          onClick={onRestart}
          disabled={busy}
          className="h-7 shrink-0 border border-white/10 px-2.5 text-xs"
        >
          {busy ? t("update.restarting") : t("update.restart")}
        </Button>
      )}
    </div>
  );
}
