import { Controller, Get, Header, Param, Patch, Query, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AdminRole, InvoiceStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { renderInvoiceHtml } from "./invoice-document";
import { AppLinksService } from "../app-links/app-links.service";
import { CustomersService } from "../customers/customers.service";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { listWindow, sendPage } from "../../common/pagination";

@ApiTags("invoices")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("invoices")
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly customers: CustomersService,
    private readonly appLinks: AppLinksService,
  ) {}

  /** Paged. Both filters are optional, so the unwindowed version of this
   * was "every invoice ever issued" by default. */
  @Get()
  async list(
    @Res({ passthrough: true }) res: Response,
    @Query("customerId") customerId?: string,
    @Query("status") status?: InvoiceStatus,
    @Query("take") take?: string,
    @Query("skip") skip?: string,
  ) {
    const window = listWindow({ take, skip }, { defaultTake: 100, maxTake: 500 });
    return sendPage(res, await this.invoices.listPage({ customerId, status }, window));
  }

  /** Revenue actually collected. `days` defaults to a calendar month's
   * worth, which is the period an operator usually wants. */
  @Get("summary")
  summary(@Query("days") days?: string) {
    const window = Number(days) > 0 ? Number(days) : 30;
    return this.invoices.summary(new Date(Date.now() - window * 86_400_000));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.invoices.get(id);
  }

  /** The printable document. Returns HTML the browser prints to PDF --
   * see invoice-document.ts for why that beats rendering server-side. */
  @Get(":id/document")
  @Header("Content-Type", "text/html; charset=utf-8")
  async document(@Param("id") id: string): Promise<string> {
    const invoice = await this.invoices.get(id);
    const customer = await this.customers.get(invoice.customerId);
    return renderInvoiceHtml(invoice, customer.email, undefined, await this.appLinks.get());
  }

  /** Voiding is restricted beyond the usual admin guard: it changes what
   * the books say. BILLING exists for exactly this kind of work, and
   * SUPPORT deliberately doesn't get it. */
  @Patch(":id/void")
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN, AdminRole.BILLING)
  void(@Param("id") id: string) {
    return this.invoices.void(id);
  }
}
