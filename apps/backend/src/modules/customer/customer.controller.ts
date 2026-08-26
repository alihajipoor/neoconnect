import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  HttpStatus,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CustomersService } from "../customers/customers.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { PlansService } from "../plans/plans.service";
import { RoutesService } from "../routes/routes.service";
import { BillingService } from "../billing/billing.service";
import { InvoicesService } from "../invoices/invoices.service";
import { PaymentSettingsService } from "../payment-settings/payment-settings.service";
import { renderInvoiceHtml } from "../invoices/invoice-document";
import { CreatePaymentDto } from "../billing/dto/create-payment.dto";
import { CreateOwnSubscriptionDto } from "./dto/create-own-subscription.dto";
import { SwitchRouteDto } from "./dto/switch-route.dto";
import { ReferralsService } from "../referrals/referrals.service";
import { VouchersService } from "../vouchers/vouchers.service";
import { AppLinksService } from "../app-links/app-links.service";
import { SupportService } from "../support/support.service";
import { OpenTicketDto } from "../support/dto/open-ticket.dto";
import { ReplyTicketDto } from "../support/dto/reply-ticket.dto";
import { RedeemVoucherDto } from "../vouchers/dto/redeem-voucher.dto";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { GamingService } from "../gaming/gaming.service";
import { AuthenticatedCustomer } from "../customer-auth/types";

