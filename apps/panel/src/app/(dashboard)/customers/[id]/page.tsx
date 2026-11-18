import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Customer } from "@/lib/types";
import { pageWindow } from "@/components/dashboard/pager";
import { Badge } from "@/components/ui/badge";
import { MarkVerifiedButton } from "./mark-verified-button";
import { OverviewView } from "./overview-view";
import { ConnectionsView } from "./connections-view";
import { UsageView } from "./usage-view";
import { HistoryView } from "./history-view";
import { DiagnosticsView } from "./diagnostics-view";
import { parseReference } from "./diagnostics-format";
import { parseAttemptFilters, parseDays, parseHours, parseView } from "./insight-format";
import { ViewTabs } from "./view-parts";

/** Everything about one customer, in one place.
 *
 * The list view answers "who exists"; this answers "what is going on
 * with this person" -- which is the question actually being asked when
 * somebody writes in. Until now the panel could only edit an email
 * address and delete an account: a subscription could not be suspended,
 * extended or even seen, so every real support action meant going to
 * the database by hand.
 */
export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  // view picks one of four views, and only that view's data is read.
  // take/skip page whichever list the view has: invoices on the overview,
  // the log on Connections, events on History, bundles on Diagnostics
  // (whose ref opens one bundle). days and hours are the
  // report and usage windows; the rest are the log's filters.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireStaff();
  const { id } = await params;
  const query = await searchParams;
  const one = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const view = parseView(one("view"));
  const days = parseDays(one("days"));
  const hours = parseHours(one("hours"));
  const paging = { take: one("take"), skip: one("skip") };

  const customer = await apiFetch<Customer>(`/customers/${id}`).catch(() => null);
  if (!customer) notFound();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            href="/customers"
            className="mt-0.5 flex size-8 shrink-0 items-center max-lg:size-10 justify-center rounded-lg border border-white/10 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            aria-label="Back to customers"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold [overflow-wrap:anywhere]">{customer.email}</h1>
            <p className="text-sm text-muted-foreground">
              Joined {new Date(customer.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={customer.status === "ACTIVE" ? "default" : "outline"}>
            {customer.status}
          </Badge>
          {/* Whether they ever confirmed their address is the first thing
              worth knowing when someone says the app will not let them
              in -- an unverified account is gated by design. */}
          <Badge variant={customer.emailVerifiedAt ? "outline" : "destructive"}>
            {customer.emailVerifiedAt ? "Email verified" : "Email unverified"}
          </Badge>
          {/* For the customer whose code never arrived. The backend allows
              SUPERADMIN and SUPPORT, so nobody else is shown a button that
              would only answer 403. */}
          {!customer.emailVerifiedAt && (admin.role === "SUPERADMIN" || admin.role === "SUPPORT") && (
            <MarkVerifiedButton customerId={id} email={customer.email} />
          )}
          {/* Made through the Iranian relay without verification: limited
              to Ultimate vouchers until the address is confirmed. */}
          {customer.signupChannel === "RELAY" && <Badge variant="outline">Relay sign-up</Badge>}
          {customer.recoveryCodeSetAt && <Badge variant="outline">Recovery code</Badge>}
        </div>
      </div>

      <ViewTabs customerId={id} current={view} keep={{ days, hours }} />

      {view === "overview" && (
        <OverviewView
          customer={customer}
          canSupport={admin.role === "SUPERADMIN" || admin.role === "SUPPORT"}
          days={days}
          {...invoiceWindow(pageWindow(paging, 20))}
        />
      )}
      {view === "connections" && (
        <ConnectionsView customerId={id} days={days} filters={parseAttemptFilters(query)} {...pageWindow(paging, 50, 200)} />
      )}
      {view === "usage" && <UsageView customerId={id} hours={hours} />}
      {view === "history" && <HistoryView customerId={id} {...pageWindow(paging, 50, 200)} />}
      {view === "diagnostics" && (
        <DiagnosticsView customerId={id} reference={parseReference(one("ref"))} {...pageWindow(paging, 20, 50)} />
      )}
    </div>
  );
}

/** The invoice card's window: 20 rather than the API's default 100, as
 * it is a card inside a page, not a table that owns the screen. */
function invoiceWindow({ take, skip }: { take: number; skip: number }) {
  return { invoiceTake: take, invoiceSkip: skip };
}
