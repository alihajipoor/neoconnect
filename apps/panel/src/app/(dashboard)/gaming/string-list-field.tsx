"use client";

import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * Reads a newline-separated textarea back out of the parent's FormData.
 *
 * Kept next to the field rather than in lib/utils because the split has
 * to agree exactly with what the textarea renders -- one entry per line,
 * trimmed, blanks dropped -- and the two drifting apart is the kind of
 * thing nobody notices until an operator's trailing newline becomes an
 * empty hostname the resolver is asked to match.
 */
export const toList = (v: FormDataEntryValue | null) =>
  String(v ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * One string list per textarea, one entry per line, with the explanation
 * carried underneath rather than in an operator's head.
 *
 * Modelled on `protocol-configs/inbound-tag-field.tsx`, for the same
 * reason it exists: these lists are the class of field that is accepted
 * by every layer when it is wrong and looks configured forever. A realm
 * server typed into `hostnames`, or a patch CDN missing from
 * `excludeHostnames`, produces no error anywhere -- the first quietly
 * does nothing, the second quietly bills a customer's metered cap for a
 * multi-gigabyte download. So the hint under each list is the field, and
 * the textarea is just how it gets typed.
 */
export function StringListField({
  id,
  name,
  label,
  hint,
  placeholder,
  defaultValue = [],
  disabled = false,
}: {
  id: string;
  name: string;
  label: string;
  hint: React.ReactNode;
  placeholder?: string;
  defaultValue?: string[];
  disabled?: boolean;
}) {
  const [value, setValue] = useState(defaultValue.join("\n"));
  const count = toList(value).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={id}>{label}</Label>
        {/* The count, always visible. An operator scanning a long
            textarea cannot tell 6 entries from 7, and these lists are
            edited by pasting. */}
        <span className="text-[11px] text-muted-foreground">
          {count === 0 ? "empty" : `${count} ${count === 1 ? "entry" : "entries"}`}
        </span>
      </div>
      <Textarea
        id={id}
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className="min-h-20 font-mono text-xs"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
