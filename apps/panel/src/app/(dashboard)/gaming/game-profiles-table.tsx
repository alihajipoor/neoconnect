"use client";

import Link from "next/link";
import { MoreHorizontal, Plus, Search } from "lucide-react";
import type { GameProfileListRow } from "@/lib/types";
import { deleteGameProfile } from "./actions";
import { GameProfileFormDialog } from "./game-profile-form-dialog";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const ACTIVE_FILTERS: { label: string; value: "true" | "false" | "all" }[] = [
  { label: "Active", value: "true" },
  { label: "Inactive", value: "false" },
  { label: "All", value: "all" },
];

export function GameProfilesTable({
  profiles,
  canManage,
  query,
  activeFilter,
}: {
  profiles: GameProfileListRow[];
  canManage: boolean;
  query: string;
  activeFilter: "true" | "false" | "all";
}) {
  /** The tabs and the search box both hand off to the URL rather than to
   * state here, so that one page of 100 rows out of 1,480 is what the
   * server sends and not what the browser filtered. Filtering in the
   * browser would search the page an operator happens to be holding and
   * quietly report "no such game" for the other 1,380. */
  function filterHref(value: "true" | "false" | "all") {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (value !== "true") params.set("isActive", value);
    const suffix = params.toString();
    return suffix ? `/gaming?${suffix}` : "/gaming";
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Games</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Each game is a list of hostnames we carry and a list we deliberately do not. Only the
            launcher, login, account, web and store surface belongs here -- the game&apos;s own
            realm connections are handed to it as literal addresses and never reach a resolver, so
            they stay on the customer&apos;s direct path whatever is typed below.
          </p>
        </div>
        {canManage && (
          <GameProfileFormDialog
            trigger={
              <Button size="sm">
                <Plus /> New Game
              </Button>
            }
          />
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {ACTIVE_FILTERS.map((filter) => (
            <Link
              key={filter.value}
              href={filterHref(filter.value)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                activeFilter === filter.value
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              {filter.label}
            </Link>
          ))}
        </div>
        {/* A real GET form, submitted to the same route. It works with
            JavaScript off, it leaves the search in the URL where it can
            be sent to somebody, and it deliberately drops `skip` -- a new
            search starting on page 4 of the previous one shows an empty
            table for a game that exists. */}
        <form action="/gaming" method="get" className="flex gap-2 sm:w-96">
          {activeFilter !== "true" && <input type="hidden" name="isActive" value={activeFilter} />}
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              name="q"
              defaultValue={query}
              placeholder="Search name, slug, or publisher"
              className="pl-9"
              aria-label="Search games"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
      </div>

      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14">Order</TableHead>
              <TableHead>Game</TableHead>
              <TableHead>Publisher</TableHead>
              <TableHead>Carried</TableHead>
              <TableHead>Excluded</TableHead>
              <TableHead>Canary</TableHead>
              <TableHead>Status</TableHead>
              {canManage && <TableHead className="w-10" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {profiles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={canManage ? 8 : 7} className="py-8 text-center text-muted-foreground">
                  {/* Searching the whole catalogue and finding nothing is
                      a different fact from having no games, and an
                      operator who reads the wrong one goes looking for a
                      broken list instead of a typo. */}
                  {query
                    ? `No games match "${query}".`
                    : activeFilter === "false"
                      ? "No inactive games."
                      : "No games yet."}
                </TableCell>
              </TableRow>
            ) : (
              profiles.map((profile) => (
                <TableRow key={profile.id}>
                  <TableCell className="text-muted-foreground">{profile.sortOrder}</TableCell>
                  <TableCell>
                    <div className="font-medium">{profile.displayName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{profile.slug}</div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{profile.publisher ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{profile.hostnames.length} hosts</Badge>
                  </TableCell>
                  <TableCell>
                    {/* Zero exclusions is worth flagging rather than
                        showing as a tidy "0". Almost every game has a
                        patch CDN, and pulling one through a node is how a
                        metered plan's cap disappears in one download. */}
                    {profile.excludeHostnames.length === 0 ? (
                      <span
                        className="text-xs text-amber-300/90"
                        title="No patch or CDN hosts excluded. Check whether this game has any -- a multi-gigabyte download through a node eats a metered cap."
                      >
                        none excluded
                      </span>
                    ) : (
                      <Badge variant="outline">{profile.excludeHostnames.length} hosts</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* No canary is not a cosmetic gap: it is the
                        difference between a client that can prove the
                        rules are live and one that reports "partial"
                        forever because it has nothing to test. */}
                    {profile.canaryHostname ? (
                      <span className="font-mono text-xs">{profile.canaryHostname}</span>
                    ) : (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 text-amber-300"
                        title="The client has nothing to resolve as proof, so it can never report better than partial for this game."
                      >
                        no canary
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={profile.isActive ? "success" : "secondary"}>
                      {profile.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="Row actions">
                            <MoreHorizontal className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <GameProfileFormDialog
                            profile={{ id: profile.id, displayName: profile.displayName }}
                            trigger={
                              <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                                Edit
                              </DropdownMenuItem>
                            }
                          />
                          <DeleteConfirm
                            trigger={
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={(e) => e.preventDefault()}
                              >
                                Delete
                              </DropdownMenuItem>
                            }
                            title="Delete this game?"
                            description={`This removes "${profile.displayName}" from the list every client fetches. Clients that already cached it keep redirecting its hostnames until they refresh.`}
                            successMessage="Game deleted"
                            onConfirm={() => deleteGameProfile(profile.id)}
                          />
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
