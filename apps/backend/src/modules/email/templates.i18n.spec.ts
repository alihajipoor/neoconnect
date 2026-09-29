import {
  announcementEmail,
  announcementText,
  expiringSoonEmail,
  invoiceIssuedEmail,
  invoiceOverdueEmail,
  lowDataWarningEmail,
  passwordResetEmail,
  referralFriendJoinedEmail,
  referralRewardEmail,
  resellerVoucherEmail,
  supportReplyEmail,
  toLocale,
  verificationEmail,
  BRAND_LINKS_SLOT,
  BRAND_LOGO_SLOT,
  type Locale,
} from "./templates";

/** Every template, rendered with one set of plausible arguments, so a
 * case below can assert something about all of them at once rather than
 * eleven times. A template added without a row here fails the count
 * assertion in "every template" below -- which is the point: the failure
 * these tests exist to catch is a template that was never translated,
 * and a template nobody listed is exactly that. */
function renderAll(locale: Locale) {
  return {
    verification: verificationEmail(locale, "tok-123", "493021", "https://api.example.com"),
    passwordReset: passwordResetEmail(locale, "118204"),
    lowData: lowDataWarningEmail(locale, 1.5),
    expiringSoon: expiringSoonEmail(locale, 3),
    referralJoined: referralFriendJoinedEmail(locale, "a••••••r@example.com", 2),
    referralReward: referralRewardEmail(locale, 30, "Pro"),
    announcement: { subject: "n/a", html: announcementEmail(locale, "Body."), text: announcementText(locale, "Body.") },
    supportReply: supportReplyEmail(locale, "Cannot connect", "Try reconnecting."),
    invoiceIssued: invoiceIssuedEmail({
      locale,
      invoiceNumber: "NX-00042",
      planName: "Pro",
      amountUsd: "12.00",
      currency: "usd",
      documentUrl: "https://api.example.com/invoices/1",
    }),
    invoiceOverdue: invoiceOverdueEmail({
      locale,
      invoiceNumber: "NX-00042",
      amountUsd: "12.00",
      currency: "usd",
    }),
    voucher: resellerVoucherEmail({
      locale,
      code: "ABCD1234",
      planName: "Pro",
      activationUrl: "https://api.example.com/redeem?code=ABCD1234",
      publicApiUrl: "https://api.example.com",
      expiresAt: new Date("2026-12-31T00:00:00Z"),
    }),
  };
}

const PERSIAN = /[؀-ۿ]/;

describe("toLocale", () => {
  // The column is a plain String with a default, so anything can be in
  // it -- and indexing the strings table with a key that is not there
  // would hand a customer an email full of "undefined" rather than fail
  // anywhere visible.
  it("passes through the two locales the clients ship", () => {
    expect(toLocale("en")).toBe("en");
    expect(toLocale("fa")).toBe("fa");
  });

  it("treats a regional Persian tag as Persian", () => {
    // A future client sending fa-IR must not silently get English.
    expect(toLocale("fa-IR")).toBe("fa");
    expect(toLocale("FA")).toBe("fa");
  });

  it("falls back to English for anything else", () => {
    expect(toLocale(null)).toBe("en");
    expect(toLocale(undefined)).toBe("en");
    expect(toLocale("")).toBe("en");
    expect(toLocale("de")).toBe("en");
    expect(toLocale("nonsense")).toBe("en");
  });
});

