import { apiFetch, apiFetchList } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import type { GameProfileListRow, GamingResolver, Node, PlanFeatureGrant } from "@/lib/types";
import { Pager, pageWindow } from "@/components/dashboard/pager";
import { GameProfilesTable } from "./game-profiles-table";
import { ResolversTable } from "./resolvers-table";
import { PlanFeaturesCard } from "./plan-features-card";

export default async function GamingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; isActive?: string; take?: string; skip?: string }>;
}) {
  await requireStaff();
  const { q, isActive, take: takeParam, skip: skipParam } = await searchParams;
  const { take, skip } = pageWindow({ take: takeParam, skip: skipParam });

  // Resolved once and used for the request, the tabs and the pager links
  // alike, so a hand-typed `?isActive=maybe` cannot show the active list
  // under a tab claiming to be something else.
  const activeFilter = isActive === "all" || isActive === "false" ? isActive : "true";

  // The catalogue is 1,480 games and this page used to fetch all of them
  // on every load. The window, the search term and the filter all live in
  // the URL rather than in component state, so the search box, the tabs
  // and the pager are one mechanism -- a link -- and the page stays a
  // Server Component that renders the rows the server actually sent.
  const profileQuery = new URLSearchParams({ take: String(take) });
  if (skip > 0) profileQuery.set("skip", String(skip));
  if (q) profileQuery.set("q", q);
  // Omitted means the route's own default, which is active-only. Sent
  // only when the operator asked for something else.
  if (activeFilter !== "true") profileQuery.set("isActive", activeFilter);

  const [profiles, resolvers, planFeatures, nodes, session] = await Promise.all([
    apiFetchList<GameProfileListRow>(`/gaming/profiles?${profileQuery.toString()}`),
    apiFetch<GamingResolver[]>("/gaming/resolvers"),
    apiFetch<PlanFeatureGrant[]>("/gaming/plan-features"),
    apiFetch<Node[]>("/nodes"),
    getSession(),
  ]);
  const canManage = session?.role === "SUPERADMIN";

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Gaming Mode</h1>
        {/* This paragraph is the product description an operator will
            repeat to a customer, so it says the uncomfortable half
            first. The numbers are measured, from Tehran, August 2026 --
            not an estimate, and not something to round off in a sales
            conversation. */}
        <p className="max-w-3xl text-sm text-muted-foreground">
          Gaming mode carries a game&apos;s launcher, login, account, web and store traffic over our
          network and leaves the game&apos;s own connections on the customer&apos;s direct path, by
          construction.{" "}
          <span className="text-foreground">
            It is not a lower-ping feature and must not be sold as one.
          </span>{" "}
          Measured from Tehran, the direct path to Blizzard&apos;s EU game server is 72.0 ms and the
          best node in our fleet is 72.8 ms -- a dead heat before encryption, so routing the game
          itself through us makes it no faster and usually slower. What this does is stop carrying
          the things that should not be carried. Where a platform or a game cannot be covered, that
          is a gap to state plainly to the customer, not one to paper over.
        </p>
      </header>

      <div className="flex flex-col gap-4">
        <GameProfilesTable
          profiles={profiles.items}
          canManage={canManage}
          query={q ?? ""}
          activeFilter={activeFilter}
        />
        <Pager
          total={profiles.total}
          take={take}
          skip={skip}
          basePath="/gaming"
          params={{ q, isActive: activeFilter === "true" ? undefined : activeFilter }}
        />
      </div>
      <ResolversTable resolvers={resolvers} nodes={nodes} canManage={canManage} />
      <PlanFeaturesCard grants={planFeatures} canManage={canManage} />
    </div>
  );
}
