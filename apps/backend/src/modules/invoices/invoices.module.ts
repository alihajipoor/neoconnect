import { Module } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { InvoicesController } from "./invoices.controller";
import { CustomersModule } from "../customers/customers.module";
import { EmailModule } from "../email/email.module";

@Module({
  imports: [CustomersModule, EmailModule],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
