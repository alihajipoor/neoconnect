"use client";

import { MoreHorizontal, Plus } from "lucide-react";
import type { Customer } from "@/lib/types";
import { deleteCustomer } from "./actions";
import { CustomerFormDialog } from "./customer-form-dialog";
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

export function CustomersTable({ customers }: { customers: Customer[] }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Customers</h1>
        <CustomerFormDialog
          trigger={
            <Button size="sm">
              <Plus /> New Customer
            </Button>
          }
        />
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Telegram</TableHead>
              <TableHead>Referral</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No customers yet.
                </TableCell>
              </TableRow>
            ) : (
              customers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell className="font-medium">{customer.email}</TableCell>
                  <TableCell>{customer.telegramId ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{customer.referralCode ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={customer.status === "ACTIVE" ? "success" : "secondary"}>
                      {customer.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(customer.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label="Row actions">
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <CustomerFormDialog
                          customer={customer}
                          trigger={
                            <DropdownMenuItem onSelect={(e) => e.preventDefault()}>Edit</DropdownMenuItem>
                          }
                        />
                        <DeleteConfirm
                          trigger={
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={(e) => e.preventDefault()}
                            >
                              Delete
                            </DropdownMenuItem>
                          }
                          title="Delete this customer?"
                          description={`This permanently removes ${customer.email}. This can't be undone.`}
                          successMessage="Customer deleted"
                          onConfirm={() => deleteCustomer(customer.id)}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
