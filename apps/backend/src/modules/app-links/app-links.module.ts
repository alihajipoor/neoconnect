import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AppLinksService } from "./app-links.service";
import { AppLinksController } from "./app-links.controller";

// Exported so the customer controller can serve the same values to the
// app without duplicating the lazily-created-singleton logic.
@Module({
  imports: [PrismaModule],
  controllers: [AppLinksController],
  providers: [AppLinksService],
  exports: [AppLinksService],
})
export class AppLinksModule {}
