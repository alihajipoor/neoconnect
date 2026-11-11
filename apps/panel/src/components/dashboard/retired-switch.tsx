"use client";

import { useId } from "react";
import { Switch } from "@/components/ui/switch";

/** The one switch that brings retired servers back into a list.
 *
 * Retired servers (node status DISABLED) stay in the database because
 * deleting a node wipes its usage history; lists hide them by default
 * and this is how anyone looking for one finds it. Renders nothing when
 * there are none, so it never advertises an empty set. */
export function RetiredSwitch({
  count,
  checked,
  onCheckedChange,
  noun = "servers",
}: {
  count: number;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
  noun?: string;
}) {
  const id = useId();
  if (count === 0) return null;
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-xs text-muted-foreground">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      Show retired {noun} ({count})
    </label>
  );
}
