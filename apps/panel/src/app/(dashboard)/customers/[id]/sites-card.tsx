import Form from "next/form";
import Link from "next/link";
import { Globe, Search } from "lucide-react";
import type { CustomerSites } from "@/lib/types";
import { protocolLabel } from "@/lib/protocol-labels";
import { ago } from "@/lib/time";
import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** The windows the history can be read over. The backend keeps 7 days;
 * shorter windows exist because "what did they open this morning, when it
 * stopped working" is the usual question and a week of rows buries it. */
export const SITE_WINDOWS = [1, 3, 7] as const;
export type SiteWindow = (typeof SITE_WINDOWS)[number];

export type SitesState =
  | { kind: "closed" }
  | { kind: "failed" }
  | { kind: "loaded"; data: CustomerSites };

/** The sites and addresses this customer's connections opened.
 *
 * Closed until somebody asks. Reading another person's browsing is not
 * part of fixing their subscription, and every read is written to the
 * admin audit log under this customer -- loading it with the profile
 * would fill that log with views nobody actually made, and make the real
 * ones impossible to tell apart. So the history loads only once a window
 * is chosen, and the window lives in the URL (`days`, `q`) so a link to
 * it is a deliberate act too.
 *
 * Rendered only for SUPERADMIN; the page does not call the endpoint for
 * anyone else, and hides the card entirely if the API refuses.
 */
export function SitesCard({
  customerId,
  state,
  days,
  q,
}: {
  customerId: string;
  state: SitesState;
  days: SiteWindow;
  q: string;
}) {
  const base = `/customers/${customerId}`;

  function windowHref(span: SiteWindow) {
    const query = new URLSearchParams({ days: String(span) });
    if (q) query.set("q", q);
    return `${base}?${query.toString()}`;
  }

  return (
    <Card className="gap-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
        <CardTitle className="text-base">
          Sites ({state.kind !== "closed" && days === 1 ? "last day" : `last ${state.kind === "closed" ? 7 : days} days`})
        </CardTitle>
        {state.kind !== "closed" && (
          <Link href={base} scroll={false} className="text-xs text-muted-foreground hover:text-foreground">
            Hide
          </Link>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {state.kind === "closed" ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-muted-foreground">
              Which sites and addresses this customer&apos;s connections opened, kept for 7 days.
              Opening it is recorded in the admin audit log against this customer.
            </p>
            <Link
              href={windowHref(7)}
              scroll={false}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
            >
              <Globe /> Show site history
            </Link>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex gap-1.5">
                {SITE_WINDOWS.map((span) => (
                  <Link
                    key={span}
                    href={windowHref(span)}
                    scroll={false}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                      span === days
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                    )}
                  >
                    {span === 1 ? "Last day" : `${span} days`}
                  </Link>
                ))}
              </div>
              {/* A GET form, so the search is in the URL with the window
                  and survives a reload. Searched on the server: a week of
                  someone's traffic is more rows than one page carries. */}
              <Form action={base} scroll={false} className="relative sm:w-72">
                <input type="hidden" name="days" value={days} />
                <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  name="q"
                  defaultValue={q}
                  placeholder="Search site, address or owner"
                  className="pl-9"
                  aria-label="Search sites"
                />
              </Form>
            </div>

            {state.kind === "failed" ? (
              <p className="text-sm text-muted-foreground">Could not load the site history.</p>
            ) : (
              <SitesTable data={state.data} q={q} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function SitesTable({ data, q }: { data: CustomerSites; q: string }) {
  return (
    <>
      {/* The backend's own sentence on what is and is not recorded, shown
          above the rows rather than in a footnote: an empty table here can
          mean "opened nothing" or "used a protocol nothing is logged for",
          and only this line says which. */}
      <p className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-xs text-muted-foreground">
        {data.coverage}
      </p>

      {data.sites.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {q ? "Nothing in this window matches that search." : "Nothing recorded in this window."}
        </p>
      ) : (
        <>
          {data.total > data.sites.length && (
            <p className="text-xs text-muted-foreground tabular-nums">
              Showing {data.sites.length.toLocaleString()} of {data.total.toLocaleString()} destinations.
              Search to narrow it down.
            </p>
          )}
          <div className="rounded-lg border border-white/8 bg-card/40">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead className="text-right">Connections</TableHead>
                  <TableHead>First seen</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Servers</TableHead>
                  <TableHead>Protocols</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.sites.map((site) => (
                  <TableRow key={`${site.host}-${site.port}-${site.network}`}>
                    <TableCell className="max-w-80 truncate font-mono text-xs" title={site.host}>
                      {site.host}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-sm text-muted-foreground" title={site.owner ?? undefined}>
                      {site.owner ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {site.port}/{site.network}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{site.count.toLocaleString()}</TableCell>
                    <TableCell className="text-sm" title={new Date(site.firstSeen).toLocaleString()}>
                      {ago(site.firstSeen)}
                    </TableCell>
                    <TableCell className="text-sm" title={new Date(site.lastSeen).toLocaleString()}>
                      {ago(site.lastSeen)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{site.servers.join(", ") || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {site.protocols.map((protocol) => protocolLabel(protocol)).join(", ") || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </>
  );
}
