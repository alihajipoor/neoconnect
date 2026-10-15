/** Throwaway-mail domains, refused for relay sign-up only (R3.1).
 *
 * A relay account skips verification, so the address it gives is the
 * only thing that can ever prove it belongs to someone; a throwaway one
 * proves nothing and is the cheapest way to farm accounts. Normal sign-up
 * is unaffected -- it proves the mailbox, which is what matters there.
 *
 * Not exhaustive and not meant to be: the caps and the proof of work do
 * the real limiting. This keeps out the services a script reaches for
 * first. A subdomain of a listed domain is refused too.
 */
const DISPOSABLE = new Set([
  "10minutemail.com",
  "10minutemail.net",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "20minutemail.com",
  "33mail.com",
  "burnermail.io",
  "byom.de",
  "dispostable.com",
  "discard.email",
  "dropmail.me",
  "emailondeck.com",
  "emailfake.com",
  "fakeinbox.com",
  "fakemail.net",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "harakirimail.com",
  "inboxkitten.com",
  "mail.tm",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailinator.net",
  "mailnesia.com",
  "mailpoof.com",
  "mintemail.com",
  "mohmal.com",
  "moakt.com",
  "mytemp.email",
  "nada.email",
  "sharklasers.com",
  "spam4.me",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.dev",
  "tempmail.net",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "tmail.ws",
  "tmpmail.net",
  "tmpmail.org",
  "trashmail.com",
  "trashmail.de",
  "trashmail.net",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
]);

export function isDisposableEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@").pop() ?? "";
  const labels = domain.split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (DISPOSABLE.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
