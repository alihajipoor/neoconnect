import { useState } from "react";
import { Ticket } from "lucide-react";
import { previewVoucher, redeemVoucher } from "../lib/customer";
import type { SubscriptionPlan } from "../lib/types";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { formatNumber, formatSize } from "../lib/locale-format";
import { Card, CardHead, Message, PillButton } from "./ui";
import { StillTrying } from "./StillTrying";

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
  const { t, language } = useI18n();
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
      setError(failureText(result, t));
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
      setError(failureText(result, t));
      return;
    }
    onRedeemed();
  }

  return (
    <Card className="flex flex-col gap-3">
      <CardHead icon={<Ticket />} title={t("voucher.title")} hint={t("voucher.subtitle")} />

      {found ? (
        <div className="flex flex-col gap-3">
          <Message tone="ok">
            <p className="nx-strong">{t("voucher.valid")}</p>
            <p>
              {found.plan.name} ·{" "}
              {found.plan.dataCapBytes === null ? t("dash.unlimited") : formatSize(Number(found.plan.dataCapBytes), language)} ·{" "}
              {formatNumber(found.plan.durationDays, language)} {t("voucher.days")}
            </p>
          </Message>
          <div className="nx-row2">
            <PillButton size="sm" onClick={() => void confirm()} disabled={busy} aria-busy={busy || undefined}>
              {t("voucher.confirm")}
            </PillButton>
            <PillButton variant="ghost" size="sm" onClick={() => setFound(null)} disabled={busy}>
              {t("voucher.cancel")}
            </PillButton>
          </div>
        </div>
      ) : (
        <form onSubmit={check} className="nx-field">
          {/* A visible label: a placeholder alone goes the moment typing
              starts. */}
          <label htmlFor="voucher-code" className="nx-label">
            {t("voucher.placeholder")}
          </label>
          <div className="nx-codebox m-0">
            <input
              id="voucher-code"
              className="nx-input nx-vcode"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              // Codes are read off a screen or a message and typed, so
              // they arrive with whatever spacing the customer used. The
              // server strips it; showing it uppercased as they type is
              // what makes it look like a code rather than a password.
              dir="ltr"
            />
            <PillButton type="submit" variant="ghost" size="sm" disabled={busy || code.trim().length < 4} aria-busy={busy || undefined}>
              {t("voucher.check")}
            </PillButton>
          </div>
        </form>
      )}

      <StillTrying waiting={busy} />
      {error ? <Message tone="danger">{error}</Message> : null}
    </Card>
  );
}
