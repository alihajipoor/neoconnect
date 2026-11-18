"use client";

import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Copies a block of text exactly as shown. */
export function CopyTextButton({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="max-sm:h-10"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => toast.success("Copied"))
          .catch(() => toast.error("Could not copy"));
      }}
    >
      <Copy /> {label}
    </Button>
  );
}
