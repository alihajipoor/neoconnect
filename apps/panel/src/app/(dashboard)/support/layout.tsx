import { apiFetch, apiFetchList } from "@/lib/api";
import { requireStaff } from "@/lib/session";
import type { SupportSettings, SupportTicketListRow } from "@/lib/types";
import { TicketRail } from "./ticket-rail";

/** A two-pane inbox: conversations on the left, the open one on the
 * right. Held in the layout rather than duplicated into every page so
 * moving between threads swaps only the thread -- the list keeps its
 * scroll position, which is the whole reason an inbox is shaped this
 * way rather than as a table you bounce in and out of.
 *
 * That shape is also why the rail's status filter is answered by three
 * fetches here rather than by a `?status=` in the URL. App Router does
 * not hand a layout `searchParams`, and does not re-render one when they
 * change -- only the page segment underneath is refetched -- so a
 * filter driven from the URL would leave the rail showing the list it
 * was built with and quietly disagree with the tab that looks selected.
 * Fetching each status as its own bounded, server-filtered page keeps
 * the WHERE clause on the server (the point: the old client-side filter
 * looked for RESOLVED rows inside a window sorted OPEN-first, and found
 * almost none of them) and keeps every count an `X-Total-Count` total
 * rather than a page length.
 */

/** Per status, matching the route's own default. Three windows rather
 * than one means the rail can hold up to 600 rows instead of 200; they
 * are five-field rows, and the alternative is a filter that lies. */
const PER_STATUS = 200;

export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  await requireStaff();
  const [settings, open, answered, resolved] = await Promise.all([
    apiFetch<SupportSettings>("/support/settings"),
    apiFetchList<SupportTicketListRow>(`/support/tickets?status=OPEN&take=${PER_STATUS}`),
    apiFetchList<SupportTicketListRow>(`/support/tickets?status=ANSWERED&take=${PER_STATUS}`),
    apiFetchList<SupportTicketListRow>(`/support/tickets?status=RESOLVED&take=${PER_STATUS}`),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Support</h1>
        <p className="text-sm text-muted-foreground">
          {settings.acceptingTickets
            ? "Open for new conversations."
            : "Closed to new conversations — existing ones still work."}
        </p>
      </div>

      <div className="flex min-h-[calc(100vh-13rem)] flex-col gap-4 lg:flex-row">
        <TicketRail buckets={{ OPEN: open, ANSWERED: answered, RESOLVED: resolved }} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
