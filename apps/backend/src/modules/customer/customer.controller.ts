import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
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
  ) {}

  @Get("me")
  me(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.customersService.get(customer.sub);
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

  // Location picker: which servers this subscription's plan allows
  // switching to -- see RoutesService.listAvailableForPlan for how
  // eligibility is derived from the plan's protocolsAllowed[].
  @Get("subscriptions/:id/routes")
  async availableRoutes(@CurrentCustomer() customer: AuthenticatedCustomer, @Param("id") id: string) {
    const subscription = await this.subscriptionsService.getOwned(id, customer.sub);
    const plan = await this.plansService.get(subscription.planId);
    return this.routesService.listAvailableForPlan(plan.protocolsAllowed);
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
