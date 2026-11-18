import Link from "next/link";
import { ArrowRight, CheckCircle2, Mail, Users } from "lucide-react";
import { apiFetch, apiFetchList } from "@/lib/api";
import type {
  ClientAttemptOutcome,
  Customer,
  CustomerActivity,
  CustomerInsight,
  InsightFinding,
  InsightVoucher,
  InvoiceListRow,
  Subscription,
  SubscriptionPlan,
} from "@/lib/types";
import { OUTCOMES } from "@/lib/attempt-labels";
import { protocolLabel } from "@/lib/protocol-labels";
import { duration } from "@/lib/time";
import { cn } from "@/lib/utils";
import { Pager } from "@/components/dashboard/pager";
import { Badge } from "@/components/ui/badge";
import { SubscriptionsPanel } from "./subscriptions-panel";
import { MoveAddressCard } from "./move-address-card";
import { RightNow } from "./right-now-card";
import { DevicesCard } from "./devices-card";
import { FoldedText, Muted, NetworkLabel, Section, StatTile, Tiles, When, orNull } from "./view-parts";
import { customerHref, pageParams } from "./insight-format";
import { findingFilters } from "./insight-layout";

/** The first view: what stands out, whether they are on now, and the
 * account's subscriptions, devices and invoices -- the sections the page
 * has always had, plus the insight's observations. */
