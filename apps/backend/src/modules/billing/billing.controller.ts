import { Body, Controller, Get, Param, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { listWindow, sendPage } from "../../common/pagination";
import { BillingService } from "./billing.service";
import { CreatePaymentDto } from "./dto/create-payment.dto";

@ApiTags("billing")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("billing/payments")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  /** Paged per the convention in common/pagination.ts: the body is still
   * a bare array, `take`/`skip` are opt-in, and the row count travels in
   * `X-Total-Count`.
   *
   * 100 by default because that fills an operator's table without a
   * second request, against a table that gains a row per payment attempt
   * and is never pruned. */
  @Get()
  async list(
    @Res({ passthrough: true }) res: Response,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(res, await this.billingService.list(window));
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
