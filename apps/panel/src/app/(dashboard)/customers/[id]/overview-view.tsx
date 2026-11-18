import Link from "next/link";
import { CheckCircle2, Mail, Users } from "lucide-react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubscriptionsPanel } from "./subscriptions-panel";
import { MoveAddressCard } from "./move-address-card";
import { RightNowCard } from "./right-now-card";
import { DevicesCard } from "./devices-card";
import { Muted, NetworkLabel, Section, When, orNull } from "./view-parts";

/** The first view: who this is, what stands out, whether they are on
 * now, and the account's subscriptions, devices and invoices -- the
 * sections the page has always had, plus the insight's observations. */
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
      <div className="grid gap-4 md:grid-cols-3">
        <Fact icon={<Mail className="size-4" />} label="Telegram" value={customer.telegramId ?? "—"} />
        <Fact icon={<Users className="size-4" />} label="Referral code" value={customer.referralCode ?? "—"} mono />
        <Fact
          icon={<CheckCircle2 className="size-4" />}
          label="Verified"
          value={customer.emailVerifiedAt ? new Date(customer.emailVerifiedAt).toLocaleDateString() : "Never"}
        />
      </div>

      <FindingsCard insight={insight} days={days} />

      {/* "Why can't they connect" is most of why this page is opened, and
          whether they are on right now is the first half of the answer. */}
      <RightNowCard now={activity?.now ?? null} />

      <AtAGlance insight={insight} days={days} />

      <SubscriptionsPanel
        customerId={id}
        subscriptions={subscriptions}
        plans={plans}
        credentials={insight ? insight.credentials : null}
      />

      {insight === null ? null : insight.vouchers.length > 0 && <VouchersCard vouchers={insight.vouchers} />}

      {/* Signing a device out is SUPERADMIN or SUPPORT on the backend, so
          nobody else is shown a button that would only answer 403. */}
      <DevicesCard customerId={id} devices={activity?.devices ?? null} canSignOut={canSupport} />

      {customer.recoveryCodeSetAt && <MoveAddressCard customerId={id} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Invoices
            {invoices.total > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground tabular-nums">
                {invoices.total.toLocaleString()}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {invoices.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing billed yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {invoices.items.map((invoice) => (
                <div
                  key={invoice.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-card/40 px-3 py-2"
                >
                  <span className="font-mono text-xs">{invoice.invoiceNumber}</span>
                  <span className="text-sm">${invoice.amountUsd}</span>
                  <Badge variant={invoice.status === "PAID" ? "outline" : "default"}>{invoice.status}</Badge>
                </div>
              ))}
            </div>
          )}
          <Pager total={invoices.total} take={invoiceTake} skip={invoiceSkip} basePath={`/customers/${id}`} />
        </CardContent>
      </Card>
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
 * from, never a guessed cause -- the backend words them that way. */
function FindingsCard({ insight, days }: { insight: CustomerInsight | null; days: number }) {
  if (insight === null) {
    return (
      <Section title="What we see">
        <Muted>Could not load this customer&apos;s reports, so nothing can be said about them.</Muted>
      </Section>
    );
  }
  const findings = [...insight.findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <Section title="What we see" note={`last ${windowText(days)}`}>
      {findings.length === 0 ? (
        <Muted>Nothing stands out in the last {windowText(days)}.</Muted>
      ) : (
        <ul className="flex flex-col gap-2">
          {findings.map((finding, index) => {
            const tone = SEVERITY[finding.severity] ?? SEVERITY.info;
            return (
              <li key={`${finding.code}-${index}`} className={cn("rounded-lg border px-3.5 py-2.5", tone.className)}>
                <p className="flex items-center gap-2 text-sm font-medium">
                  <span className={cn("size-2 shrink-0 rounded-full", tone.dot)} aria-hidden="true" />
                  <span className="sr-only">{tone.label}: </span>
                  {finding.title}
                </p>
                <p className="mt-0.5 pl-4 text-xs text-muted-foreground">{finding.detail}</p>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function AtAGlance({ insight, days }: { insight: CustomerInsight | null; days: number }) {
  if (insight === null) {
    return (
      <Section title="At a glance">
        <Muted>Could not load this customer&apos;s reports.</Muted>
      </Section>
    );
  }
  const { connect, sessions, apps } = insight;
  const failureOutcome = connect.lastFailure
    ? (OUTCOMES[connect.lastFailure.outcome as ClientAttemptOutcome]?.label ?? connect.lastFailure.outcome)
    : null;

  return (
    <Section title="At a glance" note={`last ${windowText(days)}`}>
      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Item label="Connection attempts">
          {connect.tried === 0 ? (
            <span className="text-muted-foreground">None reported</span>
          ) : (
            <span className="tabular-nums">
              {connect.succeeded} of {connect.tried} succeeded
            </span>
          )}
        </Item>

        <Item label="Sessions the apps reported">
          {sessions.count === 0 ? (
            <span className="text-muted-foreground">None reported</span>
          ) : (
            <span>
              {sessions.count} {sessions.count === 1 ? "session" : "sessions"}, longest {duration(sessions.longestSeconds)}
              <span className="ml-1.5 text-xs text-muted-foreground">{duration(sessions.totalSeconds)} in all</span>
            </span>
          )}
        </Item>

        <Item label="Last success">
          {connect.lastSuccess ? (
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <When at={connect.lastSuccess.at} />
              <span className="text-muted-foreground">on</span>
              <span>{connect.lastSuccess.server ?? "unknown server"}</span>
              <span className="text-muted-foreground">{protocolLabel(connect.lastSuccess.protocol)}</span>
              <span className="text-xs">
                <NetworkLabel network={connect.lastSuccess.network} />
              </span>
              <span className="text-xs text-muted-foreground">
                {connect.lastSuccess.platform} {connect.lastSuccess.appVersion}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">None in the last {windowText(days)}</span>
          )}
        </Item>

        <Item label="Last failure">
          {connect.lastFailure ? (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
              <When at={connect.lastFailure.at} />
              <span>{failureOutcome}</span>
              {connect.lastFailure.reason && (
                <span
                  className="max-w-full truncate font-mono text-xs text-muted-foreground"
                  title={connect.lastFailure.reason}
                >
                  {connect.lastFailure.reason}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">None in the last {windowText(days)}</span>
          )}
        </Item>
      </div>

      <Item label="Apps">
        {apps.length === 0 ? (
          <span className="text-muted-foreground">No app has reported</span>
        ) : (
          <ul className="flex flex-col gap-1">
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
              </li>
            ))}
          </ul>
        )}
      </Item>
    </Section>
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

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 text-sm">
      <p className="mb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      {children}
    </div>
  );
}

function Fact({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-white/8 bg-card/40 px-3.5 py-3">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className={`truncate text-sm ${mono ? "font-mono" : ""}`}>{value}</p>
      </div>
    </div>
  );
}

/** "24 hours" for one day, "7 days" otherwise. */
export function windowText(days: number): string {
  return days === 1 ? "24 hours" : `${days} days`;
}
