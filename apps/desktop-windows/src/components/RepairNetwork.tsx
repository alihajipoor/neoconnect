import { useCallback, useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, Loader2, Minus, ShieldAlert, TriangleAlert, Wrench } from "lucide-react";
import {
  anythingFixed,
  failedSteps,
  indeterminateSteps,
  repairCommandLine,
  repairNetwork,
  type RepairReport,
  type RepairStep,
} from "../lib/repair";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { Button, Card } from "../components/ui";
import { cn } from "../lib/utils";

/** "Repair my network".
 *
 * # Why it looks like this
 *
 * It says what it will do before it does it, and what it found
 * afterwards -- both because the action is not reversible in the
 * customer's mind (it disconnects them, on a machine they are using to
 * get online from a censored network) and because this app does not
 * report a state it has not checked. So there is no "Done" screen: each
 * step reports separately, and a step that could not be checked says
 * "couldn't check" rather than borrowing a tick from the ones that
 * could.
 *
 * # The case it cannot serve
 *
 * The button reaches the helper service, and the machines that need
 * repairing most are exactly the ones where that service is broken. So
 * a failure to reach it is not an error message: it is where the
 * elevated command is handed over, with its real installed path, ready
 * to copy. That is the half of this feature that works when nothing
 * else does.
 */
export function RepairNetwork({
  /** `card` is the Settings pane; `inline` is the compact form offered
   * in the connect-failure path, where somebody who cannot connect is
   * already looking rather than having to think to open Settings. */
  variant = "card",
  onFinished,
}: {
  variant?: "card" | "inline";
  /** Told when a repair finishes, so the screen around this can
   * re-check what it believes about the tunnel. The repair disconnects,
   * and a dashboard still showing "Connected" afterwards would be the
   * exact dishonesty this feature exists to remove. */
  onFinished?: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(variant === "card");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RepairReport | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [command, setCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Nothing may be written into state after this component goes: the
  // repair takes minutes in the worst case, and a customer who navigates
  // away during one should not produce a React warning on their way out.
  const alive = useRef(true);
  useEffect(() => () => {
    alive.current = false;
  }, []);

  const loadCommand = useCallback(async () => {
    const line = await repairCommandLine();
    if (alive.current) setCommand(line);
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setReport(null);
    setUnreachable(null);
    try {
      const result = await repairNetwork();
      if (!alive.current) return;
      setReport(result);
    } catch (err) {
      if (!alive.current) return;
      // Keeps the raw text. It is useless to a customer and essential to
      // whoever they send it to -- and the alternative, a friendly
      // sentence that throws the only record away, is how a report
      // becomes unactionable.
      setUnreachable(String(err));
      void loadCommand();
    } finally {
      if (alive.current) setBusy(false);
      onFinished?.();
    }
  }, [loadCommand, onFinished]);

  async function copyCommand() {
    if (!command) return;
    try {
      await writeText(command);
      setCopied(true);
      window.setTimeout(() => alive.current && setCopied(false), 2000);
    } catch {
      // A clipboard that refuses is not worth an error banner: the
      // command is on screen and can be typed.
    }
  }

  if (variant === "inline" && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="press mt-1 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-highlight underline-offset-2 hover:underline"
      >
        <Wrench className="size-3" />
        {t("repair.inlineCta")}
      </button>
    );
  }

  const body = (
    <div className="flex flex-col gap-3 text-start">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
          <Wrench className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t("repair.title")}</p>
          <p className="text-xs text-muted-foreground">{t("repair.subtitle")}</p>
        </div>
      </div>

      {/* Said before the button, not after it. The promise this makes --
          that it only removes things and never blocks any traffic -- is
          the one somebody in Iran needs in order to press it at all. */}
      <p className="text-xs leading-relaxed text-muted-foreground">{t("repair.explain")}</p>
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        <li className="flex items-start gap-1.5">
          <TriangleAlert className="mt-0.5 size-3 shrink-0 text-highlight" />
          <span>{t("repair.disconnects")}</span>
        </li>
        <li className="flex items-start gap-1.5">
          <ShieldAlert className="mt-0.5 size-3 shrink-0 text-success" />
          <span>{t("repair.safety")}</span>
        </li>
      </ul>

      <Button onClick={() => void run()} disabled={busy} className="justify-center gap-2">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Wrench className="size-4" />}
        {busy ? t("repair.running") : report || unreachable ? t("repair.runAgain") : t("repair.run")}
      </Button>

      {report ? <Result report={report} /> : null}

      {unreachable ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
          <p className="text-xs font-medium text-destructive">{t("repair.noService")}</p>
          <p className="text-xs text-muted-foreground">{t("repair.noServiceHint")}</p>
          {/* Forced left-to-right: a Windows path in a right-to-left
              paragraph is reordered into something that cannot be typed
              back, and this is a line the customer has to reproduce
              exactly. */}
          <code
            className="block overflow-x-auto rounded-md bg-black/40 px-2.5 py-2 font-mono text-[11px] break-all text-foreground"
            data-ltr
            dir="ltr"
          >
            {command ?? "..."}
          </code>
          <Button
            variant="outline"
            onClick={() => void copyCommand()}
            disabled={!command}
            className="justify-center gap-2"
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? t("repair.copied") : t("repair.copyCommand")}
          </Button>
          <details>
            <summary className="cursor-pointer text-[10px] text-muted-foreground select-none">
              {t("err.showDetail")}
            </summary>
            <p className="mt-1 font-mono text-[10px] break-words text-muted-foreground" data-ltr>
              {unreachable}
            </p>
          </details>
        </div>
      ) : null}
    </div>
  );

  return variant === "card" ? <Card className="flex flex-col gap-3">{body}</Card> : (
    <div className="mt-2 rounded-xl border border-white/10 bg-white/3 p-3">{body}</div>
  );
}

