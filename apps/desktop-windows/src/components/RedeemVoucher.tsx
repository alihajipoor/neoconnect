import { useState } from "react";
import { Check, Loader2, Ticket } from "lucide-react";
import { previewVoucher, redeemVoucher } from "../lib/customer";
import type { SubscriptionPlan } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { useI18n } from "../lib/i18n";
import { Button, Card, Input } from "./ui";

/** Redeeming a code, as a two-step confirm rather than one action.
 *
 * The check and the spend are separate calls on purpose. A voucher can
 * be one-time, so converting it the instant somebody finishes typing --
 * or mistypes and retries -- is a bad trade for saving one click. This
 * shows what the code is worth and then asks.
 */
/** `initialCode` seeds the field from a voucher link the customer
 * followed, so the common path is arrive-and-confirm rather than
 * arrive-and-retype-twelve-characters -- which is most of why the link
 * exists instead of just handing out the code.
 *
 * Optional, and unused by the desktop and Android clients, which have no
 * link to arrive from. Adding it as an optional prop rather than
 * changing the signature keeps those two compiling untouched. */
export function RedeemVoucher({
  onRedeemed,
  initialCode,
}: {
  onRedeemed: () => void;
  initialCode?: string;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState(initialCode ?? "");
  const [found, setFound] = useState<{ plan: SubscriptionPlan; expiresAt: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await previewVoucher(code);
    setBusy(false);

    if (!result.ok) {
      setFound(null);
      setError(result.error);
      return;
    }
    setFound({ plan: result.data.plan, expiresAt: result.data.expiresAt });
  }

  async function confirm() {
    setError(null);
    setBusy(true);
    const result = await redeemVoucher(code);
    setBusy(false);

    if (!result.ok) {
      // The code may have been used up between checking and confirming,
      // which is exactly why the server decides this and not the check
      // above. Clearing the preview sends them back to the input rather
      // than leaving a confirm button that will keep failing.
      setFound(null);
      setError(result.error);
      return;
    }
    onRedeemed();
  }

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
          <Ticket className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t("voucher.title")}</p>
          <p className="text-xs text-muted-foreground">{t("voucher.subtitle")}</p>
        </div>
      </div>

      {found ? (
        <div className="flex flex-col gap-3">
          <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
              <Check className="size-3.5" />
              {t("voucher.valid")}
            </p>
            <p className="mt-1 text-sm font-semibold">{found.plan.name}</p>
            <p className="text-xs text-muted-foreground">
              {found.plan.dataCapBytes === null
                ? t("dash.unlimited")
                : formatBytes(Number(found.plan.dataCapBytes))}{" "}
              · {found.plan.durationDays}{" "}
              {t("voucher.days")}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void confirm()} disabled={busy} className="flex-1 justify-center gap-2">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("voucher.confirm")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => setFound(null)}
              disabled={busy}
              className="border border-white/10"
            >
              {t("voucher.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={check} className="flex gap-2">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder={t("voucher.placeholder")}
            autoComplete="off"
            spellCheck={false}
            // Codes are read off a screen or a message and typed, so
            // they arrive with whatever spacing the customer used. The
            // server strips it; showing it uppercased as they type is
            // what makes it look like a code rather than a password.
            className="font-mono tracking-wider"
            dir="ltr"
          />
          <Button type="submit" disabled={busy || code.trim().length < 4} className="shrink-0 gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t("voucher.check")}
          </Button>
        </form>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </Card>
  );
}
