import { MonitorSmartphone } from "lucide-react";
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
    <Card className="ring-brand animate-rise flex w-full flex-col gap-2 text-center">
      <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-primary/15 text-primary">
        <MonitorSmartphone className="size-4" />
      </div>
      {copy.lines.map((line, i) => (
        <p key={i} className={i === 0 ? "text-sm font-semibold text-pretty" : "text-xs text-pretty text-muted-foreground"}>
          {line}
        </p>
      ))}
      <div className="mt-1 flex flex-col gap-2">
        {copy.useHere ? (
          <Button onClick={() => onUseHere(copy.useHere?.takeover ?? [])} className="w-full justify-center">
            {copy.useHere.label}
          </Button>
        ) : null}
        {copy.dismiss ? (
          <Button variant="ghost" onClick={onDismiss} className="w-full justify-center">
            {copy.dismiss}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
