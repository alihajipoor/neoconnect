"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Re-reads the page from the server in place.
 *
 * A button rather than a timer: no page in the panel refreshes itself,
 * and one that did would keep hitting the API from a forgotten tab. The
 * list is cheap to read again by hand when someone is actually looking. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="ghost"
      size="sm"
      className="border border-white/10"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      <RefreshCw className={cn(pending && "animate-spin")} /> Refresh
    </Button>
  );
}
