"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Wrench } from "lucide-react";
import { toast } from "sonner";
import { createGameProfile, updateGameProfile } from "./actions";
import { StringListField, toList } from "./string-list-field";
import type { GameProfile } from "@/lib/types";
import { isCidr, isPlausibleHostname } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const SLUG = /^[a-z0-9-]+$/;

export function GameProfileFormDialog({
  profile,
  trigger,
}: {
  profile?: GameProfile;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(profile);

  function handleSubmit(formData: FormData) {
    const slug = String(formData.get("slug") ?? "").trim();
    if (!SLUG.test(slug)) {
      toast.error("Slug may only contain lowercase letters, digits and hyphens.");
      return;
    }

    // Lowercased on the way in, because DNS is case-insensitive and the
    // things that read these lists are not: "OAuth.Battle.net" and
    // "oauth.battle.net" would sit in the table as two hosts, and the
    // canary check below would reject a canary that is plainly in the
    // list. Canonical form here means one spelling everywhere after.
    const lower = (v: FormDataEntryValue | null) => toList(v).map((h) => h.toLowerCase());
    const hostnames = lower(formData.get("hostnames"));
    const excludeHostnames = lower(formData.get("excludeHostnames"));
    const processNames = toList(formData.get("processNames"));
    const destinationCidrs = toList(formData.get("destinationCidrs"));
    const canaryHostname = String(formData.get("canaryHostname") ?? "")
      .trim()
      .toLowerCase();

    // A profile with no hostnames is not a smaller profile, it is an
    // inert one: nothing to answer for, nothing to proxy, and it looks
    // configured in every list.
    if (hostnames.length === 0) {
      toast.error(
        "List at least one hostname. A game with none redirects nothing -- start with the launcher and login hosts.",
      );
      return;
    }

    const badHost = [...hostnames, ...excludeHostnames].find((h) => !isPlausibleHostname(h));
    if (badHost) {
      toast.error(
        `"${badHost}" is not a hostname. These lists are matched by name only -- an IP address here never matches anything.`,
      );
      return;
    }

    if (canaryHostname && !hostnames.includes(canaryHostname)) {
      toast.error(
        `The canary "${canaryHostname}" must be one of the hostnames above, or the client is checking something we never redirect.`,
      );
      return;
    }

    const badCidr = destinationCidrs.find((c) => !isCidr(c));
    if (badCidr) {
      toast.error(`"${badCidr}" is not a network in CIDR form, e.g. 137.221.64.0/24.`);
      return;
    }

    const publisher = String(formData.get("publisher") ?? "").trim();
    const iconKey = String(formData.get("iconKey") ?? "").trim();
    const destinationAsn = String(formData.get("destinationAsn") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();

    startTransition(async () => {
      const input = {
        slug,
        displayName: String(formData.get("displayName") ?? "").trim(),
        publisher: publisher || null,
        iconKey: iconKey || null,
        hostnames,
        excludeHostnames,
        processNames,
        destinationCidrs,
        destinationAsn: destinationAsn || null,
        prefixComplete: formData.get("prefixComplete") === "on",
        canaryHostname: canaryHostname || null,
        sortOrder: Number(formData.get("sortOrder") ?? 0),
        isActive: formData.get("isActive") === "on",
        notes: notes || null,
      };

      const result = isEdit
        ? await updateGameProfile(profile!.id, input)
        : await createGameProfile(input);

      if (result.ok) {
        toast.success(isEdit ? "Game updated" : "Game created");
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${profile!.displayName}` : "New game"}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="displayName">Display name</Label>
              <Input
                id="displayName"
                name="displayName"
                defaultValue={profile?.displayName}
                placeholder="World of Warcraft"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                name="slug"
                defaultValue={profile?.slug}
                placeholder="world-of-warcraft"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
                required
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, digits and hyphens. This is what a client matches on, so changing
                it on a live game orphans whatever the shipped apps already cached.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="publisher">Publisher</Label>
              <Input
                id="publisher"
                name="publisher"
                defaultValue={profile?.publisher ?? ""}
                placeholder="Blizzard"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="iconKey">Icon key</Label>
              <Input
                id="iconKey"
                name="iconKey"
                defaultValue={profile?.iconKey ?? ""}
                placeholder="wow"
                autoComplete="off"
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sortOrder">Sort order</Label>
              <Input
                id="sortOrder"
                name="sortOrder"
                type="number"
                defaultValue={profile?.sortOrder ?? 0}
                required
              />
            </div>
          </div>

          {/* The two lists that actually do something, and the whole
              reason the explanations are this long. Both fail silently
              when they are wrong: a realm server in the first is inert,
              a missing patch host in the second is a bill. */}
          <StringListField
            id="hostnames"
            name="hostnames"
            label="Hostnames carried"
            defaultValue={profile?.hostnames}
            placeholder={"oauth.battle.net\nus.actual.battle.net\nshop.battle.net"}
            hint={
              <>
                Launcher, login, account, web and store hosts only, one per line.{" "}
                <span className="text-foreground">
                  Never the game&apos;s own realm or world servers.
                </span>{" "}
                The game is handed those as literal addresses inside its own session, so no resolver
                ever sees them and listing one here does nothing at all -- it is accepted, it shows
                in the list, and it never matches. Leaving the game&apos;s own connections on the
                customer&apos;s direct path is the design, not a shortfall.
              </>
            }
          />

          <StringListField
            id="excludeHostnames"
            name="excludeHostnames"
            label="Hostnames excluded"
            defaultValue={profile?.excludeHostnames}
            placeholder={"blzddist1-a.akamaihd.net\nlevel3.blizzard.com"}
            hint={
              <>
                Patch and CDN hosts, left on the customer&apos;s own path deliberately. A
                multi-gigabyte download pulled through a node eats a metered plan&apos;s cap, and the
                bill is our fault. Blizzard&apos;s are{" "}
                <code className="font-mono">blzddist1-a.akamaihd.net</code> and{" "}
                <code className="font-mono">level3.blizzard.com</code>. Add a game&apos;s patch hosts
                here before you add its launcher hosts above.
              </>
            }
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor="canaryHostname">Canary hostname</Label>
            <Input
              id="canaryHostname"
              name="canaryHostname"
              defaultValue={profile?.canaryHostname ?? ""}
              placeholder="oauth.battle.net"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Must be one of the hostnames above. The client resolves it and checks the answer to
              prove the rules are actually live on this machine.{" "}
              <span className="text-foreground">
                With none set the client has nothing to check and can never report better than
                &quot;partial&quot;
              </span>{" "}
              -- which is the honest answer when nothing has been verified, and not one a customer
              should be shown because a field was left blank.
            </p>
          </div>

          {/* The not-built group. It is shown rather than hidden for the
              same reason the disabled private-exit checkbox is shown on
              the plans card: an operator who cannot see a field assumes
              the feature is missing, and an operator who fills one in
              assumes it works. Neither is true, so say which. */}
          <section className="flex flex-col gap-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-100">
              <Wrench className="size-4 text-amber-400" />
              Per-game private exit -- not built yet
            </div>
            <div className="flex gap-2 text-xs text-amber-200/90">
              <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" />
              <p>
                Nothing reads the four fields below. They are stored and they are handed to nobody:
                there is no client, no node component and no route that acts on them, so anything
                entered here has no effect on any customer. They exist so the curation work can be
                done ahead of the feature. Do not configure a game from these fields and expect a
                behaviour change, and do not tell a customer a game is covered because they are
                filled in.
              </p>
            </div>

            <StringListField
              id="processNames"
              name="processNames"
              label="Process names"
              defaultValue={profile?.processNames}
              placeholder={"Wow.exe\nBattle.net.exe"}
              hint="Executable names the private exit would match on the desktop client. Not read by anything today."
            />

            <StringListField
              id="destinationCidrs"
              name="destinationCidrs"
              label="Destination networks (CIDR)"
              defaultValue={profile?.destinationCidrs}
              placeholder={"137.221.64.0/24\n37.244.0.0/16"}
              hint="Networks the private exit would route, in CIDR form -- a bare address is rejected, since these are matched as prefixes. Not read by anything today."
            />

            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="destinationAsn">Destination ASN</Label>
                <Input
                  id="destinationAsn"
                  name="destinationAsn"
                  defaultValue={profile?.destinationAsn ?? ""}
                  placeholder="AS57976"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </div>
              <label className="flex items-start gap-2 self-end pb-2 text-xs text-amber-200/90">
                <Checkbox name="prefixComplete" defaultChecked={profile?.prefixComplete ?? false} />
                <span>
                  The networks above are believed to cover every prefix this game uses. Untick it if
                  the list was assembled from a handful of observed addresses rather than from the
                  publisher&apos;s announced space.
                </span>
              </label>
            </div>
          </section>

          <div className="flex flex-col gap-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              name="notes"
              defaultValue={profile?.notes ?? ""}
              placeholder="Where this host list came from, and what was measured rather than assumed."
              className="min-h-16"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="isActive" defaultChecked={profile?.isActive ?? true} />
            Active -- offered to clients on plans that include gaming mode
          </label>

          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
