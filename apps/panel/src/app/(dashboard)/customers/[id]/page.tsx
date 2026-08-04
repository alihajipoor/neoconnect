import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Mail, Users } from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { Customer, Invoice, Subscription, SubscriptionPlan } from "@/lib/types";
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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const customer = await apiFetch<Customer>(`/customers/${id}`).catch(() => null);
  if (!customer) notFound();

  // Fetched together: the page is useless without the subscriptions, and
  // serially awaiting three independent requests just makes it slower.
  const [subscriptions, plans, invoices] = await Promise.all([
    apiFetch<Subscription[]>(`/subscriptions?customerId=${encodeURIComponent(id)}`).catch(() => []),
    apiFetch<SubscriptionPlan[]>("/plans").catch(() => []),
    apiFetch<Invoice[]>(`/invoices?customerId=${encodeURIComponent(id)}`).catch(() => []),
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
          <CardTitle className="text-base">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing billed yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {invoices.map((invoice) => (
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
