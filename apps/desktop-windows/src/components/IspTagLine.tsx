import { Check, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import type { Language, TranslationKey } from "../lib/i18n";
import { formatNumber } from "../lib/locale-format";
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
 * `look="pearl"` is the desktop's locations panel: a short line ("Works
 * for others here") that fits its rows, with the full sentence in the
 * tooltip and the accessible name, and colour from pearl.css's ink tokens
 * -- the hues the icon keeps are below AA as text.
 *
 * `look="icon"` is the redesigned list's protocol row: a check or an alert
 * in a tinted circle, the full sentence its accessible name and tooltip --
 * an image role, so a screen reader reads it (a label on a bare span is
 * ignored).
 *
 * Takes `t` rather than calling the hook, so it renders -- and is tested
 * -- without the provider; `language` writes the counts in its digits. */
export function IspTagLine({
  tag,
  t,
  look,
  language = "en",
}: {
  tag: IspTag | null | undefined;
  t: Translate;
  look?: "pearl" | "icon";
  language?: Language;
}) {
  if (!tag) return null;
  const works = tag.code === "worksOnYourIsp";
  const text = t(works ? "loc.ispWorks" : "loc.ispFailing");
  const n = (value: number) => formatNumber(value, language);
  const detail = t("loc.ispCount", { customers: n(tag.customers), outOf: n(tag.outOf), hours: n(tag.windowHours) });
  const Icon = works ? CircleCheck : CircleAlert;
  if (look === "icon") {
    return (
      <span className={cn("nx-ispi", !works && "fail")} role="img" title={`${text}. ${detail}`} aria-label={`${text}. ${detail}`} data-isp-tag={tag.code}>
        {works ? <Check aria-hidden /> : <TriangleAlert aria-hidden />}
      </span>
    );
  }
  const pearl = look === "pearl";
  return (
    <span
      className={cn("flex min-w-0 items-center gap-1", !pearl && "text-[11px]", !pearl && (works ? "text-success" : "text-warning"))}
      title={pearl ? `${text}. ${detail}` : detail}
      aria-label={`${text}. ${detail}`}
      data-isp-tag={tag.code}
    >
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{pearl ? t(works ? "loc.ispWorksShort" : "loc.ispFailingShort") : text}</span>
    </span>
  );
}
