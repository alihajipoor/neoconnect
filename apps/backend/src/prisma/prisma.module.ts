import { Global, Module } from "@nestjs/common";
import { PrismaService, ReportingPrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [PrismaService, ReportingPrismaService],
  exports: [PrismaService, ReportingPrismaService],
})
export class PrismaModule {}
