import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-highlight text-white shadow-[0_0_20px_-4px_var(--primary)]",
        className,
      )}
    >
      <Zap className="size-4.5 fill-current" strokeWidth={2.5} />
    </div>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">Neoxify</span>
    </div>
  );
}
