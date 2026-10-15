"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { moveAddressWithRecoveryCode } from "./actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Moving an account to a new address on its recovery code alone, for a
 * customer who cannot open the mailbox it was made with
 * (docs/relay-last-resort.md, R3.9). */
export function MoveAddressCard({ customerId }: { customerId: string }) {
  const [pending, startTransition] = useTransition();
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [issued, setIssued] = useState<string | null>(null);

  function submit() {
    startTransition(async () => {
      const result = await moveAddressWithRecoveryCode(customerId, code.trim(), email.trim());
      if (result.ok) {
        setIssued(result.data.recoveryCode);
        setCode("");
        toast.success(`Moved to ${result.data.email}. The address is unconfirmed until they verify it.`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Move to a new address (recovery code)</CardTitle>
        <CardDescription>
          The customer reads you their recovery code. The account moves to the new address, unconfirmed, and gets a
          new recovery code to pass back to them; the old one is spent.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="move-code">Recovery code</Label>
          <Input id="move-code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="move-email">New address</Label>
          <Input id="move-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <Button onClick={submit} disabled={pending || !code || !email} className="self-start">
          {pending ? "Moving..." : "Move account"}
        </Button>
        {issued && (
          <p className="text-sm">
            New recovery code, shown once: <code className="font-mono">{issued}</code>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
