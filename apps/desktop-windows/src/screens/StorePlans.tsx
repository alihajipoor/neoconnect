import { useEffect, useState } from "react";
import { Check, HardDrive } from "lucide-react";

import { buyIapPlan, iapAvailable, loadIapPlans, type IapPlan } from "../lib/iap";
import { Card, Message, PillButton } from "../components/ui";
import { Page } from "../components/shell/Page";
import { formatNumber, formatSize } from "../lib/locale-format";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { StillTrying } from "../components/StillTrying";

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
  const { t, language } = useI18n();
  const [plans, setPlans] = useState<IapPlan[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [buying, setBuying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadIapPlans().then((result) => {
      if (cancelled) return;
      if (result.ok) setPlans(result.data);
      else setLoadError(failureText(result, t));
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
        setError(failureText(result, t));
        return;
      }
      onActivated();
    } finally {
      setBuying(null);
    }
  }

  // The same card language as Plans, with the store's own prices and
  // nothing else to buy with: no voucher, no card or crypto, no website
  // (guideline 3.1.1). "Prices come from the App Store" only where they
  // do: the Play build is a store build too, and draws this screen.
  return (
    <Page title={t("plans.title")} lede={iapAvailable() ? t("plans.storeLede") : undefined} back={onBack} backAlways backLabel={t("plans.back")} data-store-plans>
      {loadError ? (
        <Message tone="danger">{loadError}</Message>
      ) : plans === null ? (
        <div className="flex flex-col gap-2">
          <p className="nx-wait" role="status">
            <span className="nx-spin" aria-hidden />
            {t("plans.loading")}
          </p>
          <StillTrying waiting />
        </div>
      ) : plans.length === 0 ? (
        <Card>
          {/* Not an error. It is what a customer sees while products are
              still pending review in App Store Connect, and saying
              "something went wrong" would be a lie. */}
          <p className="nx-csub">{t("plans.noneAvailable")}</p>
        </Card>
      ) : (
        <div className="nx-plans">
          {plans.map((plan) => (
            <Card key={plan.productId} className="nx-plan">
              <h3>{plan.name}</h3>
              <div className="nx-price">
                <b>{plan.displayPrice}</b>
                <span>{t("plans.perDays", { days: formatNumber(plan.durationDays, language) })}</span>
              </div>
              <ul className="nx-facts">
                <li>
                  <HardDrive aria-hidden />
                  <span>{t("plans.data")}</span>
                  <b>{plan.dataCapBytes === null ? t("plans.unlimited") : formatSize(plan.dataCapBytes, language)}</b>
                </li>
              </ul>
              <PillButton size="sm" onClick={() => void buy(plan)} disabled={buying !== null} aria-busy={buying === plan.productId || undefined}>
                {buying === plan.productId ? <span className="nx-spin" aria-hidden /> : <Check aria-hidden />}
                {t("plans.buyWithAppStore")}
              </PillButton>
            </Card>
          ))}
        </div>
      )}

      {error ? <Message tone="danger">{error}</Message> : null}
    </Page>
  );
}
