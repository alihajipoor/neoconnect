import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy, CreditCard, Gauge, HardDrive, MonitorSmartphone, Wallet } from "lucide-react";
import { createSubscription, getPlans, getSubscriptions, startPayment } from "../lib/customer";
import type { PaymentProvider, PaymentStart, Subscription, SubscriptionPlan } from "../lib/types";
import { Card, Message, PillButton, Tag } from "../components/ui";
import { Page } from "../components/shell/Page";
import { RedeemVoucher } from "../components/RedeemVoucher";
import { formatAgo, formatDate, formatNumber, formatPrice, formatSize } from "../lib/locale-format";
import { loadSnapshot } from "../lib/credential-cache";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { StillTrying } from "../components/StillTrying";
import { useRelayMode } from "../components/BackupRoute";

type Stage =
  | { name: "choosing" }
  | { name: "starting" }
  | { name: "awaiting"; payment: PaymentStart };

/** How often to re-check whether the subscription has gone active.
 *
 * Payment is confirmed by the provider's webhook, not by anything this
 * app can observe -- a card payment happens in the system browser and a
 * crypto payment happens on a blockchain. Polling our own subscription
 * is the only honest way to know, and it's also what makes the flow work
 * when the customer pays from a different device entirely. */
const POLL_MS = 4000;

/** One "what you get" row: icon, label, value -- the value at the inline
 * end so the figures line up down the card and compare at a glance. */
function PlanFact({ icon: Icon, label, value }: { icon: typeof HardDrive; label: string; value: string }) {
  return (
    <li>
      <Icon aria-hidden />
      <span>{label}</span>
      <b>{value}</b>
    </li>
  );
}

