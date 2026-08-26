import Link from "next/link";
import { requireStaff } from "@/lib/session";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Mail, Users } from "lucide-react";
import { apiFetch, apiFetchList } from "@/lib/api";
import type { Customer, InvoiceListRow, Subscription, SubscriptionPlan } from "@/lib/types";
import { Pager, pageWindow } from "@/components/dashboard/pager";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SubscriptionsPanel } from "./subscriptions-panel";

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
  // The window belongs to the invoice list -- it is the only thing on
  // this page the API pages. A long-standing customer on a monthly plan
  // has more invoices than fit on one card.
  searchParams: Promise<{ take?: string; skip?: string }>;
}) {
  await requireStaff();
  const { id } = await params;
  const { take: takeParam, skip: skipParam } = await searchParams;
  // 20 rather than the API's default 100: this is a card inside a page,
  // not a table that owns the screen.
  const { take, skip } = pageWindow({ take: takeParam, skip: skipParam }, 20);

  const customer = await apiFetch<Customer>(`/customers/${id}`).catch(() => null);
  if (!customer) notFound();

  // Fetched together: the page is useless without the subscriptions, and
  // serially awaiting three independent requests just makes it slower.
  const invoiceQuery = new URLSearchParams({
    customerId: id,
    take: String(take),
  });
  if (skip > 0) invoiceQuery.set("skip", String(skip));

  const [subscriptions, plans, invoices] = await Promise.all([
    // Not windowed on the API, and does not need to be: one customer's
    // subscriptions are bounded by the customer.
    apiFetch<Subscription[]>(`/subscriptions?customerId=${encodeURIComponent(id)}`).catch(() => []),
    apiFetch<SubscriptionPlan[]>("/plans").catch(() => []),
    apiFetchList<InvoiceListRow>(`/invoices?${invoiceQuery.toString()}`).catch(() => ({
      items: [],
      total: 0,
    })),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Link
            href="/customers"
            className="mt-0.5 flex size-8 items-center justify-center rounded-lg border border-white/10 text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
            aria-label="Back to customers"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="text-xl font-semibold">{customer.email}</h1>
            <p className="text-sm text-muted-foreground">
              Joined {new Date(customer.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={customer.status === "ACTIVE" ? "default" : "outline"}>
            {customer.status}
          </Badge>
          {/* Whether they ever confirmed their address is the first thing
              worth knowing when someone says the app will not let them
              in -- an unverified account is gated by design. */}
          <Badge variant={customer.emailVerifiedAt ? "outline" : "destructive"}>
            {customer.emailVerifiedAt ? "Email verified" : "Email unverified"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Fact icon={<Mail className="size-4" />} label="Telegram" value={customer.telegramId ?? "—"} />
        <Fact
          icon={<Users className="size-4" />}
          label="Referral code"
          value={customer.referralCode ?? "—"}
          mono
        />
        <Fact
          icon={<CheckCircle2 className="size-4" />}
          label="Verified"
          value={
            customer.emailVerifiedAt
              ? new Date(customer.emailVerifiedAt).toLocaleDateString()
              : "Never"
          }
        />
      </div>

      <SubscriptionsPanel customerId={id} subscriptions={subscriptions} plans={plans} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Invoices
            {/* The count next to the title, because the card shows a
                window now: without it, "3 invoices" is what an operator
                would tell a customer who has thirty. */}
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
                  <Badge variant={invoice.status === "PAID" ? "outline" : "default"}>
                    {invoice.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
          <Pager
            total={invoices.total}
            take={take}
            skip={skip}
            basePath={`/customers/${id}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
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
