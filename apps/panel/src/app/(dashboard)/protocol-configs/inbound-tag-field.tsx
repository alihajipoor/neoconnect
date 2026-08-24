"use client";

import { useState } from "react";
import { AlertTriangle, GitBranch, Info } from "lucide-react";
import type { Protocol } from "@/lib/types";
import { defaultInboundTag, hasXrayInbound } from "@/lib/inbound-tags";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** The inbound-tag control, as its own panel rather than another row in
 * the form.
 *
 * The weight is deliberate. Every other field in these dialogs is
 * self-evidently wrong when it is wrong -- a bad port refuses
 * connections, bad public params fail a handshake. This one is the
 * opposite: a wrong tag produces a config that provisions cleanly,
 * appears correct in every list, and quietly serves customers from
 * another country's exit or from a listener that has never heard of
 * them. It has cost this product a day of investigation and 29
 * customers' worth of misrouted provisioning, so it gets a surface that
 * explains itself instead of a bare input somebody fills in from
 * memory.
 *
 * Three things it has to convey, and each has its own block:
 *
 * 1. what "empty" actually means -- the resolved default, spelled out,
 *    because a blank box is exactly as informative as no field at all;
 * 2. what setting it is *for* -- one relay serving more than one exit,
 *    which is the only reason this exists;
 * 3. the two ways it goes wrong -- a tag the node does not have, and a
 *    change that strands customers already provisioned.
 */
export function InboundTagField({
  protocol,
  transport,
  currentTag,
  /** Existing configs only. On create there is nobody to strand, so the
   * acknowledgement block has nothing to acknowledge. */
  showReprovisionInterlock = false,
}: {
  protocol: Protocol;
  transport?: string | null;
  currentTag?: string | null;
  showReprovisionInterlock?: boolean;
}) {
  const [value, setValue] = useState(currentTag ?? "");
  const fallback = defaultInboundTag(protocol, transport);
  const applies = hasXrayInbound(protocol);
  const dirty = (currentTag ?? "") !== value.trim();
  const resolved = value.trim() || fallback;

  if (!applies) {
    // Not hidden, and not rendered as a disabled input either. An absent
    // field reads as an oversight; this says why there is nothing to
    // set, which is a fact about the protocol and worth knowing.
    return (
      <section className="rounded-lg border border-white/8 bg-muted/20 p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4 text-muted-foreground" />
          Inbound routing
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Not applicable to this protocol. Inbound tags name listeners inside the node&apos;s Xray
          process; this one runs as its own daemon and has none.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary/[0.04] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <GitBranch className="size-4 text-primary" />
          Inbound routing
        </div>
        {/* The resolved value, always visible. "Empty" is not a state an
            operator can reason about; "vless-in" is. */}
        <span className="rounded-md bg-background/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          serves on <span className="text-foreground">{resolved}</span>
          {!value.trim() && " (node default)"}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="inboundTag">Inbound tag</Label>
        <Input
          id="inboundTag"
          name="inboundTag"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={fallback ?? ""}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <p className="text-xs text-muted-foreground">
          Leave empty for this node&apos;s default listener, <code className="font-mono">{fallback}</code>,
          which is what every ordinary node uses. Set it only when a node runs more than one inbound of
          the same protocol.
        </p>
      </div>

      <div className="flex gap-2 rounded-md bg-background/40 p-2.5 text-xs text-muted-foreground">
        <Info className="mt-px size-3.5 shrink-0 text-primary" />
        <p>
          <span className="text-foreground">What it is for:</span> one relay serving more than one exit
          country. A relayed route&apos;s Xray rule matches on the entry inbound tag and nothing else, so
          two configs on one tag means the second route&apos;s traffic leaves through the first
          route&apos;s exit -- provisioned, listed in the customer&apos;s picker, and egressing from the
          wrong country with nothing reporting it. A second listener with its own tag is what keeps them
          apart.
        </p>
      </div>

      <div className="flex gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.06] p-2.5 text-xs text-amber-200/90">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-400" />
        <p>
          <span className="font-medium text-amber-100">This tag must already exist in the node&apos;s Xray
          config.</span>{" "}
          The control plane cannot check that -- the agent is started with one tag per protocol and never
          reads Xray&apos;s config, so there is no way to ask it what listeners the node has. A tag naming
          one that was never created is accepted here and fails on the node when a customer dials it, as
          &quot;invalid request user id&quot;. Add the listener first.
        </p>
      </div>

      {showReprovisionInterlock && dirty && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/[0.07] p-2.5 text-xs">
          <Checkbox name="confirmReprovision" className="mt-px" />
          <span className="text-muted-foreground">
            <span className="font-medium text-foreground">
              I understand this strands customers already provisioned on this config.
            </span>{" "}
            Their credentials live on the old inbound and moving the config does not move them; they will
            get &quot;invalid request user id&quot; until they are re-provisioned, which happens when they
            switch server or when the node reconnects and the control plane re-asserts every user on this
            config&apos;s current tag. The save is refused without this, and the refusal names how many
            customers are affected.
          </span>
        </label>
      )}
    </section>
  );
}
