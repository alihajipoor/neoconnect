import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { CustomersService } from "../customers/customers.service";
import { SubscriptionsService } from "../subscriptions/subscriptions.service";
import { ProtocolUsersService } from "../protocol-users/protocol-users.service";
import { CustomerJwtAuthGuard } from "../../common/guards/customer-jwt-auth.guard";
import { CurrentCustomer } from "../../common/decorators/current-customer.decorator";
import { AuthenticatedCustomer } from "../customer-auth/types";

// Everything here is scoped to the calling customer only (never another
// customer's data) -- this is the API surface a native client calls to
// show "your subscription" / "your connection info". No panel UI
// consumes this; see the Customer Self-Signup + Free Trial Mode plan.
@ApiTags("customer")
@ApiBearerAuth()
@UseGuards(CustomerJwtAuthGuard)
@Controller("customer")
export class CustomerController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly protocolUsersService: ProtocolUsersService,
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
}
