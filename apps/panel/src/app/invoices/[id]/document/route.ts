import { NextResponse } from "next/server";
import { backendUrl } from "@/lib/backend";
import { getAccessToken } from "@/lib/session";

/** Serves the printable invoice through the panel.
 *
 * The backend's `/invoices/:id/document` needs a bearer token, so a plain
 * `<a href>` straight at it would just 401 -- the browser doesn't carry
 * the admin's session. This proxies the request with the token attached
 * so "View invoice" can be an ordinary link that opens in a new tab and
 * prints with Ctrl+P, which is the whole point of an HTML document
 * instead of a server-rendered PDF.
 *
 * Deliberately outside the (dashboard) route group: it returns a
 * standalone document, not a page that should inherit the panel chrome.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = await getAccessToken();
  if (!token) return new NextResponse("Not signed in", { status: 401 });

  const { id } = await params;
  const res = await fetch(`${backendUrl()}/invoices/${encodeURIComponent(id)}/document`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!res.ok) {
    return new NextResponse(res.status === 404 ? "Invoice not found" : "Could not load this invoice", {
      status: res.status,
    });
  }

  return new NextResponse(await res.text(), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
