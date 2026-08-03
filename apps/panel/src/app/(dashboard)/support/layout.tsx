import { apiFetch } from "@/lib/api";
import type { SupportSettings, SupportTicket } from "@/lib/types";
import { TicketRail } from "./ticket-rail";

/** A two-pane inbox: conversations on the left, the open one on the
 * right. Held in the layout rather than duplicated into every page so
 * moving between threads swaps only the thread -- the list keeps its
 * scroll position, which is the whole reason an inbox is shaped this
 * way rather than as a table you bounce in and out of.
 */
export default async function SupportLayout({ children }: { children: React.ReactNode }) {
  const [tickets, settings] = await Promise.all([
    apiFetch<SupportTicket[]>("/support/tickets"),
    apiFetch<SupportSettings>("/support/settings"),
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
        <TicketRail tickets={tickets} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
