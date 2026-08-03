import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check, Copy, CreditCard, Gauge, HardDrive, Loader2, MonitorSmartphone, Wallet } from "lucide-react";
import { createSubscription, getPlans, getSubscriptions, startPayment } from "../lib/customer";
import type { PaymentProvider, PaymentStart, SubscriptionPlan } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { Button, Card } from "../components/ui";
import { Logo } from "../components/Logo";
import { RedeemVoucher } from "../components/RedeemVoucher";
import { useI18n } from "../lib/i18n";

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

/** One "what you get" row. Icon, label, value -- the value right-aligned
 * so the numbers line up down the card and can be compared at a glance. */
function PlanFact({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof HardDrive;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Icon className="size-3.5 shrink-0 text-highlight" />
      <span className="text-muted-foreground">{label}</span>
      <span className="ms-auto font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function Plans({ onActivated, onBack }: { onActivated: () => void; onBack: () => void }) {
  const { t } = useI18n();
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ name: "choosing" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getPlans().then((result) => {
      if (result.ok) setPlans(result.data);
      else setError(result.error);
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
      setError(created.error);
      setStage({ name: "choosing" });
      return;
    }

    const payment = await startPayment(created.data.id, provider);
    if (!payment.ok) {
      setError(payment.error);
      setStage({ name: "choosing" });
      return;
    }

    // Cards open Stripe's own page in the system browser: card details
    // never touch this process, and 3-D Secure is Stripe's problem
    // rather than ours.
    if (payment.data.provider === "STRIPE") {
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
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 p-5">
        <Logo />
        <Card className="flex flex-1 flex-col gap-3">
          <h1 className="text-base font-semibold">{t("plans.waiting")}</h1>
          {/* Reachable now that a failed browser handoff still lands
              here rather than stalling on the spinner. */}
          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {payment.provider === "STRIPE" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Finish the payment in your browser. This screen updates on its own once it clears.
              </p>
              <Button
                variant="outline"
                onClick={() => void reopenCheckout(payment.checkoutUrl)}
                className="w-full justify-center"
              >
                Reopen payment page
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Send exactly this amount. Your subscription activates automatically once the network
                confirms it.
              </p>
              <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                <p className="text-xs text-muted-foreground">{t("plans.amount")}</p>
                <p className="font-mono text-sm">
                  {payment.payAmount} {payment.payCurrency.toUpperCase()}
                </p>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                <p className="text-xs text-muted-foreground">{t("plans.toAddress")}</p>
                <p className="break-all font-mono text-xs">{payment.payAddress}</p>
              </div>
              <Button
                variant="ghost"
                onClick={() => void copyAddress(payment.payAddress)}
                className="gap-2 border border-white/10"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? t("plans.copied") : t("plans.copyAddress")}
              </Button>
            </>
          )}
          <div className="mt-auto flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Checking for confirmation...
          </div>
        </Card>
        <Button variant="ghost" onClick={onBack} className="w-full justify-center gap-2 border border-white/10">
          <ArrowLeft className="size-4" />
          {t("plans.back")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 p-5">
      <Logo />
      <div>
        <h1 className="text-base font-semibold">{t("plans.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("plans.subtitle")}</p>
      </div>

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {/* Above the plans, because somebody holding a code is not
          shopping -- making them scan the list first to find the one
          thing that does not involve paying is the wrong way round. */}
      <RedeemVoucher onRedeemed={onActivated} />

      {/* A grid, not a column. Plans are meant to be compared, and on a
          desktop-width window putting them side by side does that in one
          glance -- while also removing the scrolling that made a second
          plan push content out of sight. auto-fit means the column count
          follows the window rather than being fixed, so this still reads
          correctly at the minimum size. */}
      <div className="grid flex-1 content-start gap-3 overflow-y-auto [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
        {plans === null ? (
          <p className="text-sm text-muted-foreground">{t("plans.loading")}</p>
        ) : plans.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              No plans are available right now. Please check back shortly.
            </p>
          </Card>
        ) : (
          plans.map((plan, index) => (
            <Card
              key={plan.id}
              className={
                // The first plan carries a gradient hairline instead of a
                // heavier border -- it draws the eye without shouting, and
                // a plain list of identical cards gives the eye nowhere to
                // land, which is most of why this screen felt flat.
                index === 0
                  ? "ring-brand surface surface-interactive relative flex flex-col gap-4 overflow-hidden"
                  : "surface surface-interactive flex flex-col gap-4"
              }
            >
              {index === 0 ? (
                <span className="absolute end-0 top-0 rounded-bl-lg bg-gradient-to-r from-primary to-highlight px-2 py-0.5 text-[10px] font-semibold text-white">
                  {t("plans.bestValue")}
                </span>
              ) : null}

              <div>
                <p className="text-sm font-semibold">{plan.name}</p>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className="text-brand-gradient text-3xl font-bold tracking-tight tabular-nums">
                    ${plan.priceUsd}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("plans.perDays", { days: plan.durationDays })}
                  </span>
                </div>
              </div>

              {/* What you actually get, as scannable rows rather than one
                  buried sentence. Speed is here because it is the second
                  thing anyone asks after price. */}
              <div className="flex flex-col gap-2 rounded-lg bg-black/20 p-3">
                <PlanFact
                  icon={HardDrive}
                  label={t("plans.data")}
                  value={
                    plan.dataCapBytes === null
                      ? t("dash.unlimited")
                      : formatBytes(plan.dataCapBytes)
                  }
                />
                <PlanFact
                  icon={Gauge}
                  label={t("plans.speed")}
                  value={
                    plan.maxDownloadMbps
                      ? t("plans.upTo", { n: plan.maxDownloadMbps })
                      : t("plans.unlimited")
                  }
                />
                <PlanFact
                  icon={MonitorSmartphone}
                  label={t("plans.devices")}
                  value={
                    plan.maxConcurrentConnections
                      ? t("plans.devicesAtOnce", { n: plan.maxConcurrentConnections })
                      : t("plans.unlimited")
                  }
                />
              </div>

              <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("plans.payWith")}
              </p>
              <div className="flex gap-2">
                <Button
                  onClick={() => void buy(plan, "NOWPAYMENTS")}
                  disabled={stage.name === "starting"}
                  className="flex-1 gap-2"
                >
                  <Wallet className="size-4" />
                  {t("plans.crypto")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void buy(plan, "STRIPE")}
                  disabled={stage.name === "starting"}
                  className="flex-1 gap-2 border border-white/10"
                >
                  <CreditCard className="size-4" />
                  {t("plans.card")}
                </Button>
              </div>
            </Card>
          ))
        )}
      </div>

      <Button variant="ghost" onClick={onBack} className="w-full justify-center gap-2 border border-white/10">
        <ArrowLeft className="size-4" />
        {t("plans.back")}
      </Button>
    </div>
  );
}
