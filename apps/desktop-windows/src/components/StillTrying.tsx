import { useI18n } from "../lib/i18n";
import { useStillTrying } from "../lib/still-trying";
import { cn } from "../lib/utils";

/** The line a screen shows under a wait on Neoxify that has passed eight
 * seconds (`useStillTrying`): it is still trying, and nothing more.
 *
 * One component for the screens that only need the line where they are,
 * so each wait gets it without repeating the hook and the wording. Reads
 * now wait up to twenty seconds an address, and a write first asks who
 * answers, so a confirm, a reset, a voucher or a plan list can sit for
 * half a minute on a network where only a slow route answers. Silent, that
 * reads as frozen, and a frozen app is closed and opened again -- which
 * starts the wait from nothing. */
export function StillTrying({ waiting, className }: { waiting: boolean; className?: string }) {
  const { t } = useI18n();
  const long = useStillTrying(waiting);
  if (!long) return null;
  return (
    <p role="status" className={cn("text-center text-xs text-muted-foreground", className)}>
      {t("common.stillTrying")}
    </p>
  );
}