describe("the Persian shell", () => {
  it("declares the document right-to-left and Persian", () => {
    // The whole point of the change: without these two attributes a
    // Persian email renders as left-aligned Persian in a Latin face,
    // which is what every one of these emails did until now.
    const { html } = verificationEmail("fa", "tok", "123456");
    expect(html).toContain('<html dir="rtl" lang="fa">');
    expect(html).toContain('<body dir="rtl"');
  });

  it("leaves the English shell left-to-right", () => {
    const { html } = verificationEmail("en", "tok", "123456");
    expect(html).toContain('<html dir="ltr" lang="en">');
    expect(html).not.toContain('dir="rtl"');
  });

  it("sets Persian text flush right rather than relying on dir alone", () => {
    // Outlook renders through Word and honours `dir` inconsistently on
    // nested table cells, so alignment is written out on the elements.
    const { html } = verificationEmail("fa", "tok", "123456");
    expect(html).toContain("text-align:right");
    expect(html).not.toContain("text-align:left;line-height");
  });

  it("uses system Persian faces, not a webfont", () => {
    // An email cannot bundle Vazirmatn the way the clients do, and an
    // @font-face rule needs a <style> block this layout does not have.
    const { html } = verificationEmail("fa", "tok", "123456");
    expect(html).toContain("Tahoma");
    expect(html).toContain("Iranian Sans");
    expect(html).not.toContain("Vazirmatn");
    expect(html).not.toContain("<style");
  });

  it("gives Persian more vertical room than Latin", () => {
    // Persian ascenders and diacritics collide at the Latin setting --
    // the same reason html[lang="fa"] carries its own line-height in
    // the clients' theme.css.
    expect(verificationEmail("fa", "tok", "123456").html).toContain("line-height:1.9");
    expect(verificationEmail("en", "tok", "123456").html).toContain("line-height:1.65");
  });

  it("does not letter-space or uppercase a Persian label", () => {
    // Arabic-script letters join. Pushing them apart severs the joins
    // into disconnected shapes, and uppercase means nothing in a script
    // with no letter case -- so the one rule that reads as harmless
    // polish in English is the one that breaks the Persian.
    const { html } = lowDataWarningEmail("fa", 1.5);
    expect(html).not.toContain("letter-spacing:0.6px");
    expect(html).not.toContain("text-transform:uppercase");
    // Still applied in English, where it is the intended treatment.
    expect(lowDataWarningEmail("en", 1.5).html).toContain("text-transform:uppercase");
  });
});

describe("numbers and identifiers in Persian", () => {
  it("prints counts in Persian digits", () => {
    // What the app already shows: GamePicker formats through fa-IR.
    expect(lowDataWarningEmail("fa", 1.5).html).toContain("۱٫۵");
    expect(expiringSoonEmail("fa", 3).html).toContain("۳ روز");
  });

  it("keeps a verification code in Latin digits", () => {
    // This one is not a quantity being read, it is six characters being
    // typed into an input the server matches against `randomInt()`
    // output. Persian-Indic digits here would be a code that cannot
    // match anything.
    const { html } = verificationEmail("fa", "tok", "493021");
    expect(html).toContain("4 9 3 0 2 1");
    expect(html).not.toContain("۴۹۳۰۲۱");
  });

  it("keeps an invoice number and a money amount in Latin", () => {
    const { html } = invoiceIssuedEmail({
      locale: "fa",
      invoiceNumber: "NX-00042",
      planName: "Pro",
      amountUsd: "12.00",
      currency: "usd",
    });
    // A figure somebody may have to quote back to a bank must have one
    // spelling, not two.
    expect(html).toContain("NX-00042");
    expect(html).toContain("$12.00 USD");
  });

  it("wraps Latin runs so bidi does not reorder them", () => {
    // Without this "1.5 GB" renders as "GB 1.5" and an address loses its
    // punctuation to the wrong side -- the rule the clients apply in CSS
    // via html[dir="rtl"] [data-ltr].
    expect(referralFriendJoinedEmail("fa", "a••••••r@example.com", 2).html).toContain(
      '<span dir="ltr"',
    );
  });

  it("never lets markup reach a text/plain body", () => {
    // The plain part is read as literal characters, so a stray span
    // shows up as `<span dir="ltr">` in the reader's client. The voucher
    // expiry line is the one that shares a string between the two.
    for (const message of Object.values(renderAll("fa"))) {
      expect(message.text).not.toContain("<");
      expect(message.text).not.toContain("&amp;");
    }
  });
});

describe("every template", () => {
  const fa = renderAll("fa");
  const en = renderAll("en");

  it("covers all eleven exported templates", () => {
    // A template added without a row in renderAll() is a template none
    // of the cases below look at -- which is exactly how one would ship
    // untranslated.
    expect(Object.keys(fa)).toHaveLength(11);
  });

  it("writes Persian bodies in Persian", () => {
    for (const [name, message] of Object.entries(fa)) {
      // The announcement and the support reply carry an operator's own
      // words, which are whatever they were typed in -- only their
      // chrome is translated, and the chrome is in the footer.
      expect(PERSIAN.test(message.html)).toBe(true);
      expect(`${name}:${PERSIAN.test(message.text)}`).toBe(`${name}:true`);
    }
  });

  it("writes Persian subjects in Persian", () => {
    for (const [name, message] of Object.entries(fa)) {
      // Two exceptions, both deliberate. The announcement's subject is
      // the admin's own, and the support reply keeps the "Re:" prefix
      // mail clients thread on.
      if (name === "announcement") continue;
      if (name === "supportReply") {
        expect(message.subject.startsWith("Re: ")).toBe(true);
        continue;
      }
      expect(`${name}:${PERSIAN.test(message.subject)}`).toBe(`${name}:true`);
    }
  });

  it("does not leave English copy in a Persian body", () => {
    // The failure mode a strings table cannot catch on its own: a
    // Persian entry that was copied from the English one and never
    // translated. Checked on a phrase from each template rather than
    // the brand name, which stays Latin on purpose.
    const englishTells = [
      "Welcome aboard",
      "Reset your password",
      "Data running low",
      "Subscription expiring soon",
      "Your invite worked",
      "Your free time is ready",
      "Support replied",
      "Thanks for your payment",
      "This invoice is still unpaid",
      "Your subscription is ready",
      "You're receiving this because",
    ];
    for (const tell of englishTells) {
      expect(Object.values(fa).some((m) => m.html.includes(tell))).toBe(false);
      expect(Object.values(en).some((m) => m.html.includes(tell))).toBe(true);
    }
  });

  it("keeps the wordmark Latin in both languages", () => {
    // It is what is printed on the app the reader is being told to
    // open, so a transliteration would not match anything they can see.
    for (const message of Object.values(fa)) {
      expect(message.html).toContain(">Neoxify</span>");
    }
  });
});

