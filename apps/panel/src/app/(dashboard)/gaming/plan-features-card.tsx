"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setPlanFeatures } from "./actions";
import { ALL_PLAN_FEATURES, type PlanFeatureGrant, type PlanFeatureKey } from "@/lib/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/* Keyed by the union, so a new feature key is a compile error here
 * rather than a checkbox that quietly never appears on the grid -- the
 * same reasoning as PROTOCOL_PRESENCE in lib/types.ts, which exists
 * because two shipped protocols were missing from a hand-written array
 * and could not be granted to a plan at all.
 *
 * `available: false` is not a disabled-because-busy state. It means the
 * thing the key names does not exist yet, so granting it would change
 * nothing for the customer while looking, in this panel, exactly like a
 * feature they had been given. */
const FEATURES: Record<
  PlanFeatureKey,
  { label: string; description: string; available: boolean }
> = {
  GAMING_DNS: {
    label: "Gaming mode",
    description:
      "Carries the launcher, login, account and store hosts of each active game. The game's own connections stay on the customer's direct path.",
    available: true,
  },
  GAMING_PRIVATE_EXIT: {
    label: "Private exit — not built",
    description:
      "Would give a game its own low-density exit address. Nothing implements it, so granting it would change nothing for the customer.",
    available: false,
  },
};

export function PlanFeaturesCard({
  grants,
  canManage,
}: {
  grants: PlanFeatureGrant[];
  canManage: boolean;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Plans that include Gaming Mode</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          A feature of the existing tiers rather than a plan of its own -- another plan multiplies
          the route matrix, and a plan with nothing ticked serves nothing. People need to be able to
          try this before paying in crypto, so it is reasonable on the trial tier too.
        </p>
      </div>
      <Card className="border-white/10 bg-card/80">
        <CardHeader>
          <CardTitle className="text-base">Feature grants</CardTitle>
          <CardDescription>
            Each change saves immediately. Granting gaming mode to a plan does not make it work: it
            needs at least one active game and one confirmed resolver, both above.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          {grants.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No plans exist yet.</p>
          ) : (
            grants.map((grant) => (
              <PlanFeatureRow key={grant.planId} grant={grant} canManage={canManage} />
            ))
          )}
        </CardContent>
      </Card>
    </section>
  );
}

function PlanFeatureRow({ grant, canManage }: { grant: PlanFeatureGrant; canManage: boolean }) {
  const [features, setFeatures] = useState<PlanFeatureKey[]>(grant.features);
  const [pending, startTransition] = useTransition();

  function toggle(key: PlanFeatureKey, checked: boolean) {
    const previous = features;
    // Always the full set, including an empty array -- this is a PUT and
    // an empty array is what revokes the last feature. Sending a partial
    // set would mean an operator unticking the final box watches nothing
    // happen.
    const next = checked ? [...previous, key] : previous.filter((f) => f !== key);
    setFeatures(next);

    startTransition(async () => {
      const result = await setPlanFeatures(grant.planId, next);
      if (result.ok) {
        toast.success(`${grant.planName} updated`);
      } else {
        // Put the checkbox back. A control that shows a state the server
        // refused is the same lie as a connected indicator over a dead
        // tunnel.
        setFeatures(previous);
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-white/5 py-3 last:border-b-0">
      <div className="w-40 shrink-0">
        <div className="text-sm font-medium">{grant.planName}</div>
        {pending && <div className="text-xs text-muted-foreground">Saving...</div>}
      </div>
      {ALL_PLAN_FEATURES.map((key) => {
        const feature = FEATURES[key];
        return (
          <label
            key={key}
            className="flex max-w-md items-start gap-2 text-sm"
            title={feature.description}
          >
            <Checkbox
              // Always the state the backend actually holds, including
              // for a feature that is not built. A box drawn unticked
              // over a grant that exists is the panel lying about state,
              // which is the one thing this product does not do.
              checked={features.includes(key)}
              // Not hidden. An operator who cannot see the control assumes
              // the capability is missing entirely; one who can tick it
              // assumes it does something. Shown and unusable is the only
              // honest option while it does not exist.
              disabled={!feature.available || !canManage || pending}
              onCheckedChange={(value) => toggle(key, value === true)}
              className="mt-px"
            />
            <span className={feature.available ? "" : "text-muted-foreground"}>
              {feature.label}
              {!feature.available && features.includes(key) && (
                <span className="ml-1 text-amber-300">
                  (granted, but nothing implements it)
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
