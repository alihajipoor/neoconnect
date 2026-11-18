import Link from "next/link";
import { apiFetchList } from "@/lib/api";
import type { CustomerHistoryEvent } from "@/lib/types";
import { Pager } from "@/components/dashboard/pager";
import { Badge } from "@/components/ui/badge";
import { historyLabel } from "./insight-labels";
import { Muted, Section, When, orNull } from "./view-parts";

/** What happened to the account, newest first, in one list. Staff
 * actions appear only when the backend returns them (SUPERADMIN). */
export async function HistoryView({ customerId, take, skip }: { customerId: string; take: number; skip: number }) {
  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));
  const page = await orNull(
    apiFetchList<CustomerHistoryEvent>(`/customers/${encodeURIComponent(customerId)}/history?${query.toString()}`),
  );

  return (
    <Section title="History" note={page && page.total > 0 ? page.total.toLocaleString() : undefined}>
      {page === null ? (
        <Muted>Could not load this customer&apos;s history.</Muted>
      ) : page.items.length === 0 ? (
        <Muted>No events recorded for this account.</Muted>
      ) : (
        <ol className="flex flex-col divide-y divide-white/5 rounded-lg border border-white/8 bg-card/40">
          {page.items.map((event, index) => (
            <li key={`${event.at}-${event.type}-${index}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                <When at={event.at} />
              </span>
              <Badge variant={event.type === "STAFF_ACTION" ? "highlight" : "outline"} className="shrink-0">
                {historyLabel(event.type)}
              </Badge>
              <div className="min-w-0 flex-1 text-sm">
                <p className="[overflow-wrap:anywhere]">
                  {event.link?.startsWith("/") ? (
                    <Link href={event.link} className="hover:underline">
                      {event.title}
                    </Link>
                  ) : (
                    event.title
                  )}
                </p>
                {(event.detail || event.actor) && (
                  <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    {event.detail}
                    {event.detail && event.actor && " · "}
                    {event.actor && <span>by {event.actor}</span>}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {page && (
        <Pager total={page.total} take={take} skip={skip} basePath={`/customers/${customerId}`} params={{ view: "history" }} />
      )}
    </Section>
  );
}
