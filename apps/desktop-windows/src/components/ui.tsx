// Small, dependency-free UI primitives -- deliberately not a full
// shadcn/Radix setup like the panel has. v1 screens (login/register/
// dashboard) don't need dialogs/selects/dropdowns, so pulling in that
// machinery here would be pure overhead. Revisit if a later screen
// (route/plan picker) genuinely needs an overlay component.
import type { ButtonHTMLAttributes, InputHTMLAttributes, LabelHTMLAttributes } from "react";
import { cn } from "../lib/utils";

export function Button({
  className,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "destructive" | "ghost" }) {
  const variants = {
    default: "bg-primary text-primary-foreground hover:bg-primary/90",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    ghost: "bg-transparent text-foreground hover:bg-white/5",
  };
  return (
    <button
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-white/10 bg-card/80 p-4 shadow-2xl shadow-black/40", className)}
      {...props}
    />
  );
}