export async function OverviewView({
  customer,
  canSupport,
  days,
  invoiceTake,
  invoiceSkip,
}: {
  customer: Customer;
  /** SUPERADMIN or SUPPORT: may sign devices out. */
  canSupport: boolean;
  days: number;
  invoiceTake: number;
  invoiceSkip: number;
}) {
  const id = customer.id;
  const invoiceQuery = new URLSearchParams({ customerId: id, take: String(invoiceTake) });
  if (invoiceSkip > 0) invoiceQuery.set("skip", String(invoiceSkip));

  // Fetched together: serially awaiting independent requests just makes
  // the page slower.
  const [subscriptions, plans, invoices, activity, insight] = await Promise.all([
    apiFetch<Subscription[]>(`/subscriptions?customerId=${encodeURIComponent(id)}`).catch(() => []),
    apiFetch<SubscriptionPlan[]>("/plans").catch(() => []),
    apiFetchList<InvoiceListRow>(`/invoices?${invoiceQuery.toString()}`).catch(() => ({ items: [], total: 0 })),
    // Null on failure, and each section says "could not load" for it: an
    // empty list would read as "never connected" and "no devices", which
    // are claims, not gaps. The connection log is on the Connections view
    // now, so only the newest attempt is asked for.
    orNull(apiFetch<CustomerActivity>(`/customers/${encodeURIComponent(id)}/activity?attemptsTake=1`)),
    orNull(apiFetch<CustomerInsight>(`/customers/${encodeURIComponent(id)}/insight?days=${days}`)),
  ]);

  return (
    <>
      <FindingsCard insight={insight} customerId={id} days={days} />

      {/* "Why can't they connect" is most of why this page is opened, and
          whether they are on right now is the first half of the answer;
          the window's counts are the second, in the same card. */}
      <Section title="Right now">
        <RightNow now={activity?.now ?? null} />
        <div className="mt-2 flex items-baseline gap-2 border-t border-white/8 pt-4">
          <h3 className="text-sm font-semibold">At a glance</h3>
          <span className="text-sm text-muted-foreground">last {windowText(days)}</span>
        </div>
        <AtAGlance insight={insight} customerId={id} days={days} />
      </Section>

      <div className="grid grid-cols-3 gap-3">
        <Fact icon={<Mail className="size-4" />} label="Telegram" value={customer.telegramId ?? "—"} />
        <Fact icon={<Users className="size-4" />} label="Referral code" value={customer.referralCode ?? "—"} mono />
        <Fact
          icon={<CheckCircle2 className="size-4" />}
          label="Verified"
          value={customer.emailVerifiedAt ? new Date(customer.emailVerifiedAt).toLocaleDateString() : "Never"}
        />
      </div>

      <SubscriptionsPanel
        customerId={id}
        subscriptions={subscriptions}
        plans={plans}
        credentials={insight ? insight.credentials : null}
      />

      {insight === null ? null : insight.vouchers.length > 0 && <VouchersCard vouchers={insight.vouchers} />}

      {/* Signing a device out is SUPERADMIN or SUPPORT on the backend, so
          nobody else is shown a button that would only answer 403. */}
      <DevicesCard
        customerId={id}
        devices={activity?.devices ?? null}
        canSignOut={canSupport}
        facts={insight ? (insight.deviceFacts ?? []) : null}
      />

      {customer.recoveryCodeSetAt && <MoveAddressCard customerId={id} />}

      <Section title="Invoices" note={invoices.total > 0 ? invoices.total.toLocaleString() : undefined}>
        {invoices.items.length === 0 ? (
          <Muted>Nothing billed yet.</Muted>
        ) : (
          <div className="flex flex-col gap-1.5">
            {invoices.items.map((invoice) => (
              <div
                key={invoice.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-card/40 px-3 py-2"
              >
                <span className="min-w-0 truncate font-mono text-xs">{invoice.invoiceNumber}</span>
                <span className="ml-auto text-sm tabular-nums">${invoice.amountUsd}</span>
                <Badge variant={invoice.status === "PAID" ? "outline" : "default"}>{invoice.status}</Badge>
              </div>
            ))}
          </div>
        )}
        <Pager
          total={invoices.total}
          take={invoiceTake}
          skip={invoiceSkip}
          basePath={`/customers/${id}`}
          params={pageParams({ days })}
        />
      </Section>
    </>
  );
}

const SEVERITY: Record<InsightFinding["severity"], { label: string; className: string; dot: string }> = {
  problem: { label: "Problem", className: "border-destructive/40 bg-destructive/10", dot: "bg-red-400" },
  warning: { label: "Warning", className: "border-amber-500/30 bg-amber-500/5", dot: "bg-amber-400" },
  info: { label: "Note", className: "border-white/8 bg-card/40", dot: "bg-muted-foreground/60" },
};
const SEVERITY_ORDER = { problem: 0, warning: 1, info: 2 } as const;

/** The insight's observations. Each is a count and what it was counted
 * from, never a guessed cause -- the backend words them that way. Where
 * one is about reports, it links to the log filtered to those reports. */
function FindingsCard({
  insight,
  customerId,
  days,
}: {
  insight: CustomerInsight | null;
  customerId: string;
  days: number;
}) {
  if (insight === null) {
    return (
      <Section title="What we see">
        <Muted>Could not load this customer&apos;s reports, so nothing can be said about them.</Muted>
      </Section>
    );
  }
  const findings = [...insight.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const problems = findings.filter((f) => f.severity === "problem").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  return (
    <Section
      title="What we see"
      note={`last ${windowText(days)}`}
      aside={
        <>
          {problems > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-medium text-red-300 tabular-nums">
              {problems} {problems === 1 ? "problem" : "problems"}
            </span>
          )}
          {warnings > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/5 px-2 py-0.5 font-medium text-amber-300 tabular-nums">
              {warnings} {warnings === 1 ? "warning" : "warnings"}
            </span>
          )}
        </>
      }
    >
      {findings.length === 0 ? (
        <Muted>Nothing stands out in the last {windowText(days)}.</Muted>
      ) : (
        <ul className="flex flex-col gap-2">
          {findings.map((finding, index) => {
            const tone = SEVERITY[finding.severity] ?? SEVERITY.info;
            const filters = findingFilters(finding);
            return (
              <li key={`${finding.code}-${index}`} className={cn("rounded-lg border px-3.5 py-2.5", tone.className)}>
                <p className="flex items-start gap-2 text-sm font-medium">
                  <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
                  <span className="sr-only">{tone.label}: </span>
                  {finding.title}
                </p>
                <p className="mt-0.5 pl-4 text-xs text-muted-foreground [overflow-wrap:anywhere]">{finding.detail}</p>
                {filters && (
                  <Link
                    href={customerHref(customerId, { view: "connections", days, ...filters })}
                    className="-mb-1.5 ml-4 inline-flex min-h-8 items-center gap-1 text-xs font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline max-lg:min-h-10"
                  >
                    Show the reports
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function AtAGlance({ insight, customerId, days }: { insight: CustomerInsight | null; customerId: string; days: number }) {
  if (insight === null) {
    return <Muted>Could not load this customer&apos;s reports.</Muted>;
  }
  const { connect, sessions, apps } = insight;
  const failureOutcome = connect.lastFailure
    ? (OUTCOMES[connect.lastFailure.outcome as ClientAttemptOutcome]?.label ?? connect.lastFailure.outcome)
    : null;

  return (
    <Tiles>
      <StatTile
        label="Connection attempts"
        value={connect.tried === 0 ? <span className="text-muted-foreground">None reported</span> : `${connect.succeeded} of ${connect.tried}`}
        sub={connect.tried === 0 ? undefined : "succeeded"}
        tone={connect.tried > 0 && connect.succeeded === 0 ? "problem" : "neutral"}
        bar={connect.tried > 0 ? { part: connect.succeeded, whole: connect.tried } : undefined}
      />

      <StatTile
        label="Sessions the apps reported"
        value={sessions.count === 0 ? <span className="text-muted-foreground">None reported</span> : sessions.count}
        sub={
          sessions.count === 0
            ? undefined
            : `longest ${duration(sessions.longestSeconds)}, ${duration(sessions.totalSeconds)} in all`
        }
      />

      <StatTile
        label="Last success"
        value={
          connect.lastSuccess ? (
            <When at={connect.lastSuccess.at} />
          ) : (
            <span className="text-base text-muted-foreground">None in the last {windowText(days)}</span>
          )
        }
        sub={
          connect.lastSuccess && (
            <span className="flex flex-col gap-0.5">
              <span>
                <span className="text-foreground/90">{connect.lastSuccess.server ?? "unknown server"}</span>{" "}
                {protocolLabel(connect.lastSuccess.protocol)}
              </span>
              <NetworkLabel network={connect.lastSuccess.network} />
              <span>
                {connect.lastSuccess.platform} {connect.lastSuccess.appVersion}
              </span>
            </span>
          )
        }
      />

      <StatTile
        label="Last failure"
        value={
          connect.lastFailure ? (
            <When at={connect.lastFailure.at} />
          ) : (
            <span className="text-base text-muted-foreground">None in the last {windowText(days)}</span>
          )
        }
        sub={
          connect.lastFailure && (
            <span className="flex flex-col gap-0.5">
              <span className="text-foreground/90">{failureOutcome}</span>
              {connect.lastFailure.reason && (
                <FoldedText text={connect.lastFailure.reason} className="font-mono" />
              )}
            </span>
          )
        }
      />

      <StatTile
        wide
        label="Apps"
        value={apps.length === 0 ? <span className="text-base text-muted-foreground">No app has reported</span> : null}
      >
        {apps.length > 0 && (
          <ul className="flex flex-col gap-1.5 text-sm">
            {apps.map((app) => (
              <li key={`${app.platform}-${app.appVersion}`} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{app.platform}</span>
                <span className="tabular-nums">{app.appVersion}</span>
                <span className="text-xs text-muted-foreground">
                  seen <When at={app.lastSeenAt} />
                </span>
                {app.behind === true && app.latestVersion && (
                  <span className="text-xs text-amber-300">update available: {app.latestVersion}</span>
                )}
                <Link
                  href={customerHref(customerId, { view: "connections", days, platform: app.platform })}
                  className="ml-auto inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-lg:min-h-10"
                >
                  Reports
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </StatTile>
    </Tiles>
  );
}

/** Codes and who issued them. The redeeming account is linked when it is
 * somebody else's, by page only -- its email stays on its own page. */
function VouchersCard({ vouchers }: { vouchers: InsightVoucher[] }) {
  return (
    <Section title="Codes">
      <ul className="flex flex-col gap-2">
        {vouchers.map((voucher) => (
          <li key={voucher.voucherId} className="rounded-lg border border-white/8 bg-card/40 px-3.5 py-2.5 text-sm">
            <p>
              <span className="font-medium">{voucher.planName}</span>
              <span className="ml-2 text-xs text-muted-foreground">
                issued <When at={voucher.issuedAt} /> by {voucher.issuedByEmail ?? "an unknown issuer"}
                {voucher.issuedToThisEmail && ", for this customer's email"}
              </span>
            </p>
            {voucher.redemptions.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground">Not redeemed yet.</p>
            ) : (
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {voucher.redemptions.map((r) => (
                  <li key={`${r.customerId}-${r.redeemedAt}`} className="text-xs text-muted-foreground">
                    Redeemed <When at={r.redeemedAt} />{" "}
                    {r.sameAccount ? (
                      "by this account"
                    ) : (
                      <>
                        by{" "}
                        <Link href={`/customers/${r.customerId}`} className="underline hover:text-foreground">
                          another account
                        </Link>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {voucher.maxRedemptions !== null && (
              <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                {voucher.redeemedCount} of {voucher.maxRedemptions} uses taken
              </p>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Fact({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg border border-white/8 bg-card/40 px-3.5 py-3 max-sm:px-3 max-sm:py-2.5">
      <span className="text-muted-foreground max-sm:hidden">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] leading-tight tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className={cn("truncate text-sm", mono && "font-mono")} title={value}>
          {value}
        </p>
      </div>
    </div>
  );
}

/** "24 hours" for one day, "7 days" otherwise. */
export function windowText(days: number): string {
  return days === 1 ? "24 hours" : `${days} days`;
}
