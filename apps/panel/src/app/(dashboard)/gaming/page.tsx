import { apiFetch } from "@/lib/api";
import { getSession, requireStaff } from "@/lib/session";
import type { GameProfile, GamingResolver, Node, PlanFeatureGrant } from "@/lib/types";
import { GameProfilesTable } from "./game-profiles-table";
import { ResolversTable } from "./resolvers-table";
import { PlanFeaturesCard } from "./plan-features-card";

export default async function GamingPage() {
  await requireStaff();
  const [profiles, resolvers, planFeatures, nodes, session] = await Promise.all([
    apiFetch<GameProfile[]>("/gaming/profiles"),
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

      <GameProfilesTable profiles={profiles} canManage={canManage} />
      <ResolversTable resolvers={resolvers} nodes={nodes} canManage={canManage} />
      <PlanFeaturesCard grants={planFeatures} canManage={canManage} />
    </div>
  );
}
