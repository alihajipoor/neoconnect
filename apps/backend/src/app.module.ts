import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import configuration from "./config/configuration";
import { PrismaModule } from "./prisma/prisma.module";
import { HealthModule } from "./modules/health/health.module";
import { AuthModule } from "./modules/auth/auth.module";
import { AdminsModule } from "./modules/admins/admins.module";
import { CustomersModule } from "./modules/customers/customers.module";
import { PlansModule } from "./modules/plans/plans.module";

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
  ],
})
export class AppModule {}
