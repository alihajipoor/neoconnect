"use client";

import { useTransition } from "react";
import { MailCheck } from "lucide-react";
import { toast } from "sonner";
import { markCustomerEmailVerified } from "./actions";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/** For the customer whose verification code never arrived. Confirmed
 * first: it vouches for an address nobody proved, and it can grant the
 * trial, so it should not be one stray click. */
export function MarkVerifiedButton({ customerId, email }: { customerId: string; email: string }) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await markCustomerEmailVerified(customerId);
      if (!result.ok) toast.error(result.error);
      else if (result.data.alreadyVerified) toast.success("Already verified");
      else toast.success("Email marked verified");
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="border border-white/10" disabled={pending}>
          <MailCheck /> {pending ? "Verifying..." : "Mark verified"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark this email verified?</AlertDialogTitle>
          <AlertDialogDescription>
            {email} has not confirmed the address themselves. Marking it verified unlocks the account the same way
            entering the code would -- including the free trial if trial mode is on, and their referrer&apos;s
            notice. A disabled account stays disabled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>Mark verified</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