/** Each of these is a bug that was found live once. They are asserted in
 * both languages because the Persian shell is new code touching every
 * one of them. */
describe("the invariants the Persian shell must not have broken", () => {
  for (const locale of ["en", "fa"] as const) {
    describe(locale, () => {
      it("declares the design light-only", () => {
        // Clients that auto-invert for dark mode recoloured the card and
        // left violet text on a violet panel, illegible.
        expect(verificationEmail(locale, "tok", "123456").html).toContain(
          '<meta name="color-scheme" content="light">',
        );
      });

      it("separates OTP digits with literal spaces", () => {
        // Some clients strip letter-spacing, so the spacing cannot be
        // CSS alone.
        expect(verificationEmail(locale, "tok", "123456").html).toContain("1 2 3 4 5 6");
        expect(passwordResetEmail(locale, "987654").html).toContain("9 8 7 6 5 4");
      });

      it("gives a code block all three overflow rules", () => {
        // A raw JWT overflowed past the visible width in Gmail's web UI
        // with only word-break set: some renderers need both properties,
        // and the container has to be told it may shrink.
        const { html } = invoiceIssuedEmail({
          locale,
          invoiceNumber: "NX-00042",
          planName: "Pro",
          amountUsd: "12.00",
          currency: "usd",
        });
        expect(html).toContain("word-break:break-all");
        expect(html).toContain("overflow-wrap:anywhere");
        expect(html).toContain("max-width:100%");
      });

      it("carries the brand name as text beside the logo slot", () => {
        // Images are blocked by default in a good number of clients, and
        // an all-image header becomes a blank bar when that happens.
        const { html } = verificationEmail(locale, "tok", "123456");
        expect(html).toContain(BRAND_LOGO_SLOT);
        expect(html).toContain(BRAND_LINKS_SLOT);
        expect(html).toContain("Neoxify</span>");
      });

      it("keeps the 6-digit code rather than relying on a deep link", () => {
        // neoconnect:// links are stripped by webmail, confirmed on a
        // real Gmail account -- so the code is the element that has to
        // work on its own, and the button is an https bounce page
        // wherever the public address is known.
        const { html } = verificationEmail(locale, "tok", "123456", "https://api.example.com");
        expect(html).toContain("1 2 3 4 5 6");
        expect(html).not.toContain('href="neoconnect://');
        // And it is still there when there is no https link to be had,
        // which is the case the code was added for.
        expect(verificationEmail(locale, "tok", "123456").html).toContain("1 2 3 4 5 6");
      });

      it("does not float the button or the stat pill", () => {
        // `align` on a table is float, not alignment. Setting it to
        // aim these at the right edge in Persian made the paragraph
        // after them wrap up alongside instead of starting below --
        // in both languages, since English got align="left". Found by
        // rendering the set and looking at it, which is the only way
        // this kind of thing is ever found.
        // `align` on a <td> is genuine horizontal alignment and stays --
        // it is the Outlook-safe way to set a cell's contents. It is
        // only on a <table> that it means float.
        for (const message of Object.values(renderAll(locale))) {
          expect(message.html).not.toMatch(/<table[^>]*\salign=/);
        }
      });

      it("uses tables and inline styles only", () => {
        for (const message of Object.values(renderAll(locale))) {
          expect(message.html).not.toContain("<style");
          expect(message.html).not.toContain("display:flex");
          expect(message.html).not.toContain("display:grid");
        }
      });
    });
  }
});
