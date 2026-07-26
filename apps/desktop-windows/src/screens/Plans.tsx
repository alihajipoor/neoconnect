import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check, Copy, CreditCard, Loader2, Wallet } from "lucide-react";
import { createSubscription, getPlans, getSubscriptions, startPayment } from "../lib/customer";
import type { PaymentProvider, PaymentStart, SubscriptionPlan } from "../lib/types";
import { formatBytes } from "../lib/utils";
import { Button, Card } from "../components/ui";
import { Logo } from "../components/Logo";
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
      await openUrl(payment.data.checkoutUrl);
    }
    setStage({ name: "awaiting", payment: payment.data });
  }

  async function copyAddress(address: string) {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (stage.name === "awaiting") {
    const payment = stage.payment;
    return (
      <div className="flex h-full flex-col gap-4 p-5">
        <Logo />
        <Card className="flex flex-1 flex-col gap-3">
          <h1 className="text-base font-semibold">{t("plans.waiting")}</h1>
          {payment.provider === "STRIPE" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Finish the payment in your browser. This screen updates on its own once it clears.
              </p>
              <Button variant="ghost" onClick={() => void openUrl(payment.checkoutUrl)} className="border border-white/10">
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
    <div className="flex h-full flex-col gap-4 p-5">
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

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {plans === null ? (
          <p className="text-sm text-muted-foreground">{t("plans.loading")}</p>
        ) : plans.length === 0 ? (
          <Card>
            <p className="text-sm text-muted-foreground">
              No plans are available right now. Please check back shortly.
            </p>
          </Card>
        ) : (
          plans.map((plan) => (
            <Card key={plan.id} className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{plan.name}</span>
                <span className="text-lg font-semibold text-primary">${plan.priceUsd}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {formatBytes(plan.dataCapBytes)} for {plan.durationDays} days
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
