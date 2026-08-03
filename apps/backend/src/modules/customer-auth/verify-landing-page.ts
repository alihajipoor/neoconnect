/** The page a customer lands on after clicking "Verify my email".
 *
 * This exists because the email used to link directly to
 * `neoconnect://verify-email?token=...`. Webmail clients strip or refuse
 * to render custom URI schemes, so in Gmail and Yahoo the button was not
 * clickable at all -- confirmed by a real user, on a real account. An
 * https:// link survives every mail client, and this page then does the
 * work.
 *
 * The verification happens server-side before this renders, so the link
 * works on a phone, a work laptop, or anywhere else the app isn't
 * installed. Opening the app is offered afterwards as a convenience, not
 * as the mechanism.
 */

const BACKGROUND = "#f4f4fa";
const INK = "#1e1b2e";
const MUTED = "#6b7280";
const BRAND = "#8b5cf6";

function shell(inner: string): string {
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
    background: ${BACKGROUND}; color: ${INK}; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    background: #fff; border-radius: 16px; max-width: 460px; width: 100%;
    box-shadow: 0 4px 24px rgba(139, 92, 246, 0.12); overflow: hidden;
  }
  .bar {
    background: ${BRAND};
    background-image: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 60%, #5b21b6 100%);
    padding: 22px 28px; color: #fff; font-weight: 700; font-size: 18px;
  }
  .body { padding: 30px 28px 28px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0 0 14px; line-height: 1.6; font-size: 15px; }
  .muted { color: ${MUTED}; font-size: 13px; }
  .btn {
    display: inline-block; margin: 6px 0 4px; padding: 12px 24px; border-radius: 10px;
    background-image: linear-gradient(135deg, #8b5cf6, #7c3aed);
    color: #fff; text-decoration: none; font-weight: 600; font-size: 14px;
  }
  .bad { color: #b42318; }
</style>
</head>
<body><div class="card"><div class="bar">&#9889; Neoxify</div><div class="body">${inner}</div></div></body>
</html>`;
}

export function verifiedPage(deepLink: string, alreadyVerified: boolean): string {
  const headline = alreadyVerified ? "Already verified" : "Email verified";
  const detail = alreadyVerified
    ? "This address was already confirmed, so there's nothing more to do."
    : "Your address is confirmed and your account is ready to use.";

  // The instruction comes before the button on purpose. This link is
  // usually opened on a phone, because that is where the email was read
  // -- and a phone has no Neoxify app, so the neoconnect:// button can
  // only fail there. Leading with it produced a browser error about a
  // missing app, which reads as "verification failed" when in fact it
  // had already succeeded before this page was rendered. Reported by a
  // customer who then went back to the app and was told their code had
  // expired.
  return shell(`
    <h1>${headline}</h1>
    <p>${detail}</p>
    <p><strong>You can close this page.</strong> Go back to the Neoxify app on your computer &mdash;
       it will pick this up on its own within a few seconds.</p>
    <p class="muted">On the computer where Neoxify is installed, you can also
       <a href="${deepLink}">open the app directly</a>. That link does nothing on a phone,
       which is fine &mdash; your email is confirmed either way.</p>
  `);
}

export function verificationFailedPage(reason: string): string {
  return shell(`
    <h1 class="bad">Couldn't verify this link</h1>
    <p>${reason}</p>
    <p class="muted">
      Verification links expire after 24 hours. Open the Neoxify app and request a new one,
      or enter the 6-digit code from your email instead.
    </p>
  `);
}
