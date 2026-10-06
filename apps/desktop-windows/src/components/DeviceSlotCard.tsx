import { Button, Card } from "./ui";
import { useI18n } from "../lib/i18n";
import { describeSlotNotice, type SlotNotice } from "../lib/device-slot-notice";

/** Where Neoxify is in use, when the plan's device limit is the reason
 * this device is not connected.
 *
 * Modelled on the plan-ended card: one fact, said plainly, and the one
 * thing the customer can do about it. A refusal is the plan working as
 * sold, so it is not styled as an error. The wording lives in
 * `describeSlotNotice`, shared with the mobile client.
 *
 * Says nothing about the tunnel itself beyond what `tunnelDown` -- the
 * service's own answer -- allows: "Disconnected:" only once it is.
 */
export function DeviceSlotCard({
  notice,
  tunnelDown,
  onUseHere,
  onDismiss,
}: {
  notice: SlotNotice;
  tunnelDown: boolean;
  onUseHere: (takeover: string[]) => void;
  onDismiss: () => void;
}) {
  const { t, language } = useI18n();
  const copy = describeSlotNotice(notice, { t, language, tunnelDown });

  // A note rather than a choice: one line, in the error line's place.
  if (!copy.useHere && !copy.dismiss) {
    return <p className="text-xs text-pretty text-muted-foreground">{copy.lines.join(" ")}</p>;
  }

  return (
    // Compact on purpose: it shares a fixed 400x640 window with the orb,
    // the tiles and the usage card, and nothing on that screen scrolls.
    // The buttons sit side by side for the same reason.
    <Card className="ring-brand animate-rise flex w-full flex-col gap-1.5 text-center">
      {copy.lines.map((line, i) => (
        <p key={i} className={i === 0 ? "text-sm font-semibold text-pretty" : "text-xs text-pretty text-muted-foreground"}>
          {line}
        </p>
      ))}
      <div className="mt-1.5 flex justify-center gap-2">
        {copy.dismiss ? (
          <Button variant="ghost" onClick={onDismiss} className="shrink-0 justify-center px-3">
            {copy.dismiss}
          </Button>
        ) : null}
        {copy.useHere ? (
          <Button onClick={() => onUseHere(copy.useHere?.takeover ?? [])} className="flex-1 justify-center px-3">
            {copy.useHere.label}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