// Everything here is scoped to the calling customer only (never another
// customer's data) -- this is the API surface a native client calls to
// show "your subscription" / "your connection info" and to self-serve a
// purchase. No panel UI consumes this; see the Customer Self-Signup +
// Free Trial Mode and Native Windows Client plan sections.
@ApiTags("customer")
@ApiBearerAuth()
@UseGuards(CustomerJwtAuthGuard)
@Controller("customer")
export class CustomerController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
    private readonly plansService: PlansService,
    private readonly referralsService: ReferralsService,
    private readonly vouchersService: VouchersService,
    private readonly supportService: SupportService,
    private readonly appLinksService: AppLinksService,
    private readonly routesService: RoutesService,
    private readonly billingService: BillingService,
    private readonly config: ConfigService,
    private readonly invoicesService: InvoicesService,
    private readonly paymentSettings: PaymentSettingsService,
    private readonly gamingService: GamingService,
  ) {}

  @Get("me")
  me(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.customersService.get(customer.sub);
  }

  /* Deleting your own account.
   *
   * Required to exist, not a nicety: Apple 5.1.1(v) and Google Play's
   * data deletion policy both make in-app account deletion a condition
   * of listing an app that offers account creation. Neither store cares
   * that we would rather keep the customer.
   *
   * DELETE on /me rather than a POST to /me/delete because it is exactly
   * what the verb means, and because a stray POST is likelier than a
   * stray DELETE.
   *
   * There is no confirmation parameter here on purpose -- confirming is
   * the client's job, in the client's language, where the customer can
   * be told what they are giving up. A backend flag would only be
   * theatre, since anything that can call this can set it.
   */
  @Delete("me")
  deleteAccount(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.customersService.deleteOwnAccount(customer.sub);
  }

  @Get("subscriptions")
  subscriptions(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.subscriptionsService.listByCustomer(customer.sub);
  }

  @Get("protocol-users")
  protocolUsers(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.protocolUsersService.listByCustomer(customer.sub);
  }

  @Get("plans")
  plans() {
    return this.plansService.listActive();
  }

  /** Everything the app needs to run Gaming Mode, or an honest reason it
   * cannot.
   *
   * Its own endpoint rather than another field on `/customer/protocol-users`,
   * for two concrete reasons. That payload is filtered through the
   * `CLIENT_VISIBLE_PUBLIC_PARAMS` whitelist, so a field added near it is
   * silently dropped before it reaches a client and nothing reports the
   * silence. And the desktop app caches that payload behind a `version`
   * discriminator whose bump throws the cache away -- which would cost every
   * customer their offline credentials to ship a feature unrelated to them.
   *
   * Returns the game catalogue even when the customer is not entitled, so the
   * app can show what the mode covers and say what is missing rather than
   * render an empty screen that reads as a fault. The catalogue holds no
   * credential. `resolver` is null unless the plan grants the feature AND a
   * node has actually confirmed it is serving one. */
  @Get("gaming-profile")
  async gamingProfile(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // This is the one list route in the API that has to send everything,
    // and it is worth being explicit about why so nobody "fixes" it with
    // a `take`. The desktop client matches catalogue names against the
    // processes running on the machine, with no network in the loop, so
    // it needs the whole catalogue to recognise a game at all. A page of
    // a catalogue is not a smaller answer to that question -- it is a
    // wrong one, silently, for every game past the page boundary.
    //
    // So it is bounded the other way: an unchanged catalogue costs a 304
    // with no body instead of 373,954 B (51,742 B gzipped, measured on
    // the wire on 2026-08-25). The validator is computed from an
    // aggregate over `updatedAt`/`_count` rather than by hashing the
    // response, because building the response is the cost being avoided.
    //
    // Mixed into the tag alongside the catalogue fingerprint: the
    // customer's entitlement and which resolver they were handed. Both
    // are per-customer and both change what this returns, so a tag
    // covering only the catalogue would let a customer whose plan just
    // started still be served a stale "not entitled".
    //
    // No shipped client benefits from this yet -- the desktop app fetches
    // through `@tauri-apps/plugin-http`, which has no HTTP cache and
    // sends no `If-None-Match`. It is inert for them rather than harmful:
    // a caller that sends no validator always gets its 200 and its body.
    // Making it pay off is a one-line client change, described in the
    // journal entry for this work.
    const fingerprint = await this.gamingService.catalogueFingerprint();
    const identity = `${customer.sub}:${fingerprint}`;
    const etag = `W/"gaming-${createHash("sha256").update(identity).digest("base64url").slice(0, 27)}"`;

    // Private, because the tag is per-customer: an intermediary caching
    // this and serving it to somebody else would hand over another
    // customer's entitlement state. `must-revalidate` rather than a max-age
    // so a client always asks -- the round trip is the cheap part; the
    // 374 KB is not.
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
    res.setHeader("ETag", etag);

    if (req.headers["if-none-match"] === etag) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }

    return this.gamingService.profileForCustomer(customer.sub);
  }

  /** The calling customer's own referral standing: their code, who has
   * joined with it, and how close the next free month is.
   *
   * Invited friends appear by masked address only. The inviter is
   * entitled to know their invite worked and whether that person became
   * a paying customer; a readable list of other people's email
   * addresses is a different thing, and a referral link posted publicly
   * would turn this into a way to collect them. */
  /** Where to find the product outside the app.
   *
   * Served rather than compiled into the client so a Discord invite or
   * a renamed account does not need a new release to fix. */
  @Get("links")
  links() {
    return this.appLinksService.get();
  }

  /** Checks a code and says what it would grant, without spending it.
   *
   * Separate from redeeming so the app can show the plan and let the
   * customer confirm -- a code that silently converts on the first
   * keystroke is not something anyone should build. */
  @Post("vouchers/preview")
  previewVoucher(@Body() dto: RedeemVoucherDto) {
    return this.vouchersService.preview(dto.code);
  }

  @Post("vouchers/redeem")
  redeemVoucher(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: RedeemVoucherDto,
  ) {
    return this.vouchersService.redeem(customer.sub, dto.code);
  }

  /** Everything the support screen needs in one call: whether new
   * conversations are open, and the ones this customer already has. */
  @Get("support")
  support(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.supportService.overviewFor(customer.sub);
  }

  @Post("support/tickets")
  openTicket(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Body() dto: OpenTicketDto,
  ) {
    return this.supportService.openTicket(customer.sub, dto.subject, dto.body);
  }

  /** Fetching a thread also marks it read -- opening it is reading it,
   * and a separate call the client has to remember is a client that
   * eventually forgets. */
  @Get("support/tickets/:id")
  supportThread(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param("id") id: string,
  ) {
    return this.supportService.threadFor(customer.sub, id);
  }

  @Post("support/tickets/:id/messages")
  replyToTicket(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param("id") id: string,
    @Body() dto: ReplyTicketDto,
  ) {
    return this.supportService.replyAsCustomer(customer.sub, id, dto.body);
  }

  @Get("referrals")
  referrals(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.referralsService.overviewFor(customer.sub);
  }

  /** Which payment methods are actually usable right now.
   *
   * The app used to show Card and Crypto unconditionally, so a customer
   * pressed one and got an error because no keys had ever been configured
   * -- reported from real use. Offering only what can work turns a broken
   * button into an absent one.
   */
  @Get("billing/providers")
  paymentProviders() {
    return this.paymentSettings.availableProviders();
  }

  // Creates the Subscription row only -- NOT a working VPN account yet.
  // Real connection credentials aren't provisioned until
  // BillingService.confirmPayment() actually clears (see its updated
  // renewSubscription()), so a customer can't get VPN access before
  // paying just by hitting this endpoint.
  @Post("subscriptions")
  createSubscription(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: CreateOwnSubscriptionDto) {
    // PENDING until the payment actually clears. BillingService
    // .confirmPayment -> renewSubscription() flips it to ACTIVE, which is
    // also where the VPN credentials get provisioned.
    //
    // Reuses an unpaid attempt at the same plan instead of creating a new
    // one per press: the app calls this before every payment attempt, so
    // a customer who retries -- or switches from Card to Crypto -- was
    // leaving a PENDING subscription behind each time.
    return this.subscriptionsService.createOrReusePending(customer.sub, dto.planId);
  }

  // Location picker: which servers this subscription's plan is actually
  // served by. Deliberately the same set provisioning would grant -- a
  // picker that offers more than that produces a customer tapping a
  // server and being told no, which looks like a bug rather than a plan
  // boundary.
  @Get("subscriptions/:id/routes")
  async availableRoutes(@CurrentCustomer() customer: AuthenticatedCustomer, @Param("id") id: string) {
    const subscription = await this.subscriptionsService.getOwned(id, customer.sub);
    const plan = await this.plansService.get(subscription.planId);
    return this.routesService.listAvailableForPlan(
      plan.protocolsAllowed,
      plan.allowedRoutes.map((r) => r.id),
    );
  }

  // Location picker: switch this subscription's VPN account to a
  // different route -- tears down the old ProtocolUser(s) and provisions
  // a fresh one, so the client should be disconnected first (a stale
  // local tunnel pointed at now-deleted server credentials won't work).
  @Post("subscriptions/:id/route")
  async switchRoute(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param("id") id: string,
    @Body() dto: SwitchRouteDto,
  ) {
    const subscription = await this.subscriptionsService.getOwned(id, customer.sub);
    if (subscription.status !== "ACTIVE") {
      throw new BadRequestException("Subscription must be active to switch servers");
    }
    return this.protocolUsersService.switchRoute(subscription.id, dto.routeId);
  }

  @Get("invoices")
  invoices(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.invoicesService.list({ customerId: customer.sub });
  }

  /** The printable invoice. Scoped by ownership in the lookup itself, so
   * another customer's id is indistinguishable from one that doesn't
   * exist rather than confirming it belongs to someone. */
  @Get("invoices/:id/document")
  @Header("Content-Type", "text/html; charset=utf-8")
  async invoiceDocument(
    @CurrentCustomer() customer: AuthenticatedCustomer,
    @Param("id") id: string,
  ): Promise<string> {
    const invoice = await this.invoicesService.getOwned(id, customer.sub);
    const me = await this.customersService.get(customer.sub);
    return renderInvoiceHtml(invoice, me.email, undefined, await this.appLinksService.get());
  }

  @Post("billing/payments")
  async createPayment(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: CreatePaymentDto) {
    // Ownership check first -- a customer must not be able to kick off
    // (or reconcile the state of) a payment against a subscription that
    // isn't theirs.
    await this.subscriptionsService.getOwned(dto.subscriptionId, customer.sub);

    // Cards go through a hosted Checkout page rather than card fields in
    // the app -- see StripeProvider.createCheckoutSession. The page the
    // customer returns to afterwards is served by this API, so it works
    // without the marketing site existing yet.
    //
    // PUBLIC_API_URL must be set: without it this built a relative
    // success_url, Stripe rejected the session with "Not a valid URL",
    // and the customer saw that raw provider message with nothing
    // pointing at the actual cause -- a deployment missing one variable.
    // Observed in production. Failing here names the problem instead.
    const publicApiUrl = this.config.get<string>("publicApiUrl");
    if (!publicApiUrl) {
      throw new ServiceUnavailableException(
        "Payments are not fully configured on this server (PUBLIC_API_URL is unset).",
      );
    }
    const returnUrl = `${publicApiUrl.replace(/\/$/, "")}/customer/billing/return`;
    return this.billingService.createForClient(dto, returnUrl);
  }

}
