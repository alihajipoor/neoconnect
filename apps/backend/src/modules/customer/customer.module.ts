import { Module } from "@nestjs/common";
import { CustomerController } from "./customer.controller";
import { CustomersModule } from "../customers/customers.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";
import { PlansModule } from "../plans/plans.module";
import { RoutesModule } from "../routes/routes.module";
import { BillingModule } from "../billing/billing.module";

@Module({
  imports: [CustomersModule, SubscriptionsModule, ProtocolUsersModule, PlansModule, RoutesModule, BillingModule],
  controllers: [CustomerController],
})
export class CustomerModule {}
