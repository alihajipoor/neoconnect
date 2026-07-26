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
    ? "Nothing was charged. You can start again from the Neoxify app whenever you're ready."
    : "Thanks &mdash; we're confirming your payment now. Head back to the Neoxify app; your subscription activates there automatically, usually within a few seconds.";

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
    background: #f4f4fa; color: #1e1b2e; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  .card { background: #fff; border-radius: 16px; max-width: 460px; width: 100%;
          box-shadow: 0 4px 24px rgba(139,92,246,.12); overflow: hidden; }
  .bar { background-image: linear-gradient(135deg,#8b5cf6 0%,#7c3aed 60%,#5b21b6 100%);
         padding: 22px 28px; color:#fff; font-weight:700; font-size:18px; }
  .body { padding: 30px 28px 28px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0 0 14px; line-height: 1.6; font-size: 15px; }
  .muted { color:#6b7280; font-size:13px; }
</style>
</head>
<body><div class="card"><div class="bar">&#9889; Neoxify</div><div class="body">
  <h1>${headline}</h1>
  <p>${detail}</p>
  <p class="muted">You can close this tab.</p>
</div></div></body>
</html>`;
}
