import { apiFetch, apiFetchList } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import type { InvoiceListRow, InvoiceStatus, InvoiceSummary } from "@/lib/types";
import { Pager, pageWindow } from "@/components/dashboard/pager";
import { InvoicesView } from "./invoices-view";

const SUMMARY_DAYS = 30;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; take?: string; skip?: string }>;
}) {
  await requireStaff();
  const { status, take: takeParam, skip: skipParam } = await searchParams;
  const { take, skip } = pageWindow({ take: takeParam, skip: skipParam });
  const session = await getSession();
  // Voiding changes what the books say -- the backend gates it to
  // SUPERADMIN/BILLING, and the UI hides it for everyone else rather
  // than offering an action that will only come back rejected.
  const canVoid = session?.role === "SUPERADMIN" || session?.role === "BILLING";

  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));
  if (status) query.set("status", status);

  // The revenue card is not affected by the window: /invoices/summary is
  // an aggregate over 30 days computed on the server, so the figure it
  // shows is the money actually collected and not the money on this page.
  const [invoices, summary] = await Promise.all([
    apiFetchList<InvoiceListRow>(`/invoices?${query.toString()}`),
    apiFetch<InvoiceSummary>(`/invoices/summary?days=${SUMMARY_DAYS}`),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <InvoicesView
        invoices={invoices.items}
        summary={summary}
        summaryDays={SUMMARY_DAYS}
        activeStatus={(status as InvoiceStatus | undefined) ?? null}
        canVoid={canVoid}
      />
      <Pager
        total={invoices.total}
        take={take}
        skip={skip}
        basePath="/invoices"
        params={{ status }}
      />
    </div>
  );
}
