"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import type { Subscription } from "@/lib/types";
import { formatBytes, parseBytesInput } from "@/lib/utils";
import { setSubscriptionDataCap } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** One customer's data allowance, without editing the plan everyone else
 * is on. The input takes what the plan form takes ("22GB", "512MB"), so
 * the two read the same way. */
export function SetDataCapDialog({
  customerId,
  subscription,
  planCapBytes,
  trigger,
}: {
  customerId: string;
  subscription: Subscription;
  /** The plan's own cap, shown so the operator can see what they are
   * departing from -- and what a renewal will put back. */
  planCapBytes: string | null | undefined;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [unlimited, setUnlimited] = useState(subscription.dataCapBytes === null);
  const current = subscription.dataCapBytes;

  function handleSubmit(formData: FormData) {
    let dataCapBytes: string | null = null;
    if (!unlimited) {
      const parsed = parseBytesInput(String(formData.get("dataCap") ?? ""));
      if (parsed === null || parsed === "0") {
        toast.error('Enter a size like "22GB" or "512MB", or tick Unlimited.');
        return;
      }
      dataCapBytes = parsed;
    }

    startTransition(async () => {
      const result = await setSubscriptionDataCap(customerId, subscription.id, dataCapBytes);
      if (result.ok) {
        toast.success(dataCapBytes === null ? "Data limit removed" : `Data limit set to ${formatBytes(dataCapBytes)}`);
        setOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set data limit</DialogTitle>
          <DialogDescription>
            For this subscription only -- the plan and everyone else on it are unchanged. It applies to the
            current period; renewing or changing plan puts the plan&apos;s limit back
            {planCapBytes === undefined ? "" : ` (${planCapBytes === null ? "unlimited" : formatBytes(planCapBytes)})`}.
          </DialogDescription>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="dataCap">Data limit</Label>
            <Input
              id="dataCap"
              name="dataCap"
              placeholder="22GB"
              defaultValue={current ? formatBytes(current).replace(" ", "") : ""}
              disabled={unlimited}
              required={!unlimited}
              autoFocus
            />
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={unlimited} onCheckedChange={(value) => setUnlimited(value === true)} />
              Unlimited traffic
            </label>
            <p className="text-xs text-muted-foreground">
              Used so far: {formatBytes(subscription.dataUsedBytes)}. A customer already suspended for running out stays
              suspended -- press Resume after raising the limit.
            </p>
          </div>
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
