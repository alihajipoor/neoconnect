import { Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CustomersService } from "../customers/customers.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { PlansService } from "../plans/plans.service";
import { BillingService } from "../billing/billing.service";
import { CreatePaymentDto } from "../billing/dto/create-payment.dto";
import { CreateOwnSubscriptionDto } from "./dto/create-own-subscription.dto";
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
    private readonly billingService: BillingService,
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

  // Creates the Subscription row only -- NOT a working VPN account yet.
  // Real connection credentials aren't provisioned until
  // BillingService.confirmPayment() actually clears (see its updated
  // renewSubscription()), so a customer can't get VPN access before
  // paying just by hitting this endpoint.
  @Post("subscriptions")
  createSubscription(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: CreateOwnSubscriptionDto) {
    return this.subscriptionsService.create({ customerId: customer.sub, planId: dto.planId });
  }

  @Post("billing/payments")
  async createPayment(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: CreatePaymentDto) {
    // Ownership check first -- a customer must not be able to kick off
    // (or reconcile the state of) a payment against a subscription that
    // isn't theirs.
    await this.subscriptionsService.getOwned(dto.subscriptionId, customer.sub);
    return this.billingService.create(dto);
  }
}
