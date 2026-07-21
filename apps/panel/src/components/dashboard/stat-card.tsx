import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  icon: Icon,
  accent = "primary",
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  accent?: "primary" | "highlight" | "success";
}) {
  return (
    <Card className="flex-row items-center gap-4 p-5">
      <div
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-xl",
          accent === "primary" && "bg-primary/15 text-primary",
          accent === "highlight" && "bg-highlight/15 text-highlight",
          accent === "success" && "bg-success/15 text-success",
        )}
      >
        <Icon className="size-5" />
      </div>
      <div className="flex flex-col">
        <span className="text-2xl font-semibold tracking-tight">{value}</span>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
    </Card>
  );
}
