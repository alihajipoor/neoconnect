import { IsBoolean, IsOptional, IsString } from "class-validator";

/** Every secret is optional on update so the panel can save the form
 * without re-sending values the admin didn't retype -- the same shape the
 * email settings form uses. A blank field means "leave it alone", never
 * "clear it", because clearing a live payment key by tabbing past a box
 * would take the storefront down. */
export class UpdatePaymentSettingsDto {
  @IsOptional()
  @IsBoolean()
  stripeEnabled?: boolean;

  @IsOptional()
  @IsString()
  stripePublishableKey?: string;

  @IsOptional()
  @IsString()
  stripeSecretKey?: string;

  @IsOptional()
  @IsString()
  stripeWebhookSecret?: string;

  @IsOptional()
  @IsBoolean()
  nowPaymentsEnabled?: boolean;

  @IsOptional()
  @IsString()
  nowPaymentsApiKey?: string;

  @IsOptional()
  @IsString()
  nowPaymentsIpnSecret?: string;

  @IsOptional()
  @IsBoolean()
  plisioEnabled?: boolean;

  /** Plisio has no separate IPN secret -- it signs callbacks with this
   * same key -- so there is deliberately no second field here. */
  @IsOptional()
  @IsString()
  plisioApiKey?: string;
}
