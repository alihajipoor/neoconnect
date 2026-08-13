/** The page Stripe returns a customer to after Checkout.
 *
 * Its job is to tell them to go back to the app, and nothing more. It
 * deliberately does not claim the payment succeeded: Stripe redirects the
 * browser as soon as the customer finishes, which can be before the
 * webhook that actually confirms the payment has arrived. Saying
 * "payment complete" here and having the subscription not activate for
 * another few seconds would be worse than saying nothing.
 *
 * The app is polling its own subscription meanwhile, so the customer
 * finds out from the place that actually knows.
 */
export function checkoutReturnPage(cancelled: boolean): string {
  const headline = cancelled ? "Payment cancelled" : "Almost there";
  const detail = cancelled
    ? "Nothing was charged. You can start again whenever you're ready."
    // Deliberately does not say "go back to the app": this page is
    // reached from the web portal as often as from the desktop client,
    // and telling a browser customer to open an app they may not have
    // installed is a dead end at the moment they have just paid.
    : "Thanks &mdash; we&rsquo;re confirming your payment now. Your subscription activates on its own, usually within a minute; you don&rsquo;t need to stay on this page.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neoxify</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0b0b12; color: #e9e9f0; padding: 24px;
    background-image:
      radial-gradient(60rem 40rem at 15% -10%, rgba(139,92,246,.20), transparent 70%),
      radial-gradient(55rem 38rem at 85% 110%, rgba(34,211,238,.14), transparent 70%);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  .card { background: #14141f; border: 1px solid rgba(255,255,255,.08); border-radius: 16px; max-width: 460px; width: 100%;
          box-shadow: 0 4px 24px rgba(139,92,246,.12); overflow: hidden; }
  .bar { background-image: linear-gradient(135deg,#8b5cf6 0%,#22d3ee 100%);
         padding: 22px 28px; color:#fff; font-weight:700; font-size:18px; }
  .body { padding: 30px 28px 28px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0 0 14px; line-height: 1.6; font-size: 15px; }
  .muted { color:#9ca3b8; font-size:13px; }
</style>
</head>
<body><div class="card"><div class="bar">&#9889; Neoxify</div><div class="body">
  <h1>${headline}</h1>
  <p>${detail}</p>
  <p class="muted">You can close this tab.</p>
</div></div></body>
</html>`;
}
