"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { updateAppLinks } from "./actions";
import type { AppLinks } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const FIELDS = [
  { key: "websiteUrl", label: "Website", placeholder: "https://neoxify.net" },
  { key: "discordUrl", label: "Discord", placeholder: "https://discord.gg/..." },
  { key: "instagramUrl", label: "Instagram", placeholder: "https://instagram.com/..." },
  { key: "telegramUrl", label: "Telegram", placeholder: "https://t.me/..." },
] as const;

/** The links the desktop app shows in its header.
 *
 * Edited here rather than compiled into the app, which is the whole
 * reason this exists: a Discord invite expires and an account gets
 * renamed, and neither should need a new release to fix. Clearing a
 * field removes the button entirely -- the app renders nothing for an
 * empty link rather than a button that goes nowhere.
 */
export function AppLinksCard({ links }: { links: AppLinks }) {
  const [values, setValues] = useState<AppLinks>(links);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    startTransition(async () => {
      const result = await updateAppLinks(values);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setValues(result.data);
      toast.success("Links updated");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Community links</CardTitle>
        <CardDescription>
          Shown in the desktop app&apos;s header. Leave a field empty to hide that button.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {FIELDS.map(({ key, label, placeholder }) => (
            <div key={key} className="flex flex-col gap-2">
              <Label htmlFor={key}>{label}</Label>
              <Input
                id={key}
                type="url"
                inputMode="url"
                placeholder={placeholder}
                value={values[key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Include the full address, starting with https://.
          </p>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving..." : "Save links"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
