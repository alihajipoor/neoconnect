"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { toast } from "sonner";
import { signOutDevice } from "./actions";
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

/** Signs one device out, for the customer who lost a phone or whose
 * device limit is held by something they no longer have.
 *
 * Confirmed first: whoever is on that device is cut off mid-connection,
 * and if it is the device the customer is writing in from, support has
 * just taken their VPN away while they were talking. */
export function SignOutDeviceButton({
  customerId,
  sessionId,
  device,
}: {
  customerId: string;
  sessionId: string;
  device: string;
}) {
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await signOutDevice(customerId, sessionId);
      if (!result.ok) toast.error(result.error);
      else toast.success("Device signed out");
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="border border-white/10" disabled={pending}>
          <LogOut /> {pending ? "Signing out..." : "Sign out this device"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out {device}?</AlertDialogTitle>
          <AlertDialogDescription>
            The app on that device is signed out and its VPN credentials stop working, so anything
            connected through it drops now and its device slot is freed. The customer can sign in
            on it again whenever they like -- this is not a block.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirm}>Sign out</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
