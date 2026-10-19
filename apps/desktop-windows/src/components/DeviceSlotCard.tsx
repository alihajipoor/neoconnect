import { PillButton } from "./ui";
import { useI18n } from "../lib/i18n";
import { describeSlotNotice, slotNoticeShown, type SlotNotice } from "../lib/device-slot-notice";

/** Where Neoxify is in use, when the plan's device limit is the reason
 * this device is not connected.
 *
 * Modelled on the plan-ended card: one fact, said plainly, and the one
 * thing the customer can do about it. A refusal is the plan working as
 * sold, so it is not styled as an error. The wording lives in
 * `describeSlotNotice`, shared with the mobile client.
 *
 * Says nothing about the tunnel itself beyond what `tunnelDown` -- the
 * service's own answer -- allows: "Disconnected:" only once it is, and a
 * refusal, with its "Use on this device instead", not until then at all
 * (`slotNoticeShown`).
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
  if (!slotNoticeShown(notice, tunnelDown)) return null;
  const copy = describeSlotNotice(notice, { t, language, tunnelDown });

  // A note rather than a choice: one line, in the sentence's place.
  if (!copy.useHere && !copy.dismiss) return <p className="nx-hint">{copy.lines.join(" ")}</p>;
  // The main page's: the hint's place, a bold lead, and the pill buttons.
  return (
    <div className="nx-slot" role="status">
      {copy.lines.map((line, i) => (
        <p key={i} className={i === 0 ? "lead" : undefined}>
          {line}
        </p>
      ))}
      <div className="nx-actions">
        {copy.useHere ? (
          <PillButton size="sm" onClick={() => onUseHere(copy.useHere?.takeover ?? [])}>
            {copy.useHere.label}
          </PillButton>
        ) : null}
        {copy.dismiss ? (
          <PillButton variant="ghost" size="sm" onClick={onDismiss}>
            {copy.dismiss}
          </PillButton>
        ) : null}
      </div>
    </div>
  );
}
