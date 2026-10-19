import type { ReactNode } from "react";
import { ArrowLeftRight, ChevronRight } from "lucide-react";
import { useI18n } from "../../lib/i18n";
import type { IpModel } from "../../lib/hero-model";
import { cn } from "../../lib/utils";
import { Glass } from "../ui";

/** The bottom tray: where the traffic goes, what the plan has left, and the
 * address the world sees. Real data only -- there is no speed section,
 * because no engine on this platform reports byte counters yet, and a
 * number that was not measured is not shown (design-system.md, 4.9).
 *
 * Wide windows draw it as one strong-glass strip; medium and phone layouts
 * show the location as its own card and the other two as metric cards. */

export interface TrayLocation {
  /** The flag, a relay's double flag, or Automatic's sparkle. */
  flag: ReactNode;
  name: string;
  sub?: string | null;
  /** Opens the list; absent where there is nothing to change (gaming). */
  onChange?: () => void;
}

export interface TrayPlan {
  label: string;
  /** The figure, with its unit set small. */
  value: ReactNode;
  /** A capped plan's share used, 0..1. */
  meter?: { fraction: number; caution: boolean } | null;
  days?: { text: string; caution: boolean } | null;
  /** Renew, or Plans on a store build; absent while offline. */
  renew?: { label: string; onClick: () => void } | null;
}

function IpValue({ ip }: { ip: IpModel }) {
  const { t } = useI18n();
  if (ip.kind === "ip") {
    // Where the address came from: only ever shown for a verified tunnel
    // (`ipFor`), whose check asked through it.
    return (
      <>
        <span className="nx-tval nx-ipv nx-ltr" dir="ltr">
          {ip.ip}
        </span>
        <span className="nx-tsub">{t("tr.ipChecked")}</span>
      </>
    );
  }
  if (ip.kind === "none") return <span className="nx-tval quiet">—</span>;
  return <span className="nx-tval quiet">{t(ip.key)}</span>;
}

function PlanBody({ plan }: { plan: TrayPlan }) {
  return (
    <>
      <span className="nx-tlabel">{plan.label}</span>
      <span className="nx-tval">{plan.value}</span>
      {plan.meter ? (
        <div className={cn("nx-meter", plan.meter.caution && "caution")} aria-hidden>
          <i style={{ width: `${Math.max(1.5, Math.min(100, plan.meter.fraction * 100))}%` }} />
        </div>
      ) : null}
      {plan.days || plan.renew ? (
        plan.renew ? (
          <button type="button" className={cn("nx-tlink", plan.days?.caution && "caution")} onClick={plan.renew.onClick}>
            {plan.days ? `${plan.days.text} · ` : ""}
            {plan.renew.label}
            <ChevronRight className="nx-mir size-3.5" aria-hidden />
          </button>
        ) : (
          <span className={cn("nx-tsub", plan.days?.caution && "text-warn-ink")}>{plan.days?.text}</span>
        )
      ) : null}
    </>
  );
}

export function SessionTray({ location, plan, ip, label }: { location: TrayLocation; plan: TrayPlan | null; ip: IpModel; label: string }) {
  const { t } = useI18n();
  return (
    <Glass as="section" strong className="nx-tray" aria-label={label}>
      <div className="nx-tsec nx-tloc">
        <span className="nx-flagbox">{location.flag}</span>
        <div className="t">
          <span className="n">{location.name}</span>
          {location.sub ? <span className="s">{location.sub}</span> : null}
        </div>
        {location.onChange ? (
          <button type="button" className="nx-ibtn" onClick={location.onChange} aria-label={t("tr.change")} title={t("tr.change")}>
            <ArrowLeftRight aria-hidden />
          </button>
        ) : null}
      </div>
      <div className="nx-tsec">
        <div className="t">{plan ? <PlanBody plan={plan} /> : <span className="nx-tval quiet">{t("tr.noPlan")}</span>}</div>
      </div>
      <div className="nx-tsec">
        <div className="t">
          <span className="nx-tlabel">{t("tr.ip")}</span>
          <IpValue ip={ip} />
        </div>
      </div>
    </Glass>
  );
}

/** Medium and phone layouts: the location as a card of its own. */
export function LocationCard({ location }: { location: TrayLocation }) {
  const { t } = useI18n();
  const body = (
    <>
      <span className="nx-flagbox">{location.flag}</span>
      <span className="t">
        <span className="n">{location.name}</span>
        {location.sub ? <span className="s">{location.sub}</span> : null}
      </span>
      {location.onChange ? <ChevronRight className="nx-mir size-5 text-ink-2" aria-hidden /> : null}
    </>
  );
  return location.onChange ? (
    <button type="button" className="nx-glass strong nx-hloc" onClick={location.onChange} aria-label={`${t("tr.change")}: ${location.name}`}>
      {body}
    </button>
  ) : (
    <div className="nx-glass strong nx-hloc">{body}</div>
  );
}

/** Phones: the plan and the address on one line, the press that opens the
 * sheet holding the cards below (MainView). The address only once a
 * verified tunnel's check returned it (`ipFor`); otherwise the line says
 * nothing about it rather than something vaguer.
 *
 * Whole pieces or none (pearl.css): a piece that does not fit the line is
 * left to the sheet -- the address first, then the days left -- and none
 * is ever cut with an ellipsis. */
export function SummaryLine({ plan, ip }: { plan: TrayPlan | null; ip: IpModel }) {
  const { t } = useI18n();
  return (
    <span className="nx-sum">
      {plan ? (
        <>
          <span className="v">{plan.value}</span>
          {plan.days ? <span className={cn("d", plan.days.caution && "caution")}>{plan.days.text}</span> : null}
        </>
      ) : (
        <span className="v">{t("tr.noPlan")}</span>
      )}
      {ip.kind === "ip" ? (
        <span className="ip nx-ltr" dir="ltr">
          {ip.ip}
        </span>
      ) : null}
    </span>
  );
}

/** Medium and phone layouts: the plan and the address as two solid cards. */
export function MetricCards({ plan, ip }: { plan: TrayPlan | null; ip: IpModel }) {
  const { t } = useI18n();
  return (
    <div className="nx-hmet">
      <div className="nx-card">{plan ? <PlanBody plan={plan} /> : <span className="nx-tval quiet">{t("tr.noPlan")}</span>}</div>
      <div className="nx-card">
        <span className="nx-tlabel">{t("tr.ip")}</span>
        <IpValue ip={ip} />
      </div>
    </div>
  );
}
