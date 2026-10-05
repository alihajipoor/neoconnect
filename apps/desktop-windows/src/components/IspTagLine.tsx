import { CircleAlert, CircleCheck } from "lucide-react";
import type { TranslationKey } from "../lib/i18n";
import type { IspTag } from "../lib/types";
import { cn } from "../lib/utils";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** What other people on this customer's network recently saw on a
 * route, as one quiet line under its name.
 *
 * Worded as a report about others, dated, and never as a promise:
 * filtering differs between two people on one ISP and changes day to
 * day, and people in Iran act on what this screen says. The counts are
 * in the tooltip and the accessible name rather than the line, so the
 * row stays readable and the evidence is one hover away.
 *
 * Takes `t` rather than calling the hook, so it renders -- and is tested
 * -- without the provider. */
export function IspTagLine({ tag, t }: { tag: IspTag | null | undefined; t: Translate }) {
  if (!tag) return null;
  const works = tag.code === "worksOnYourIsp";
  const text = t(works ? "loc.ispWorks" : "loc.ispFailing");
  const detail = t("loc.ispCount", { customers: tag.customers, outOf: tag.outOf, hours: tag.windowHours });
  const Icon = works ? CircleCheck : CircleAlert;
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1 text-[11px]", works ? "text-success" : "text-warning")}
      title={detail}
      aria-label={`${text}. ${detail}`}
      data-isp-tag={tag.code}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  );
}
