"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { GameProfile } from "@/lib/types";
import { deleteGameProfile } from "./actions";
import { GameProfileFormDialog } from "./game-profile-form-dialog";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function GameProfilesTable({
  profiles,
  canManage,
}: {
  profiles: GameProfile[];
  canManage: boolean;
}) {
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
                  No games yet.
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
                            profile={profile}
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
