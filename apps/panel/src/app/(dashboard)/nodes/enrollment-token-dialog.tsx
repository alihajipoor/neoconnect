"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { issueEnrollmentToken, type EnrollmentToken } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function EnrollmentTokenDialog({ nodeId, nodeName, trigger }: { nodeId: string; nodeName: string; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<EnrollmentToken | null>(null);
  const [pending, startTransition] = useTransition();

  function handleGenerate() {
    startTransition(async () => {
      const res = await issueEnrollmentToken(nodeId);
      if (res.ok) {
        setResult(res.data);
      } else {
        toast.error(res.error);
      }
    });
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setResult(null);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enrollment token for {nodeName}</DialogTitle>
          <DialogDescription>
            Paste this into the installer on the VPS (`sudo ./install.sh`, choose VPN Agent Node). It&apos;s
            shown once and expires in an hour.
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-3">
            <code className="break-all rounded bg-white/5 px-3 py-2 text-xs">{result.token}</code>
            <p className="text-xs text-muted-foreground">
              Expires {new Date(result.expiresAt).toLocaleString()}
            </p>
          </div>
        ) : (
          <Button onClick={handleGenerate} disabled={pending}>
            {pending ? "Generating..." : "Generate token"}
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
