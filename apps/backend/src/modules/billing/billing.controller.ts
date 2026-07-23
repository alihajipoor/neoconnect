import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { BillingService } from "./billing.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";

@ApiTags("billing")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("billing/payments")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get()
  list() {
    return this.billingService.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.billingService.get(id);
  }

  @Post()
  create(@Body() dto: CreatePaymentDto) {
    return this.billingService.create(dto);
  }

  @Post(":id/reconcile")
  reconcile(@Param("id") id: string) {
    return this.billingService.reconcile(id);
  }
}
