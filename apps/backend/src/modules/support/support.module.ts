import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { EmailModule } from "../email/email.module";
import { SupportService } from "./support.service";
import { SupportController } from "./support.controller";

// Exported so the customer controller can serve the customer half of
// the same conversation without a second copy of the ownership rules.
@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
