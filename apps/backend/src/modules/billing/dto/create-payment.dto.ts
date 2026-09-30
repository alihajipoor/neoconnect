import { IsIn, IsUUID } from "class-validator";

/** The providers a client may ask to be charged through.
 *
 * APPLE_IAP is deliberately absent, and not by oversight. Every
 * provider here works by us creating a pending payment and sending the
 * customer somewhere to pay it. An App Store purchase is the opposite
 * shape: Apple has already taken the money by the time we hear about
 * it, and the only thing we do is verify the receipt
 * (`redeemApplePurchase`). Accepting it here would let a client open a
 * pending Apple payment that nothing can ever confirm -- and, worse,
 * one that no signature was ever checked for.
 */
export const CLIENT_PAYMENT_PROVIDERS = ["STRIPE", "NOWPAYMENTS", "PLISIO"] as const;
export type ClientPaymentProvider = (typeof CLIENT_PAYMENT_PROVIDERS)[number];

export class CreatePaymentDto {
  @IsUUID()
  subscriptionId!: string;

  @IsIn(CLIENT_PAYMENT_PROVIDERS)
  provider!: ClientPaymentProvider;
}
