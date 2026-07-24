import { Module } from "@nestjs/common";
import { CustomerController } from "./customer.controller";
import { CustomersModule } from "../customers/customers.module";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { ProtocolUsersModule } from "../protocol-users/protocol-users.module";

@Module({
  imports: [CustomersModule, SubscriptionsModule, ProtocolUsersModule],
  controllers: [CustomerController],
})
export class CustomerModule {}
