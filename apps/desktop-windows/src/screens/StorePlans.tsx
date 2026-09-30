import { useEffect, useState } from "react";
import { ArrowLeft, Check, HardDrive, Loader2 } from "lucide-react";

import { buyIapPlan, loadIapPlans, type IapPlan } from "../lib/iap";
import { formatBytes } from "../lib/utils";
import { Button, Card } from "../components/ui";
import { Logo } from "../components/Logo";
import { useI18n } from "../lib/i18n";

/** Buying a plan on iPhone, through the App Store.
 *
 * A separate screen from Plans rather than a branch inside it, and that
 * is not tidiness. Plans carries the web checkout and the voucher
 * field, both of which Apple's guideline 3.1.1 prohibits in an App
 * Store build -- and both of which our release pipeline asserts are
 * absent from the bundle by counting bytes. A shared screen with the
 * purchase paths behind a flag would still ship them.
 *
 * Every price here comes from StoreKit, never from our own `priceUsd`.
 * Apple charges in the customer's currency at its own price points, so
 * showing ours would be the wrong number in the wrong currency almost
 * everywhere, and Apple requires its price to be the displayed one.
 */
export function StorePlans({
  onActivated,
  onBack,
}: {
  onActivated: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<IapPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadIapPlans().then((result) => {
      if (cancelled) return;
      if (result.ok) setPlans(result.data);
      else setLoadError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function buy(plan: IapPlan) {
    setError(null);
    setBuying(plan.productId);
    try {
      const result = await buyIapPlan(plan.productId);
      // Cancelled. The customer closed Apple's sheet and knows they did;
      // an error here would be both wrong and alarming.
      if (result === null) return;
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onActivated();
    } finally {
      setBuying(null);
    }
  }

  return (
    <div className="glow-backdrop flex h-full flex-col overflow-y-auto p-6">
      <button
        type="button"
        onClick={onBack}
        className="press mb-4 flex items-center gap-2 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {t("plans.back")}
      </button>

      <div className="animate-rise mb-6 flex flex-col items-center gap-2">
        <Logo className="scale-90" />
        <h1 className="text-lg font-semibold">{t("plans.title")}</h1>
      </div>

      {loadError ? (
        <Card className="animate-rise">
          <p role="alert" className="text-sm text-destructive">
            {loadError}
          </p>
        </Card>
      ) : plans === null ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : plans.length === 0 ? (
        <Card className="animate-rise">
          {/* Not an error. It is what a customer sees while products are
              still pending review in App Store Connect, and saying
              "something went wrong" would be a lie. */}
          <p className="text-sm text-muted-foreground">{t("plans.noneAvailable")}</p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {plans.map((plan, i) => (
            <Card
              key={plan.productId}
              className="animate-rise"
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="text-base font-semibold">{plan.name}</h2>
                <span className="text-brand-gradient text-xl font-semibold tabular-nums">
                  {plan.displayPrice}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("plans.perDays", { days: plan.durationDays })}
              </p>

              <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                <li className="flex items-center gap-2">
                  <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                  {plan.dataCapBytes === null
                    ? t("plans.unlimited")
                    : formatBytes(plan.dataCapBytes)}
                </li>
              </ul>

              <Button
                onClick={() => void buy(plan)}
                disabled={buying !== null}
                className="mt-4 w-full justify-center gap-2"
              >
                {buying === plan.productId ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                {t("plans.buyWithAppStore")}
              </Button>
            </Card>
          ))}
        </div>
      )}

      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
