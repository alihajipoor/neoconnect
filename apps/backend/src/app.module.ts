import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { AdminsModule } from "./modules/admins/admins.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { PlansModule } from "./modules/plans/plans.module";
import { NodesModule } from "./modules/nodes/nodes.module";
import { EnrollmentModule } from "./modules/enrollment/enrollment.module";
import { AgentGatewayModule } from "./modules/agent-gateway/agent-gateway.module";
import { SubscriptionsModule } from "./modules/subscriptions/subscriptions.module";
import { ProtocolConfigsModule } from "./modules/protocol-configs/protocol-configs.module";
import { ProtocolUsersModule } from "./modules/protocol-users/protocol-users.module";
import { RoutesModule } from "./modules/routes/routes.module";
import { UsageModule } from "./modules/usage/usage.module";
import { JobsModule } from "./modules/jobs/jobs.module";
import { BillingModule } from "./modules/billing/billing.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    AdminsModule,
    CustomersModule,
    PlansModule,
    NodesModule,
    EnrollmentModule,
    AgentGatewayModule,
    SubscriptionsModule,
    ProtocolConfigsModule,
    ProtocolUsersModule,
    RoutesModule,
    UsageModule,
    JobsModule,
    BillingModule,
  ],
})
export class AppModule {}
