import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { InvoicesService } from "./invoices.service";
import { InvoicesController } from "./invoices.controller";
import { InvoiceLinkController } from "./invoice-link.controller";
import { CustomersModule } from "../customers/customers.module";
import { EmailModule } from "../email/email.module";

@Module({
  // JwtModule for signing the emailed invoice link. Registered
  // without options: every call passes its own secret and TTL, the
  // same way the customer-auth tokens are issued.
  imports: [CustomersModule, EmailModule, JwtModule.register({})],
  controllers: [InvoicesController, InvoiceLinkController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
