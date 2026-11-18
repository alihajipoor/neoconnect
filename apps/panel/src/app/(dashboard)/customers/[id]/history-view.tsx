import Link from "next/link";
import {
  BadgeCheck,
  CreditCard,
  KeyRound,
  LifeBuoy,
  LogIn,
  LogOut,
  Rocket,
  ShieldCheck,
  Ticket,
  UserPlus,
  Wallet,
  WalletMinimal,
  type LucideIcon,
} from "lucide-react";
import { apiFetchList } from "@/lib/api";
import type { CustomerHistoryEvent, CustomerHistoryEventType } from "@/lib/types";
import { Pager } from "@/components/dashboard/pager";
import { Badge } from "@/components/ui/badge";
import { historyLabel } from "./insight-labels";
import { dayHeading, groupByUtcDay, utcClock } from "./insight-layout";
import { Muted, Section, When, orNull } from "./view-parts";

const ICONS: Record<CustomerHistoryEventType, LucideIcon> = {
  ACCOUNT_CREATED: UserPlus,
  EMAIL_VERIFIED: BadgeCheck,
  IDENTITY_LINKED: KeyRound,
  DEVICE_SIGNED_IN: LogIn,
  DEVICE_SIGNED_OUT: LogOut,
  SUBSCRIPTION_STARTED: Wallet,
  SUBSCRIPTION_ENDED: WalletMinimal,
  CODE_REDEEMED: Ticket,
  PAYMENT: CreditCard,
  SUPPORT_TICKET: LifeBuoy,
  FIRST_CONNECT: Rocket,
  STAFF_ACTION: ShieldCheck,
};

/** What happened to the account, newest first, as a timeline under UTC
 * day headings. Staff actions appear only when the backend returns them
 * (SUPERADMIN). */
export async function HistoryView({ customerId, take, skip }: { customerId: string; take: number; skip: number }) {
  const query = new URLSearchParams({ take: String(take) });
  if (skip > 0) query.set("skip", String(skip));
  const page = await orNull(
    apiFetchList<CustomerHistoryEvent>(`/customers/${encodeURIComponent(customerId)}/history?${query.toString()}`),
  );

  return (
    <Section
      title="History"
      note={page && page.total > 0 ? `${page.total.toLocaleString()} events, newest first, times in UTC` : undefined}
    >
      {page === null ? (
        <Muted>Could not load this customer&apos;s history.</Muted>
      ) : page.items.length === 0 ? (
        <Muted>No events recorded for this account.</Muted>
      ) : (
        <div className="flex flex-col gap-5">
          {groupByUtcDay(page.items).map((group) => (
            <section key={group.day} aria-label={dayHeading(group.day)}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {dayHeading(group.day)}
              </h3>
              <ol className="relative flex flex-col">
                {group.items.map((event, index) => (
                  <HistoryItem
                    key={`${event.at}-${event.type}-${index}`}
                    event={event}
                    last={index === group.items.length - 1}
                  />
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      {page && (
        <Pager total={page.total} take={take} skip={skip} basePath={`/customers/${customerId}`} params={{ view: "history" }} />
      )}
    </Section>
  );
}

function HistoryItem({ event, last }: { event: CustomerHistoryEvent; last: boolean }) {
  const Icon = ICONS[event.type] ?? ShieldCheck;
  const staff = event.type === "STAFF_ACTION";
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {/* The line joining a day's events. */}
      {!last && <span className="absolute top-8 bottom-0 left-[15px] w-px bg-white/10" aria-hidden="true" />}
      <span
        className={
          staff
            ? "flex size-8 shrink-0 items-center justify-center rounded-full border border-highlight/40 bg-highlight/10 text-highlight"
            : "flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-card text-muted-foreground"
        }
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1 pt-1 text-sm">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 font-medium [overflow-wrap:anywhere]">
            {event.link?.startsWith("/") ? (
              <Link href={event.link} className="underline-offset-2 hover:underline">
                {event.title}
              </Link>
            ) : (
              event.title
            )}
          </p>
          <Badge variant={staff ? "highlight" : "outline"} className="shrink-0">
            {historyLabel(event.type)}
          </Badge>
        </div>
        {(event.detail || event.actor) && (
          <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {event.detail}
            {event.detail && event.actor && " · "}
            {event.actor && <span>by {event.actor}</span>}
          </p>
        )}
        <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          <time dateTime={event.at}>{utcClock(event.at)} UTC</time>
          <span className="mx-1.5" aria-hidden="true">
            ·
          </span>
          <When at={event.at} />
        </p>
      </div>
    </li>
  );
}
