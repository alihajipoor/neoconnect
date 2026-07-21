"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { AdminUser } from "@/lib/types";
import { deleteAdmin } from "./actions";
import { AdminFormDialog } from "./admin-form-dialog";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function AdminsTable({ admins, currentAdminId }: { admins: AdminUser[]; currentAdminId: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admins</h1>
        <AdminFormDialog
          trigger={
            <Button size="sm">
              <Plus /> New Admin
            </Button>
          }
        />
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {admins.map((admin) => (
              <TableRow key={admin.id}>
                <TableCell className="font-medium">
                  {admin.email}
                  {admin.id === currentAdminId && (
                    <Badge variant="outline" className="ml-2">
                      you
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{admin.role}</Badge>
                </TableCell>
                <TableCell>{new Date(admin.createdAt).toLocaleDateString()}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Row actions">
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <AdminFormDialog
                        admin={admin}
                        trigger={
                          <DropdownMenuItem onSelect={(e) => e.preventDefault()}>Edit</DropdownMenuItem>
                        }
                      />
                      {admin.id !== currentAdminId && (
                        <DeleteConfirm
                          trigger={
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={(e) => e.preventDefault()}
                            >
                              Delete
                            </DropdownMenuItem>
                          }
                          title="Delete this admin?"
                          description={`This permanently removes ${admin.email}'s access.`}
                          successMessage="Admin deleted"
                          onConfirm={() => deleteAdmin(admin.id)}
                        />
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
