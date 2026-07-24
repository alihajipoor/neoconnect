"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { setupMfaAction, enableMfaAction, disableMfaAction, type MfaSetupResult } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function SecurityCard({ email, initialMfaEnabled }: { email: string; initialMfaEnabled: boolean }) {
  const [mfaEnabled, setMfaEnabled] = useState(initialMfaEnabled);
  const [setupData, setSetupData] = useState<MfaSetupResult | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleStartSetup() {
    startTransition(async () => {
      const result = await setupMfaAction();
      if (result.ok) {
        setSetupData(result.data);
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleConfirmEnable(formData: FormData) {
    const code = String(formData.get("code") ?? "");
    startTransition(async () => {
      const result = await enableMfaAction(code);
      if (result.ok) {
        toast.success("Two-factor authentication enabled");
        setMfaEnabled(true);
        setSetupData(null);
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleDisable(formData: FormData) {
    const password = String(formData.get("password") ?? "");
    startTransition(async () => {
      const result = await disableMfaAction(password);
      if (result.ok) {
        toast.success("Two-factor authentication disabled");
        setMfaEnabled(false);
        setDisableOpen(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card className="border-white/10 bg-card/80">
      <CardHeader>
        <CardTitle className="text-lg">Two-factor authentication</CardTitle>
        <CardDescription>
          Require a 6-digit code from an authenticator app in addition to your password for {email}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {setupData ? (
          <form action={handleConfirmEnable} className="flex flex-col gap-4">
            <div className="flex flex-col items-center gap-3 rounded-lg border border-white/10 bg-background/40 p-4">
              {/* Server-generated data: URI, not a static asset -- an <img> is fine here. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setupData.qrCodeDataUrl} alt="MFA QR code" className="size-40 rounded-md bg-white p-2" />
              <p className="text-center text-xs text-muted-foreground">
                Scan with your authenticator app, or enter this code manually:
              </p>
              <code className="rounded bg-white/5 px-2 py-1 text-sm tracking-widest">{setupData.secret}</code>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">Confirm with a code from your app</Label>
              <Input
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                pattern="[0-9]{6}"
                required
                autoFocus
                className="text-center text-lg tracking-[0.5em]"
              />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>
                {pending ? "Confirming..." : "Confirm and enable"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setSetupData(null)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </form>
        ) : mfaEnabled ? (
          <div className="flex items-center justify-between">
            <Badge variant="success">Enabled</Badge>
            <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
              <DialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  Disable
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Disable two-factor authentication</DialogTitle>
                  <DialogDescription>
                    Enter your password to confirm. This removes the extra login step for your account.
                  </DialogDescription>
                </DialogHeader>
                <form action={handleDisable} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      name="password"
                      type="password"
                      autoComplete="current-password"
                      required
                      autoFocus
                    />
                  </div>
                  <DialogFooter>
                    <Button type="submit" variant="destructive" disabled={pending}>
                      {pending ? "Disabling..." : "Disable"}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <Badge variant="secondary">Not enabled</Badge>
            <Button onClick={handleStartSetup} disabled={pending}>
              {pending ? "Starting..." : "Enable two-factor authentication"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
