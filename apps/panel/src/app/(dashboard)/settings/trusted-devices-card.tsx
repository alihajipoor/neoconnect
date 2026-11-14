"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { removeAllTrustedDevicesAction, removeTrustedDeviceAction } from "./actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface TrustedDevice {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** The UTC day, the same on the server and in the browser, so the first
 * render and hydration agree. */
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

/** Browsers that skip the code step (never the password) until their
 * fixed expiry. One column of stacked rows, so it reads on a phone. */
export function TrustedDevicesCard({ devices, currentId }: { devices: TrustedDevice[]; currentId?: string }) {
  const [pending, startTransition] = useTransition();

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) toast.success(done);
      else toast.error(result.error ?? "Could not remove it. Please try again.");
    });
  }

  return (
    <Card className="border-white/10 bg-card/80">
      <CardHeader>
        <CardTitle className="text-lg">Trusted devices</CardTitle>
        <CardDescription>
          Browsers that skip the two-factor code for 30 days after you ticked &quot;Trust this device&quot;. They
          still need your password. Changing your password or two-factor removes them all. Removing a device makes
          it ask for the code again next time; it does not sign out a session already open there. To end those
          too, sign out: that ends your sessions on every device.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trusted devices.</p>
        ) : (
          <>
            <ul className="flex flex-col divide-y divide-white/10 rounded-lg border border-white/10">
              {devices.map((d) => (
                <li key={d.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-words">{d.label}</span>
                      {d.id === currentId ? <Badge variant="secondary">This device</Badge> : null}
                    </div>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
                      <dt>Added</dt>
                      <dd>{day(d.createdAt)}</dd>
                      <dt>Last used</dt>
                      <dd>{day(d.lastUsedAt)}</dd>
                      <dt>Expires</dt>
                      <dd>{day(d.expiresAt)}</dd>
                    </dl>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="self-start sm:self-center"
                    disabled={pending}
                    onClick={() => run(() => removeTrustedDeviceAction(d.id), "Device removed")}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              variant="destructive"
              size="sm"
              className="self-start"
              disabled={pending}
              onClick={() => run(removeAllTrustedDevicesAction, "All trusted devices removed")}
            >
              Remove all
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
