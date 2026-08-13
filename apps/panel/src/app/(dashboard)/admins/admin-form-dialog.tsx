"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createAdmin, updateAdmin } from "./actions";
import type { AdminRole, AdminUser } from "@/lib/types";
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

// RESELLER included so the operator can create one here -- it is the
// only way a reseller account comes into existence.
const ROLES: AdminRole[] = ["SUPERADMIN", "SUPPORT", "BILLING", "RESELLER"];

export function AdminFormDialog({ admin, trigger }: { admin?: AdminUser; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(admin);

  function handleSubmit(formData: FormData) {
    const password = String(formData.get("password") ?? "");
    const role = formData.get("role") as AdminRole;

    startTransition(async () => {
      const result = isEdit
        ? await updateAdmin(admin!.id, {
            password: password || undefined,
            role,
          })
        : await createAdmin({
            email: String(formData.get("email") ?? ""),
            password,
            role,
          });

      if (result.ok) {
        toast.success(isEdit ? "Admin updated" : "Admin created");
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
          <DialogTitle>{isEdit ? "Edit admin" : "New admin"}</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          {!isEdit && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">{isEdit ? "New password (optional)" : "Password"}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              minLength={8}
              required={!isEdit}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="role">Role</Label>
            <Select name="role" defaultValue={admin?.role ?? "SUPPORT"}>
              <SelectTrigger id="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