/** What the repair found, step by step.
 *
 * A summary line and then every step, rather than only a summary. The
 * summary is what the customer acts on; the list is what they paste to
 * support, and it is also the only thing standing between an honest
 * report and "it says it worked but my internet is still broken".
 */
function Result({ report }: { report: RepairReport }) {
  const { t } = useI18n();
  const failed = failedSteps(report);
  const indeterminate = indeterminateSteps(report);
  // Three outcomes, not two. A step that could not be checked is not a
  // step that failed, and painting it in the destructive colour told
  // customers their repair had not worked when nothing established
  // that -- see `indeterminateSteps`. Only a determined failure is bad
  // news; an unfinished check is a caveat on good news.
  const summaryKey: TranslationKey =
    failed.length > 0
      ? "repair.resultProblems"
      : indeterminate.length > 0
        ? "repair.resultUnverified"
        : anythingFixed(report)
          ? "repair.resultFixed"
          : "repair.resultClean";

  return (
    <div className="flex flex-col gap-2">
      <p
        className={cn(
          "rounded-lg border px-3 py-2 text-xs",
          failed.length > 0
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : indeterminate.length > 0
              ? // The same tone the per-step "Couldn't check" already
                // uses, so the summary and the row it refers to agree.
                "border-highlight/30 bg-highlight/10 text-highlight"
              : "border-success/30 bg-success/10 text-success",
        )}
      >
        {t(summaryKey)}
      </p>
      <ul className="flex flex-col divide-y divide-white/6 rounded-lg border border-white/8">
        {report.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step }: { step: RepairStep }) {
  const { t } = useI18n();
  // The label is looked up by id, and the English one the service sent
  // is the fallback rather than the id itself: a step this build of the
  // app has never heard of should still read as words.
  const labelKey = `repair.step.${step.id}` as TranslationKey;
  const label = t(labelKey);
  const known = label !== labelKey;

  const style = {
    alreadyClean: { key: "repair.stepClean", icon: Minus, tone: "text-muted-foreground" },
    fixed: { key: "repair.stepFixed", icon: Check, tone: "text-success" },
    failed: { key: "repair.stepFailed", icon: TriangleAlert, tone: "text-destructive" },
    unknown: { key: "repair.stepUnknown", icon: ShieldAlert, tone: "text-highlight" },
  }[step.outcome];
  const Icon = style.icon;

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", style.tone)} />
      <div className="min-w-0 flex-1">
        <p className="text-xs">{known ? label : step.label}</p>
        {/* The service's own words, kept out of the way. They are
            English and technical, which is why they are not the
            headline -- but they are the only record of *why* a step
            could not finish, and dropping them would leave a support
            conversation with nothing to work from. */}
        {step.detail && step.outcome !== "fixed" ? (
          <p className="mt-0.5 font-mono text-[10px] break-words text-muted-foreground" data-ltr>
            {step.detail}
          </p>
        ) : null}
      </div>
      <span className={cn("shrink-0 text-[10px] font-medium", style.tone)}>
        {t(style.key as TranslationKey)}
      </span>
    </li>
  );
}
