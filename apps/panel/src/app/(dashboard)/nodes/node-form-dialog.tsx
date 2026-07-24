"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { createNode } from "./actions";
import type { NodeRole } from "@/lib/types";
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

const ROLES: NodeRole[] = ["STANDALONE", "RELAY", "EXIT"];

// Create-only -- the backend has no PATCH /nodes/:id (role/region/IP are
// fixed at enrollment time; changing them for real would mean re-running
// the installer against a different box, not editing a database row).
export function NodeFormDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await createNode({
        name: String(formData.get("name") ?? ""),
        role: formData.get("role") as NodeRole,
        region: String(formData.get("region") ?? ""),
        publicIp: String(formData.get("publicIp") ?? ""),
      });

      if (result.ok) {
        toast.success("Node created -- generate an enrollment token next to add it for real");
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
          <DialogTitle>New node</DialogTitle>
        </DialogHeader>
        <form action={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required autoFocus />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="role">Role</Label>
            <Select name="role" defaultValue="STANDALONE">
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
          <div className="flex flex-col gap-2">
            <Label htmlFor="region">Region</Label>
            <Input id="region" name="region" placeholder="e.g. de-frankfurt" required />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="publicIp">Public IP</Label>
            <Input id="publicIp" name="publicIp" placeholder="203.0.113.10" required />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
