import type { Invoice } from "@prisma/client";

/** A printable invoice, rendered as HTML.
 *
 * HTML rather than drawing primitives with a PDF library: an invoice is a
 * customer-facing document and has to look like the rest of the product,
 * not like a data dump in a box. Laying out a branded header, a real
 * typographic hierarchy and an itemised table by hand-positioning
 * coordinates is how invoices end up looking generic, which the standing
 * design requirement rules out.
 *
 * Served as HTML with print styling rather than converted server-side.
 * Headless-Chrome conversion means shipping a browser inside the API
 * container -- a few hundred megabytes and a recurring patch surface, to
 * produce a file the customer's own browser can already make with
 * Ctrl+P. If a stored PDF is ever genuinely required (an accountant
 * wanting archives rather than a customer wanting a copy), that's the
 * point to add the renderer, not before.
 */

interface LineItem {
  description: string;
  amountUsd: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function renderInvoiceHtml(invoice: Invoice, customerEmail: string, businessName = "Neoxify"): string {
  const lineItems = (invoice.lineItemsJson as unknown as LineItem[]) ?? [];
  const rows = lineItems
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.description)}</td>
        <td class="num">$${escapeHtml(item.amountUsd)}</td>
      </tr>`,
    )
    .join("");

  const statusClass = invoice.status === "PAID" ? "paid" : invoice.status === "OVERDUE" ? "overdue" : "issued";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(invoice.invoiceNumber)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #f4f4fa; color: #1e1b2e; padding: 32px 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px; line-height: 1.6;
  }
  .sheet {
    max-width: 720px; margin: 0 auto; background: #fff; border-radius: 16px;
    box-shadow: 0 4px 24px rgba(139,92,246,.12); overflow: hidden;
  }
  header {
    background-image: linear-gradient(135deg,#8b5cf6 0%,#7c3aed 60%,#5b21b6 100%);
    color: #fff; padding: 28px 36px; display: flex; justify-content: space-between; align-items: flex-start;
  }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: .2px; }
  .doc { text-align: right; }
  .doc .num { font-family: 'SFMono-Regular', Consolas, Menlo, monospace; font-size: 14px; opacity: .95; }
  .doc .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; opacity: .8; }
  .body { padding: 32px 36px 36px; }
  .meta { display: flex; flex-wrap: wrap; gap: 28px; margin-bottom: 28px; }
  .meta div { min-width: 140px; }
  .meta .k { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; }
  .meta .v { font-weight: 600; }
  .status {
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    font-size: 11px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase;
  }
  .status.paid { background: #dcfce7; color: #166534; }
  .status.overdue { background: #fee2e2; color: #b42318; }
  .status.issued { background: #ede9fe; color: #5b21b6; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280;
       border-bottom: 1px solid #eceaf5; padding: 0 0 10px; }
  td { padding: 14px 0; border-bottom: 1px solid #f3f2f9; }
  .num { text-align: right; font-family: 'SFMono-Regular', Consolas, Menlo, monospace; white-space: nowrap; }
  tfoot td { border: 0; padding-top: 18px; font-size: 16px; font-weight: 700; }
  footer { padding: 20px 36px; border-top: 1px solid #eceaf5; background: #fbfaff; color: #6b7280; font-size: 12px; }
  .print { max-width: 720px; margin: 16px auto 0; text-align: right; }
  .print button {
    border: 0; border-radius: 10px; padding: 10px 20px; cursor: pointer; color: #fff; font-weight: 600;
    background-image: linear-gradient(135deg,#8b5cf6,#7c3aed);
  }
  /* Printing is how this becomes a PDF, so drop the page chrome. */
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; border-radius: 0; max-width: none; }
    .print { display: none; }
  }
</style>
</head>
<body>
  <div class="sheet">
    <header>
      <div class="brand">&#9889; ${escapeHtml(businessName)}</div>
      <div class="doc">
        <div class="label">Invoice</div>
        <div class="num">${escapeHtml(invoice.invoiceNumber)}</div>
      </div>
    </header>
    <div class="body">
      <div class="meta">
        <div>
          <div class="k">Billed to</div>
          <div class="v">${escapeHtml(customerEmail)}</div>
        </div>
        <div>
          <div class="k">Issued</div>
          <div class="v">${formatDate(invoice.issuedAt)}</div>
        </div>
        <div>
          <div class="k">Service period</div>
          <div class="v">${formatDate(invoice.periodStart)} &ndash; ${formatDate(invoice.periodEnd)}</div>
        </div>
        <div>
          <div class="k">Status</div>
          <div class="v"><span class="status ${statusClass}">${escapeHtml(invoice.status)}</span></div>
        </div>
      </div>

      <table>
        <thead>
          <tr><th>Description</th><th class="num">Amount</th></tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td>Total</td>
            <td class="num">$${escapeHtml(invoice.amountUsd.toString())} ${escapeHtml(invoice.currency.toUpperCase())}</td>
          </tr>
        </tfoot>
      </table>
    </div>
    <footer>
      ${
        invoice.paidAt
          ? `Paid on ${formatDate(invoice.paidAt)}. Thank you.`
          : invoice.dueAt
            ? `Payable by ${formatDate(invoice.dueAt)}.`
            : "Thank you."
      }
    </footer>
  </div>
  <div class="print"><button onclick="window.print()">Save as PDF</button></div>
</body>
</html>`;
}
