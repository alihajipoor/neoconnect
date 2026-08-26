"use client";

import { Copy, MoreHorizontal, Plus, Ticket } from "lucide-react";
import { toast } from "sonner";
import type { SubscriptionPlan, VoucherListRow } from "@/lib/types";
import { deleteVoucher } from "./actions";
import { VoucherFormDialog } from "./voucher-form-dialog";
import { DeleteConfirm } from "@/components/dashboard/delete-confirm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function VouchersTable({
  vouchers,
  plans,
}: {
  vouchers: VoucherListRow[];
  plans: SubscriptionPlan[];
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Vouchers</h1>
          <p className="text-sm text-muted-foreground">
            Codes that grant a plan without payment.
          </p>
        </div>
        <VoucherFormDialog
          plans={plans}
          trigger={
            <Button size="sm" disabled={plans.length === 0}>
              <Plus /> New Voucher
            </Button>
          }
        />
      </div>

      {plans.length === 0 && (
        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          Create a plan first — a voucher has to grant something.
        </p>
      )}

      <div className="rounded-lg border border-white/8 bg-card/40">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Note</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {vouchers.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                  <Ticket className="mx-auto mb-2 size-5 opacity-50" />
                  No vouchers yet.
                </TableCell>
              </TableRow>
            )}

            {vouchers.map((voucher) => (
              <TableRow key={voucher.id}>
                <TableCell>
                  <button
                    type="button"
                    onClick={() => copy(voucher.code)}
                    className="group inline-flex items-center gap-1.5 font-mono text-sm"
                    title="Copy code"
                  >
                    {voucher.code}
                    <Copy className="size-3 opacity-0 transition-opacity group-hover:opacity-60" />
                  </button>
                </TableCell>
                <TableCell className="text-sm">{voucher.plan?.name ?? "—"}</TableCell>
                <TableCell className="text-sm tabular-nums">{usageLabel(voucher)}</TableCell>
                <TableCell className="text-sm">
                  {voucher.expiresAt ? formatDay(voucher.expiresAt) : "Never"}
                </TableCell>
                <TableCell>
                  <StatusBadge voucher={voucher} />
                </TableCell>
                <TableCell className="max-w-[16rem] truncate text-sm text-muted-foreground">
                  {voucher.note || "—"}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${voucher.code}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <VoucherFormDialog
                        plans={plans}
                        voucher={voucher}
                        trigger={
                          <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                            Edit
                          </DropdownMenuItem>
                        }
                      />
                      <DeleteConfirm
                        title={`Delete ${voucher.code}?`}
                        description={
                          voucher.redeemedCount > 0
                            ? `This code has been redeemed ${voucher.redeemedCount} time(s). Deleting it also removes that record — switch it off instead if you want to keep the history.`
                            : "This cannot be undone."
                        }
                        onConfirm={() => deleteVoucher(voucher.id)}
                        successMessage={`${voucher.code} deleted`}
                        trigger={
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={(e) => e.preventDefault()}
                          >
                            Delete
                          </DropdownMenuItem>
                        }
                      />
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

/** Redemptions used against whatever limit applies. */
function usageLabel(voucher: VoucherListRow) {
  if (voucher.maxRedemptions === null) return `${voucher.redeemedCount} / ∞`;
  return `${voucher.redeemedCount} / ${voucher.maxRedemptions}`;
}

/** Why a code is or is not usable right now.
 *
 * Three separate reasons a voucher stops working, and they are worth
 * distinguishing: switched off is something the operator did, expired
 * and used up happen on their own. Collapsing them into "inactive"
 * would make an exhausted batch look like a mistake.
 */
function StatusBadge({ voucher }: { voucher: VoucherListRow }) {
  if (!voucher.isActive) return <Badge variant="outline">Off</Badge>;
  if (voucher.expiresAt && new Date(voucher.expiresAt) <= new Date()) {
    return <Badge variant="outline">Expired</Badge>;
  }
  if (voucher.maxRedemptions !== null && voucher.redeemedCount >= voucher.maxRedemptions) {
    return <Badge variant="outline">Used up</Badge>;
  }
  return <Badge>Active</Badge>;
}

function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString();
}

function copy(code: string) {
  void navigator.clipboard
    .writeText(code)
    .then(() => toast.success(`${code} copied`))
    .catch(() => toast.error("Could not copy — select and copy it by hand"));
}
