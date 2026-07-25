import { apiFetch } from "@/lib/api";
import { getSession } from "@/lib/session";
import type { Invoice, InvoiceStatus, InvoiceSummary } from "@/lib/types";
import { InvoicesView } from "./invoices-view";

const SUMMARY_DAYS = 30;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const session = await getSession();
  // Voiding changes what the books say -- the backend gates it to
  // SUPERADMIN/BILLING, and the UI hides it for everyone else rather
  // than offering an action that will only come back rejected.
  const canVoid = session?.role === "SUPERADMIN" || session?.role === "BILLING";

  const [invoices, summary] = await Promise.all([
    apiFetch<Invoice[]>(`/invoices${status ? `?status=${encodeURIComponent(status)}` : ""}`),
    apiFetch<InvoiceSummary>(`/invoices/summary?days=${SUMMARY_DAYS}`),
  ]);

  return (
    <InvoicesView
      invoices={invoices}
      summary={summary}
      summaryDays={SUMMARY_DAYS}
      activeStatus={(status as InvoiceStatus | undefined) ?? null}
      canVoid={canVoid}
    />
  );
}
