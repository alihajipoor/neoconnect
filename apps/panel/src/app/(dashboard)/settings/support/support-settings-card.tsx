"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import type { SupportSettings } from "@/lib/types";
import { updateSupportSettings } from "./actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const DEFAULT_AWAY = "Support is closed right now. Please check back later.";

/** The away switch.
 *
 * Turning it off closes *new* conversations only — anything already
 * running stays open, because cutting somebody off mid-sentence is
 * worse than declining to start. That is stated on the card rather than
 * only in the code, since it is the whole reason the toggle is safe to
 * use freely.
 */
export function SupportSettingsCard({ settings }: { settings: SupportSettings }) {
  const [accepting, setAccepting] = useState(settings.acceptingTickets);
  const [awayMessage, setAwayMessage] = useState(settings.awayMessage ?? "");
  const [replyWithin, setReplyWithin] = useState(String(settings.replyWithinHours ?? 24));
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const hours = Number(replyWithin);
    if (!Number.isInteger(hours) || hours < 1 || hours > 336) {
      toast.error("Reply time must be a whole number of hours, from 1 to 336.");
      return;
    }
    startTransition(async () => {
      const result = await updateSupportSettings({
        acceptingTickets: accepting,
        awayMessage,
        replyWithinHours: hours,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Support settings saved");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Support</CardTitle>
        <CardDescription>
          In-app support is a conversation, not live chat — customers write, you answer when
          you can, and your reply reaches them in the app and by email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <label className="flex items-start gap-2.5 text-sm">
            <Checkbox
              checked={accepting}
              onCheckedChange={(value) => setAccepting(value === true)}
              className="mt-0.5"
            />
            <span>
              Accept new conversations
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Turning this off hides the &ldquo;new message&rdquo; box in the app. Conversations
                already open stay open, and you can still reply to them.
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <Label htmlFor="awayMessage">Away message</Label>
            <Textarea
              id="awayMessage"
              rows={2}
              value={awayMessage}
              onChange={(e) => setAwayMessage(e.target.value)}
              placeholder={DEFAULT_AWAY}
            />
            <p className="text-xs text-muted-foreground">
              Shown in place of the message box while new conversations are closed. Leave it
              empty to use the app&apos;s own wording.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="replyWithinHours">Usual reply time (hours)</Label>
            <Input
              id="replyWithinHours"
              type="number"
              min={1}
              max={336}
              value={replyWithin}
              onChange={(e) => setReplyWithin(e.target.value)}
              className="max-w-32"
            />
            <p className="text-xs text-muted-foreground">
              Shown to the customer when they write, so nobody sits watching an empty thread
              expecting an instant answer. Promise something you can keep.
            </p>
          </div>

          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
