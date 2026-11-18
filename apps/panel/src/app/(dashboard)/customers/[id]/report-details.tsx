import type { ReportDetails, ReportServiceResult } from "@/lib/types";
import { cn } from "@/lib/utils";
import { serviceOutcome } from "./insight-labels";
import {
  addressKindOdd,
  addressKindText,
  dataCheckLegText,
  detailFactGroups,
  egressText,
  msText,
  reconnectText,
  sessionEndText,
  viaText,
  type FactGroup,
} from "./diagnostics-format";

/** What a report's `details` carried (docs/client-diagnostics.md), as
 * labelled facts: only the parts present, nothing filled in. Used in the
 * connection log's open row and in a diagnostics bundle. Renders nothing
 * when there is nothing to show. */
export function ReportDetailsBlock({
  details,
  factsTitle = "Device and network at that moment",
  serviceTitle,
}: {
  details: ReportDetails | null | undefined;
  factsTitle?: string;
  /** Heading of the service results, e.g. "Services checked, through exit-1". */
  serviceTitle?: string;
}) {
  if (!details) return null;
  const groups = detailFactGroups(details);
  const checks: [string, string | null][] = [
    ["Data check, download", dataCheckLegText(details.dataCheck?.down)],
    ["Data check, upload", dataCheckLegText(details.dataCheck?.up)],
    ["Exit check", egressText(details.egress)],
    ["Reconnect", reconnectText(details.reconnect)],
    ["Session ended", sessionEndText(details.sessionEnd)],
    ["App's error kind", details.errorKind ?? null],
  ];
  const present = checks.filter((c): c is [string, string] => c[1] !== null);
  const services = details.services ?? [];

  if (groups.length === 0 && present.length === 0 && services.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {services.length > 0 && (
        <ServiceResults
          services={services}
          title={serviceTitle ?? `Services checked${details.via ? `, ${viaText(details.via)}` : ""}`}
        />
      )}

      {present.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {present.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className={labelClass}>{label}</dt>
              <dd className="text-xs tabular-nums [overflow-wrap:anywhere]">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {groups.length > 0 && <FactGroups title={factsTitle} groups={groups} />}
    </div>
  );
}

const labelClass = "mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase";

/** Labelled facts in groups (Device, Network, VPN settings). */
export function FactGroups({ title, groups }: { title: string; groups: FactGroup[] }) {
  return (
    <div>
      <p className={labelClass}>{title}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((group) => (
          <div key={group.title} className="min-w-0 rounded-md border border-white/8 bg-white/[0.02] px-3 py-2">
            <p className="mb-1 text-xs font-medium">{group.title}</p>
            <dl className="flex flex-col gap-0.5">
              {group.facts.map((fact) => (
                <div key={fact.label} className="flex items-baseline justify-between gap-3 text-xs">
                  <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
                  <dd
                    className={cn(
                      "min-w-0 text-right [overflow-wrap:anywhere]",
                      fact.warn ? "text-amber-300" : "text-foreground/90",
                      /\d+\.\d+\.|:/.test(fact.value) && "font-mono",
                    )}
                  >
                    {fact.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

/** One run's results, a line per service: reachable or how far it got,
 * and the stage times as small aligned numbers. */
export function ServiceResults({ services, title }: { services: ReportServiceResult[]; title: string }) {
  const ok = services.filter((s) => s.ok).length;
  return (
    <div>
      <p className={labelClass}>
        {title}
        <span className={cn("ml-2 normal-case tracking-normal", ok < services.length ? "text-red-300" : "")}>
          {ok} of {services.length} reachable
        </span>
      </p>
      <ul className="flex flex-col divide-y divide-white/5 rounded-md border border-white/8">
        {services.map((s, index) => (
          <li key={`${s.key}-${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-xs sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
            <span className="font-medium">{s.key}</span>
            <span className={cn("text-right sm:text-left", s.ok ? "text-success" : "text-red-300")}>
              {serviceOutcome(s.ok, s.stage)}
              {typeof s.status === "number" && <span className="ml-1.5 text-muted-foreground tabular-nums">HTTP {s.status}</span>}
            </span>
            <span className="col-span-2 text-muted-foreground tabular-nums sm:col-span-1 sm:text-right">
              {[
                ["lookup", s.dnsMs],
                ["connect", s.connectMs],
                ["handshake", s.tlsMs],
                ["first byte", s.firstByteMs],
              ]
                .filter(([, ms]) => typeof ms === "number")
                .map(([name, ms]) => `${name} ${msText(ms as number)}`)
                .join(" · ") || "no times"}
              {s.addressKind && (
                <span className={cn("ml-2", addressKindOdd(s.addressKind) && "text-amber-300")}>
                  resolved to {addressKindText(s.addressKind)}
                </span>
              )}
            </span>
            {s.error && (
              <span className="col-span-full font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                {s.error}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
