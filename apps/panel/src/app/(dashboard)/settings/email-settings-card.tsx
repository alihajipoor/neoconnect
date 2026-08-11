"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { updateEmailSettingsAction } from "./actions";
import type { EmailSettings } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function EmailSettingsCard({ settings }: { settings: EmailSettings }) {
  const [pending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    const enabled = formData.get("enabled") === "on";
    const secure = formData.get("secure") === "on";
    const host = String(formData.get("host") ?? "").trim() || undefined;
    const portRaw = String(formData.get("port") ?? "").trim();
    const port = portRaw ? Number(portRaw) : undefined;
    const username = String(formData.get("username") ?? "").trim() || undefined;
    const password = String(formData.get("password") ?? "") || undefined;
    const fromAddress = String(formData.get("fromAddress") ?? "").trim() || undefined;

    if (enabled && (!host || !port || !username || !fromAddress)) {
      toast.error("Host, port, username, and from-address are required to enable email sending.");
      return;
    }

    startTransition(async () => {
      const result = await updateEmailSettingsAction({ enabled, secure, host, port, username, password, fromAddress });
      if (result.ok) {
        toast.success("Email settings saved");
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card className="border-white/10 bg-card/80">
      <CardHeader>
        <CardTitle className="text-lg">Email (SMTP)</CardTitle>
        <CardDescription>
          Your own SMTP server, used for welcome/verification emails, password resets, low-data and
          expiry warnings, and admin announcements. Left disabled, no email is ever sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="enabled" defaultChecked={settings.enabled} />
            Enabled
          </label>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="host">SMTP host</Label>
              <Input id="host" name="host" placeholder="smtp.example.com" defaultValue={settings.host ?? ""} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="port">Port</Label>
              <Input id="port" name="port" type="number" placeholder="587" defaultValue={settings.port ?? ""} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox name="secure" defaultChecked={settings.secure} />
            Use implicit TLS (port 465) -- leave off for STARTTLS on 587
          </label>
          <div className="flex flex-col gap-2">
            <Label htmlFor="username">Username</Label>
            <Input id="username" name="username" defaultValue={settings.username ?? ""} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" placeholder="Leave blank to keep current" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="fromAddress">From address</Label>
            <Input
              id="fromAddress"
              name="fromAddress"
              type="email"
              placeholder="no-reply@neoxify.site"
              defaultValue={settings.fromAddress ?? ""}
            />
          </div>
          <Button type="submit" disabled={pending} className="self-start">
            {pending ? "Saving..." : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
