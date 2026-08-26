"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, ExternalLink, MoreHorizontal, Search } from "lucide-react";
import type { InvoiceListRow, InvoiceStatus, InvoiceSummary } from "@/lib/types";
import { voidInvoice } from "./actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const STATUS_FILTERS: { label: string; value: InvoiceStatus | null }[] = [
  { label: "All", value: null },
  { label: "Paid", value: "PAID" },
  { label: "Issued", value: "ISSUED" },
  { label: "Overdue", value: "OVERDUE" },
  { label: "Void", value: "VOID" },
];

const STATUS_STYLES: Record<InvoiceStatus, { variant: "success" | "highlight" | "destructive" | "secondary" }> = {
  PAID: { variant: "success" },
  ISSUED: { variant: "highlight" },
  OVERDUE: { variant: "destructive" },
  VOID: { variant: "secondary" },
  DRAFT: { variant: "secondary" },
};

const PROVIDER_LABELS: Record<string, string> = {
  STRIPE: "Card",
  NOWPAYMENTS: "Crypto",
};

function usd(amount: string) {
  return `$${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function InvoicesView({
  invoices,
  summary,
  summaryDays,
  activeStatus,
  canVoid,
}: {
  invoices: InvoiceListRow[];
  summary: InvoiceSummary;
  summaryDays: number;
  activeStatus: InvoiceStatus | null;
  canVoid: boolean;
}) {
  const [query, setQuery] = useState("");

  // Search is client-side and searches only the page currently loaded,
  // which is a real limit now that /invoices is windowed: a customer
  // whose invoice is on page three is not found by typing their email
  // here. It stays because narrowing 100 visible rows by eye is the
  // common task and a round trip per keystroke would be slower -- but
  // the empty state below has to say "on this page" or it reads as
  // "that invoice does not exist".
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return invoices;
    return invoices.filter(
      (invoice) =>
        invoice.invoiceNumber.toLowerCase().includes(needle) ||
        (invoice.customer?.email ?? "").toLowerCase().includes(needle) ||
        invoice.planNameSnapshot.toLowerCase().includes(needle),
    );
  }, [invoices, query]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Invoices</h1>
        <p className="text-sm text-muted-foreground">
          Every charge that has been issued, and what it actually collected.
        </p>
      </div>

      <RevenueCard summary={summary} days={summaryDays} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((filter) => {
            const active = activeStatus === filter.value;
            return (
              <Link
                key={filter.label}
                href={filter.value ? `/invoices?status=${filter.value}` : "/invoices"}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-primary/15 text-foreground"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
        <div className="relative sm:w-72">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search number, email, or plan"
            className="pl-9"
            aria-label="Search invoices"
          />
        </div>
      </div>

      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Paid with</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {invoices.length > 0
                    ? "Nothing on this page matches that search."
                    : activeStatus
                      ? `No ${activeStatus.toLowerCase()} invoices.`
                      : "No invoices yet. One is issued automatically the moment a payment clears."}
                </TableCell>
              </TableRow>
            ) : (
              visible.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell className="font-mono text-xs font-medium">{invoice.invoiceNumber}</TableCell>
                  <TableCell>{invoice.customer.email}</TableCell>
                  <TableCell>{invoice.planNameSnapshot}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {invoice.paymentTransaction
                      ? (PROVIDER_LABELS[invoice.paymentTransaction.provider] ??
                        invoice.paymentTransaction.provider)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {usd(invoice.amountUsd)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_STYLES[invoice.status].variant}>{invoice.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{shortDate(invoice.issuedAt)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Row actions">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <a href={`/invoices/${invoice.id}/document`} target="_blank" rel="noreferrer">
                            <ExternalLink className="size-4" /> View invoice
                          </a>
                        </DropdownMenuItem>
                        {canVoid && invoice.status !== "VOID" && (
                          <VoidConfirm
                            invoice={invoice}
                            trigger={
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={(event) => event.preventDefault()}
                              >
                                <Ban className="size-4" /> Void
                              </DropdownMenuItem>
                            }
                          />
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Revenue actually collected in the window, with where it came from.
 *
 * The two breakdowns answer different questions -- "which plan is
 * carrying the business" and "are people paying by card or crypto" --
 * and both are read at a glance, so they're bars rather than a second
 * table to scan. */
function RevenueCard({ summary, days }: { summary: InvoiceSummary; days: number }) {
  const total = Number(summary.totalUsd);

  return (
    <Card className="gap-5 overflow-hidden p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Collected in the last {days} days</p>
          <p className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">
            {usd(summary.totalUsd)}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {summary.invoiceCount} paid {summary.invoiceCount === 1 ? "invoice" : "invoices"}
        </p>
      </div>

      {total > 0 && (
        <div className="grid gap-6 sm:grid-cols-2">
          <Breakdown
            title="By plan"
            rows={summary.byPlan.map((row) => ({ label: row.name, amountUsd: row.amountUsd }))}
            total={total}
            accent="bg-primary"
          />
          <Breakdown
            title="By payment method"
            rows={summary.byProvider.map((row) => ({
              label: PROVIDER_LABELS[row.provider] ?? row.provider,
              amountUsd: row.amountUsd,
            }))}
            total={total}
            accent="bg-highlight"
          />
        </div>
      )}
    </Card>
  );
}

function Breakdown({
  title,
  rows,
  total,
  accent,
}: {
  title: string;
  rows: { label: string; amountUsd: string }[];
  total: number;
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <div className="flex items-baseline justify-between text-sm">
            <span>{row.label}</span>
            <span className="tabular-nums text-muted-foreground">{usd(row.amountUsd)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
            <div
              className={cn("h-full rounded-full", accent)}
              style={{ width: `${Math.max((Number(row.amountUsd) / total) * 100, 2)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function VoidConfirm({ invoice, trigger }: { invoice: InvoiceListRow; trigger: React.ReactNode }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleConfirm() {
    startTransition(async () => {
      const result = await voidInvoice(invoice.id);
      if (result.ok) {
        toast.success(`${invoice.invoiceNumber} voided.`);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void {invoice.invoiceNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            The invoice stays in the books marked VOID rather than disappearing, so the numbering stays
            intact. An invoice that was already paid can&apos;t be voided — refund the payment instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            {pending ? "Voiding..." : "Void invoice"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
