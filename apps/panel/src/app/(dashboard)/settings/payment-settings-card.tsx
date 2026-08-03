"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CreditCard, Wallet } from "lucide-react";
import { updatePaymentSettingsAction } from "./actions";
import type { PaymentSettings } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** A secret input that knows whether one is already stored.
 *
 * The API never returns a saved secret, so the field is always blank. That
 * is easy to misread as "not configured", which is why it says so
 * explicitly and why the placeholder tells you that leaving it alone keeps
 * the existing value -- otherwise the safe action looks like the
 * destructive one.
 */
function SecretField({
  id,
  label,
  isSet,
  hint,
}: {
  id: string;
  label: string;
  isSet: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className={isSet ? "text-xs text-success" : "text-xs text-muted-foreground"}>
          {isSet ? "Configured" : "Not set"}
        </span>
      </div>
      <Input
        id={id}
        name={id}
        type="password"
        // Browsers widely ignore autoComplete="off" on password fields and
        // autofill a saved site password anyway. That is genuinely
        // dangerous here: the field would look filled while the label still
        // read "Not set", and saving would store the browser's password as
        // a live payment key. "new-password" is the value password managers
        // actually honour as "do not offer a saved credential".
        autoComplete="new-password"
        data-1p-ignore
        data-lpignore="true"
        placeholder={isSet ? "Leave blank to keep the current key" : "Paste the key"}
      />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function PaymentSettingsCard({ settings }: { settings: PaymentSettings }) {
  const [pending, startTransition] = useTransition();
  // Tracked so the card can warn before saving a provider that is switched
  // on with nothing behind it.
  const [stripeOn, setStripeOn] = useState(settings.stripeEnabled);
  const [cryptoOn, setCryptoOn] = useState(settings.nowPaymentsEnabled);

  function handleSubmit(formData: FormData) {
    const stripeSecretKey = String(formData.get("stripeSecretKey") ?? "") || undefined;
    const nowPaymentsApiKey = String(formData.get("nowPaymentsApiKey") ?? "") || undefined;

    // Enabling a provider with no key would put a button in the app that
    // fails when pressed -- the exact problem this screen exists to end.
    if (stripeOn && !stripeSecretKey && !settings.stripeSecretKeySet) {
      toast.error("Add a Stripe secret key before enabling card payments.");
      return;
    }
    if (cryptoOn && !nowPaymentsApiKey && !settings.nowPaymentsApiKeySet) {
      toast.error("Add a NowPayments API key before enabling crypto payments.");
      return;
    }

    startTransition(async () => {
      const result = await updatePaymentSettingsAction({
        stripeEnabled: stripeOn,
        stripePublishableKey: String(formData.get("stripePublishableKey") ?? "").trim() || undefined,
        stripeSecretKey,
        stripeWebhookSecret: String(formData.get("stripeWebhookSecret") ?? "") || undefined,
        nowPaymentsEnabled: cryptoOn,
        nowPaymentsApiKey,
        nowPaymentsIpnSecret: String(formData.get("nowPaymentsIpnSecret") ?? "") || undefined,
      });
      if (result.ok) toast.success("Payment settings saved");
      else toast.error(result.error);
    });
  }

  return (
    <form action={handleSubmit} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <CreditCard className="size-4.5" />
            </div>
            <div>
              <CardTitle>Cards — Stripe</CardTitle>
              <CardDescription>
                Customers pay on Stripe&apos;s own hosted page, so card details never touch this server.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={stripeOn} onCheckedChange={(v) => setStripeOn(v === true)} />
            Accept card payments
          </label>

          <div className="flex flex-col gap-2">
            <Label htmlFor="stripePublishableKey">Publishable key</Label>
            <Input
              id="stripePublishableKey"
              name="stripePublishableKey"
              defaultValue={settings.stripePublishableKey ?? ""}
              placeholder="pk_live_..."
            />
            <p className="text-xs text-muted-foreground">
              Public by design — this one is safe to show and is stored unencrypted.
            </p>
          </div>

          <SecretField id="stripeSecretKey" label="Secret key" isSet={settings.stripeSecretKeySet} />
          <SecretField
            id="stripeWebhookSecret"
            label="Webhook signing secret"
            isSet={settings.stripeWebhookSecretSet}
            hint="Without this, Stripe's confirmations are rejected and paid subscriptions never activate."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2.5">
            <div className="flex size-9 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
              <Wallet className="size-4.5" />
            </div>
            <div>
              <CardTitle>Crypto — NowPayments</CardTitle>
              <CardDescription>
                The route customers in sanctioned regions can actually use, where cards are not an option.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={cryptoOn} onCheckedChange={(v) => setCryptoOn(v === true)} />
            Accept crypto payments
          </label>

          <SecretField id="nowPaymentsApiKey" label="API key" isSet={settings.nowPaymentsApiKeySet} />
          <SecretField
            id="nowPaymentsIpnSecret"
            label="IPN secret"
            isSet={settings.nowPaymentsIpnSecretSet}
            hint="Used to verify payment callbacks. Without it, confirmations are rejected."
          />
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving..." : "Save payment settings"}
        </Button>
        <p className="text-xs text-muted-foreground">
          The app only offers the methods enabled here, so a provider left off simply won&apos;t appear.
        </p>
      </div>
    </form>
  );
}
