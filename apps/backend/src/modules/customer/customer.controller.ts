import { BadRequestException, Body, Controller, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SubscriptionStatus } from "@prisma/client";
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
    return this.subscriptionsService.create(
      { customerId: customer.sub, planId: dto.planId },
      SubscriptionStatus.PENDING,
    );
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
    return renderInvoiceHtml(invoice, me.email);
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
    const returnUrl = `${(this.config.get<string>("publicApiUrl") ?? "").replace(/\/$/, "")}/customer/billing/return`;
    return this.billingService.createForClient(dto, returnUrl);
  }

}
