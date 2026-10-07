"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createCustomer, updateCustomer } from "./actions";
import type { Customer, CustomerStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function CustomerFormDialog({
  customer,
  trigger,
}: {
  customer?: Customer;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(customer);

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = isEdit
        ? await updateCustomer(customer!.id, {
            telegramId: String(formData.get("telegramId") ?? "") || undefined,
            status: formData.get("status") as CustomerStatus,
            // Blank means "leave it alone" -- an edit that didn't touch
            // this field must not send an empty password.
            password: String(formData.get("password") ?? "") || undefined,
          })
        : await createCustomer({
            email: String(formData.get("email") ?? ""),
            password: String(formData.get("password") ?? ""),
            telegramId: String(formData.get("telegramId") ?? "") || undefined,
          });

      if (result.ok) {
        toast.success(isEdit ? "Customer updated" : "Customer created");
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
          <DialogTitle>{isEdit ? "Edit customer" : "New customer"}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          {!isEdit && (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" minLength={8} required />
              </div>
            </>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="telegramId">Telegram ID (optional)</Label>
            <Input id="telegramId" name="telegramId" defaultValue={customer?.telegramId ?? ""} />
          </div>
          {isEdit && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                minLength={8}
                autoComplete="new-password"
                placeholder="Leave blank to keep the current one"
              />
              <p className="text-xs text-muted-foreground">
                Signs the customer out everywhere. Use this when someone is locked out of their email
                and can&apos;t reset it themselves.
              </p>
            </div>
          )}
          {isEdit && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="status">Status</Label>
              <Select name="status" defaultValue={customer!.status}>
                <SelectTrigger id="status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="DISABLED">Disabled</SelectItem>
                </SelectContent>
              </Select>
              {/* What the backend does on save since the DISABLED fix
                  (CustomersService.update): before it, this only blocked
                  new sign-ins and a connected customer stayed connected.
                  Saving a customer who is already Disabled applies it
                  again -- which is how one disabled before that fix gets
                  their credentials switched off. */}
              <p className="text-xs text-muted-foreground">
                Disabled signs the customer out on every device and switches off their VPN credentials on
                the nodes; Active turns back on the ones that were on before. Save again to re-apply.
              </p>
            </div>
          )}
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