export function Plans({
  onActivated,
  onBack,
  voucherCode,
  notice,
}: {
  onActivated: () => void;
  onBack: () => void;
  /** Prefills the redeem field, set by the web portal when the customer
   * arrived on a /r/CODE link. Undefined in the desktop and Android
   * clients, which have no link to arrive from. */
  voucherCode?: string;
  /** A sentence above everything: what brought the customer here. Set
   * after a sign-up through the relay of last resort, which can take an
   * Ultimate voucher and nothing else until the address is confirmed. */
  notice?: string | null;
}) {
  const { t, language } = useI18n();
  // Through the relay of last resort a voucher can be redeemed, and card
  // or crypto checkout cannot: the checkout page is the provider's, and
  // the relay does not reach it. Said, and the buttons held, rather than
  // starting a payment nobody could finish.
  // TODO(relay checkout): the payment-only path (docs/relay-last-resort.md,
  // "Not done here") is a later infra item; until then this stays.
  const { active: viaRelay, status: relayStatus } = useRelayMode();
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The backend keeps the plan list from an account whose address is not
  // confirmed -- a relay sign-up's (R3.3) -- with 403 VERIFY_EMAIL. Not a
  // fault: such an account takes an Ultimate voucher, above, and nothing
  // else until it confirms. So the calm reminder, never the red error
  // banner, and no plan list left loading for ever.
  const [limited, setLimited] = useState(false);
  const [stage, setStage] = useState<Stage>({ name: "choosing" });
  const [copied, setCopied] = useState(false);
  // The plan this device last saw, from its own cache: no request of its
  // own, and only what the cache holds -- the plan's name comes from the
  // list once it arrives. Said as what the device last saw, and when, as
  // Activity says it: the cache can be days old, and the plan changed or
  // ended on another device since.
  const [current, setCurrent] = useState<{ sub: Subscription; savedAt: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadSnapshot()
      .catch(() => null)
      .then((snapshot) => {
        const sub = snapshot?.subscription;
        if (alive && sub?.status === "ACTIVE") setCurrent({ sub, savedAt: snapshot?.savedAt ?? null });
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    void getPlans().then((result) => {
      if (result.ok) setPlans(result.data);
      else if (result.code === "VERIFY_EMAIL") setLimited(true);
      else setError(failureText(result, t));
    });
  }, []);

  // Runs only while a payment is outstanding. The customer may complete
  // it in a browser, on their phone, or not at all, so this watches
  // rather than waits for a return value.
  useEffect(() => {
    if (stage.name !== "awaiting") return;
    const timer = setInterval(async () => {
      const result = await getSubscriptions();
      if (result.ok && result.data.some((s) => s.status === "ACTIVE")) {
        clearInterval(timer);
        onActivated();
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [stage, onActivated]);

  async function buy(plan: SubscriptionPlan, provider: PaymentProvider) {
    setError(null);
    setStage({ name: "starting" });

    const created = await createSubscription(plan.id);
    if (!created.ok) {
      setError(failureText(created, t));
      setStage({ name: "choosing" });
      return;
    }

    const payment = await startPayment(created.data.id, provider);
    if (!payment.ok) {
      setError(failureText(payment, t));
      setStage({ name: "choosing" });
      return;
    }

    // Cards open Stripe's own page in the system browser: card details
    // never touch this process, and 3-D Secure is Stripe's problem
    // rather than ours.
    // Branch on the payload, not the provider name: anything that hands
    // back a URL gets opened.
    if ("checkoutUrl" in payment.data) {
      // A failure here must not stop the screen advancing. The payment
      // is already created and the URL is valid -- only the browser
      // handoff failed -- and the waiting screen is where "Reopen
      // payment page" lives. Letting this reject left the app on the
      // spinner forever with no error and no way back.
      try {
        await openUrl(payment.data.checkoutUrl);
      } catch {
        setError(t("plans.browserFailed"));
      }
    }
    setStage({ name: "awaiting", payment: payment.data });
  }

  /** Retry the browser handoff, reporting failure instead of swallowing
   * it -- a `void`-ed rejection here meant the button appeared to do
   * nothing at all, which is indistinguishable from the app being
   * broken. */
  async function reopenCheckout(url: string) {
    setError(null);
    try {
      await openUrl(url);
    } catch {
      setError(t("plans.browserFailed"));
    }
  }

  async function copyAddress(address: string) {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (stage.name === "awaiting") {
    const payment = stage.payment;
    return (
      <Page title={t("plans.waiting")} back={onBack} backAlways backLabel={t("plans.back")} data-plans-awaiting>
        <div className="nx-stack">
          <Card className="flex flex-col gap-3">
            {/* Reachable now that a failed browser handoff still lands
                here rather than stalling on the spinner. */}
            {error ? <Message tone="danger">{error}</Message> : null}
            {"checkoutUrl" in payment ? (
              <>
                <p className="nx-csub">{t("plans.finishInBrowser")}</p>
                <PillButton variant="ghost" size="sm" onClick={() => void reopenCheckout(payment.checkoutUrl)}>
                  {t("plans.reopen")}
                </PillButton>
              </>
            ) : (
              <>
                <p className="nx-csub">{t("plans.sendExactly")}</p>
                <div className="nx-pay">
                  <span>{t("plans.amount")}</span>
                  <b dir="ltr">
                    {payment.payAmount} {payment.payCurrency.toUpperCase()}
                  </b>
                </div>
                <div className="nx-pay">
                  <span>{t("plans.toAddress")}</span>
                  <b dir="ltr">{payment.payAddress}</b>
                </div>
                <PillButton variant="ghost" size="sm" onClick={() => void copyAddress(payment.payAddress)}>
                  {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
                  {copied ? t("plans.copied") : t("plans.copyAddress")}
                </PillButton>
              </>
            )}
            <p className="nx-wait" role="status">
              <span className="nx-spin" aria-hidden />
              {t("plans.checking")}
            </p>
          </Card>
        </div>
      </Page>
    );
  }

  // Not once its end date has passed: "Current plan, expires" a day gone
  // is not a fact. A date that cannot be read is not shown either.
  const now = Date.now();
  const shown = current && Date.parse(current.sub.expireAt) > now ? current : null;
  const currentPlan = shown ? (plans?.find((plan) => plan.id === shown.sub.planId) ?? null) : null;

  return (
    <Page title={t("plans.title")} lede={t(shown ? "plans.subtitleActive" : "plans.subtitle")} back={onBack} backAlways backLabel={t("plans.back")} data-plans>
      {notice ? (
        <Message tone="neutral" data-plans-notice>
          {notice}
        </Message>
      ) : null}

      {/* Said once: a sign-up's notice above already says it. */}
      {limited && !notice ? (
        <p className="nx-msg" data-tone="neutral" data-plans-limited>
          {t("verify.reminder")}
        </p>
      ) : null}

      {viaRelay ? (
        <Message tone="neutral" data-relay-checkout>
          <p>{t("relay.checkoutUnavailable")}</p>
          {relayStatus?.intranet ? <p>{t("relay.otherPlansAbroad")}</p> : null}
        </Message>
      ) : null}

      {error ? <Message tone="danger">{error}</Message> : null}

      <div className="nx-cols">
        {shown ? (
          <Card className="flex flex-col gap-1" data-plans-current>
            <h2 className="nx-ctitle">{t("plans.current")}</h2>
            <dl className="nx-kv">
              {currentPlan ? (
                <>
                  <dt>{t("tr.plan")}</dt>
                  <dd>{currentPlan.name}</dd>
                </>
              ) : null}
              <dt>{t("plans.expires")}</dt>
              <dd>{formatDate(shown.sub.expireAt, language)}</dd>
            </dl>
            {shown.savedAt ? <p className="nx-tiny">{t("act.asOf", { when: formatAgo(shown.savedAt, language, now) })}</p> : null}
          </Card>
        ) : null}
        {/* Above the plans, because somebody holding a code is not
            shopping -- making them scan the list first to find the one
            thing that does not involve paying is the wrong way round. */}
        <RedeemVoucher onRedeemed={onActivated} initialCode={voucherCode} />
      </div>

      <h2 className="nx-gt">{t("plans.choose")}</h2>
      {/* A grid, not a column. Plans are meant to be compared, and side by
          side does that in one glance; auto-fill means the column count
          follows the window. No "Best value" on any of them: it sat on
          whichever plan came first, the cheapest, which said nothing true. */}
      <div className="nx-plans">
        {limited ? null : plans === null ? (
          <div>
            <p className="nx-csub">{t("plans.loading")}</p>
            <StillTrying waiting={error === null} className="mt-2 text-left" />
          </div>
        ) : plans.length === 0 ? (
          <Card>
            <p className="nx-csub">{t("plans.none")}</p>
          </Card>
        ) : (
          plans.map((plan) => (
            <Card key={plan.id} className="nx-plan">
              <h3>
                {plan.name}
                {currentPlan?.id === plan.id ? <Tag>{t("plans.cur")}</Tag> : null}
              </h3>
              <div className="nx-price">
                <b>{formatPrice(plan.priceUsd, language)}</b>
                <span>{t("plans.perDays", { days: formatNumber(plan.durationDays, language) })}</span>
              </div>

              {/* What you actually get, as scannable rows rather than one
                  buried sentence. Speed is here because it is the second
                  thing anyone asks after price. */}
              <ul className="nx-facts">
                <PlanFact
                  icon={HardDrive}
                  label={t("plans.data")}
                  value={plan.dataCapBytes === null ? t("dash.unlimited") : formatSize(plan.dataCapBytes, language)}
                />
                <PlanFact
                  icon={Gauge}
                  label={t("plans.speed")}
                  value={
                    plan.maxDownloadMbps
                      ? t("plans.upTo", { n: formatNumber(plan.maxDownloadMbps, language) })
                      : t("plans.unlimited")
                  }
                />
                <PlanFact
                  icon={MonitorSmartphone}
                  label={t("plans.devices")}
                  value={
                    plan.maxConcurrentConnections
                      ? t("plans.devicesAtOnce", { n: formatNumber(plan.maxConcurrentConnections, language) })
                      : t("plans.unlimited")
                  }
                />
              </ul>

              <p className="nx-tiny m-0">{t("plans.payWith")}</p>
              <div className="nx-row2">
                <PillButton
                  size="sm"
                  onClick={() => void buy(plan, "NOWPAYMENTS")}
                  disabled={stage.name === "starting" || viaRelay}
                >
                  <Wallet aria-hidden />
                  {t("plans.crypto")}
                </PillButton>
                <PillButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void buy(plan, "STRIPE")}
                  disabled={stage.name === "starting" || viaRelay}
                >
                  <CreditCard aria-hidden />
                  {t("plans.card")}
                </PillButton>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Starting a payment is two writes, each of which first asks who
          answers. */}
      <StillTrying waiting={stage.name === "starting"} />
    </Page>
  );
}
