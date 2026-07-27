import { Controller, Get, Header, NotFoundException, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { InvoicesService } from "./invoices.service";
import { CustomersService } from "../customers/customers.service";
import { renderInvoiceHtml } from "./invoice-document";

/** The "View invoice" button in an emailed invoice.
 *
 * Deliberately outside both guarded controllers. The customer-facing
 * invoice route sits behind CustomerJwtAuthGuard, which is right for the
 * app but impossible for a link opened from an inbox: the browser that
 * opens it -- normally a phone -- has no session, so it could only ever
 * answer 401. It did exactly that, in raw JSON, as soon as
 * PUBLIC_API_URL was set and the button started appearing at all.
 *
 * The signed token in the URL is the authorisation. It names one
 * invoice, is signed by this server, carries a pinned purpose so it
 * cannot be replayed elsewhere, and expires -- the same construction the
 * email-verification link uses.
 *
 * Throttled because it is unauthenticated and takes a token from the
 * query string, so it is the sort of endpoint worth guessing at. The
 * token itself is unguessable; this just keeps anyone from trying.
 */
@Controller()
export class InvoiceLinkController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly customersService: CustomersService,
  ) {}

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("invoice-document")
  @Header("Content-Type", "text/html; charset=utf-8")
  async document(@Query("token") token: string): Promise<string> {
    if (!token) {
      throw new NotFoundException("This invoice link is missing its token");
    }
    const invoice = await this.invoicesService.getByDocumentToken(token);
    const customer = await this.customersService.get(invoice.customerId);
    return renderInvoiceHtml(invoice, customer.email);
  }
}
