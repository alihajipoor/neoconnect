import type { Page } from "../alerting/pager.service";
import { signInAlert, wrongPasswordsAlert } from "../auth/admin-sign-in-alerts.emails";
import {
  digestPage,
  groupedPage,
  likelyBlockedPage,
  recoveriesPage,
  remindersPage,
  type IncidentView,
} from "../block-watch/block-watch.messages";
import { EMAIL_LOGO_FILES, EMAIL_LOGOS } from "../brand/email-logo";
import { BRAND_LOGO_PNG } from "../brand/logo";
import { heartbeatGapPage, heartbeatReturnPage } from "../nodes/heartbeat-gap.messages";
import { reachabilityAlertEmail, reachabilityRecoveryEmail } from "../reachability/reachability.emails";
import { relayOperatorMail } from "../relay-auth/relay-alerts";
import { panelUrlFrom } from "./email-brand.service";
import {
  BRAND_LINKS_SLOT,
  BRAND_LOGO_SLOT,
  fillBrandSlots,
  invoiceIssuedEmail,
  operationsEmail,
  opsTime,
  opsTitle,
  resellerVoucherEmail,
  supportReplyEmail,
  verificationEmail,
} from "./templates";

/** The design system the emails share: the parts that are not about
 * language (templates.i18n.spec.ts has those) -- the button, the codes,
 * the staff shell, and what fills the brand slots. */

describe("the button", () => {
  const { html } = verificationEmail("en", "tok", "123456", "https://api.example.com");

  it("carries its colour three ways, so it is a button in every client", () => {
    // Outlook reads the attribute, a client without gradients reads the
    // solid, and the rest draw the gradient. White text has to be
    // readable on whichever one a client stops at.
    expect(html).toContain('bgcolor="#1045ff"');
    expect(html).toContain("background-color:#1045ff");
    expect(html).toContain("background-image:linear-gradient(135deg,#7c3aed 0%,#1045ff 100%)");
    expect(html).toContain("color:#ffffff");
  });

  it("keeps its padding in Outlook", () => {
    // Word ignores padding on a link; without this the button shrinks
    // to its text.
    expect(html).toContain("mso-padding-alt:13px 28px");
  });
});

describe("codes", () => {
  it("sets a twelve-character voucher code in fours", () => {
    // Spaced letter by letter it is twenty-three characters and wraps on
    // every phone. The redeem path strips spaces, so the grouping is free.
    const { html, text } = resellerVoucherEmail({
      locale: "en",
      code: "ABCDEFGH2345",
      planName: "Pro",
      activationUrl: "https://example.com/account/?voucher=ABCDEFGH2345",
    });
    expect(html).toContain("ABCD EFGH 2345");
    // The copy somebody pastes is still the code as issued.
    expect(text).toContain("Activation code: ABCDEFGH2345");
  });

  it("says what an invoice number is", () => {
    const { html } = invoiceIssuedEmail({
      locale: "en",
      invoiceNumber: "NX-00042",
      planName: "Pro",
      amountUsd: "12.00",
      currency: "usd",
    });
    expect(html.indexOf("Invoice number")).toBeLessThan(html.indexOf("NX-00042</div>"));
  });
});

describe("the support reply", () => {
  it("escapes the operator's words in the preheader as well as the body", () => {
    const { html } = supportReplyEmail("en", "Help", 'Use a < b, not <img src="x">.');
    expect(html).not.toContain("<img");
    expect(html).toContain("a &lt; b");
  });
});

describe("operationsEmail", () => {
  const html = operationsEmail({
    severity: "urgent",
    title: "node-a is likely blocked",
    facts: [
      { label: "What", value: "Likely blocked" },
      { label: "Since", value: "2026-11-10 06:30 UTC\nabout 3 h ago" },
    ],
    body: "Evidence:\n- first\n- second\n\nA second paragraph.",
    panel: { path: "/block-watch", label: "Open Block watch" },
    note: "Nothing has been changed automatically.",
  });

  it("is the shared frame, in English, left to right", () => {
    expect(html).toContain('<html dir="ltr" lang="en">');
    expect(html).toContain(BRAND_LOGO_SLOT);
    expect(html).toContain(">Neoxify</span>");
    expect(html).toContain("max-width:600px");
  });

  it("is not customer mail", () => {
    // No account notice, no community links, and above all no way to
    // unsubscribe: an operator who unsubscribes from their own outage
    // alerts has turned monitoring off.
    expect(html).not.toContain("You're receiving this because");
    expect(html).not.toContain(BRAND_LINKS_SLOT);
    expect(html.toLowerCase()).not.toContain("unsubscribe");
    expect(html).toContain("Operations mail for the owners of this Neoxify panel.");
  });

  it("leads with how serious it is", () => {
    expect(html).toContain('class="nx-chip-urgent"');
    expect(html).toContain("&nbsp;Urgent</td>");
    expect(html.indexOf('class="nx-chip-urgent"')).toBeLessThan(html.indexOf("node-a is likely blocked</h1>"));
    expect(operationsEmail({ severity: "info", chip: "Resolved", title: "t" })).toContain("&nbsp;Resolved</td>");
    expect(operationsEmail({ severity: "warning", title: "t" })).toContain("&nbsp;Warning</td>");
  });

  it("sets the facts out as a two-column table", () => {
    expect(html).toMatch(/<td[^>]*width="30%"[^>]*>What<\/td>\s*<td[^>]*>Likely blocked<\/td>/);
    // A newline in a value is a line break, not a run-on.
    expect(html).toContain("2026-11-10 06:30 UTC<br>about 3 h ago");
  });

  it("turns the text's lists and headings into something readable", () => {
    expect(html).toContain('<span style="font-weight:600;">Evidence:</span><br>&bull;&nbsp;first<br>&bull;&nbsp;second');
    expect(html).toContain("A second paragraph.</p>");
  });

  it("escapes everything it is given", () => {
    const hostile = operationsEmail({
      severity: "info",
      chip: "<i>chip",
      title: 'a<b>"title',
      facts: [{ label: "<label>", value: "<value>" }],
      body: "<script>alert(1)</script>",
      note: "<note>",
    });
    for (const raw of ["<i>", "<b>", "<label>", "<value>", "<script>", "<note>"]) {
      expect(hostile).not.toContain(raw);
    }
    expect(hostile).toContain("a&lt;b&gt;&quot;title");
  });

  it("asks for a panel button only with a path and label that are safe to carry", () => {
    expect(html).toContain("<!--neoxify:panel:/block-watch|Open Block watch-->");
    const unsafe = operationsEmail({
      severity: "info",
      title: "t",
      panel: { path: '/x"><script>', label: "Open" },
    });
    expect(unsafe).not.toContain("neoxify:panel");
  });
});

describe("opsTime and opsTitle", () => {
  it("prints a moment the way a person reads it, in UTC", () => {
    expect(opsTime(new Date("2026-11-10T06:30:45.123Z"))).toBe("2026-11-10 06:30 UTC");
    expect(opsTime("2026-11-10T06:30:00.000Z")).toBe("2026-11-10 06:30 UTC");
  });

  it("drops the inbox tag from a subject", () => {
    expect(opsTitle("[Neoxify] node-a is unreachable")).toBe("node-a is unreachable");
    expect(opsTitle("Neoxify panel: sign-in")).toBe("Neoxify panel: sign-in");
  });
});

describe("every staff mail", () => {
  const now = new Date("2026-11-10T09:30:00Z");
  const incident = (nodeName: string): IncidentView => ({
    nodeName,
    openedAt: new Date("2026-11-10T06:30:00Z"),
    evidence: {
      evaluatedAt: now.toISOString(),
      current: "LIKELY_BLOCKED",
      reason: "two signals agree",
      since: {},
      families: [
        { family: "client", firing: true, thin: false, healthy: false, onset: null, summary: "Apps: 14 of 17 failed", networks: [] },
        { family: "traffic", firing: false, thin: true, healthy: false, onset: null, summary: "Traffic: too little", networks: [] },
      ],
      outage: null,
      blockType: "address",
      thinResidential: false,
      country: "zz",
    },
  });
  /** What PagerService does with a page. */
  const paged = (page: Page) => ({
    subject: page.subject,
    text: page.text,
    html: operationsEmail({ severity: "info", body: page.text, ...page.mail, title: opsTitle(page.subject) }),
  });
  const admin = { email: "owner@example.com", role: "SUPERADMIN" };

  const mails = {
    blockLikely: paged(likelyBlockedPage(incident("node-a"), now)),
    blockGrouped: paged(groupedPage([incident("node-a"), incident("node-b")], 1, now)),
    blockReminder: paged(remindersPage([incident("node-a")], now)),
    blockReminders: paged(remindersPage([incident("node-a"), incident("node-b")], now)),
    blockRecovered: paged(recoveriesPage([{ ...incident("node-a"), closedAt: now }], now)),
    blockRecoveredMany: paged(
      recoveriesPage([{ ...incident("node-a"), closedAt: now }, { ...incident("node-b"), closedAt: now }], now),
    ),
    blockDigest: paged(
      digestPage(
        {
          open: [incident("node-a")],
          cleared: [],
          undelivered: [],
          reopened: [],
          heldProbeAlerts: [],
          calibrating: false,
          country: "zz",
        },
        now,
      ),
    ),
    heartbeatGap: paged(heartbeatGapPage([{ name: "node-a", since: "2026-11-10T09:18:00.000Z", minutes: 12 }])),
    heartbeatBack: paged(heartbeatReturnPage([{ name: "node-a", pagedAt: now }])),
    signIn: signInAlert(admin, "203.0.113.10 (Example ISP, DE)", true, now),
    signInPasswordOnly: signInAlert(admin, "203.0.113.10 (Example ISP, DE)", false, now),
    wrongPasswords: wrongPasswordsAlert(admin, 25, "203.0.113.10"),
    reachabilityAlert: reachabilityAlertEmail("node-a", "zz", 3, 443),
    reachabilityRecovery: reachabilityRecoveryEmail("node-a", "zz", 95),
    relay: relayOperatorMail("Traffic has dropped", "The numbers."),
  };

  it("is on the operations shell, with a chip", () => {
    for (const [name, mail] of Object.entries(mails)) {
      expect(`${name}:${mail.html.includes("Operations mail for the owners of this Neoxify panel.")}`).toBe(`${name}:true`);
      expect(`${name}:${/class="nx-chip-(info|warning|urgent)"/.test(mail.html)}`).toBe(`${name}:true`);
      expect(mail.html).toContain(BRAND_LOGO_SLOT);
    }
  });

  it("keeps a complete plain-text alternative, with no markup in it", () => {
    for (const [name, mail] of Object.entries(mails)) {
      expect(`${name}:${mail.text.trim().length > 20 || name === "relay"}`).toBe(`${name}:true`);
      expect(mail.text).not.toContain("<");
      expect(mail.text).not.toContain("&nbsp;");
    }
  });

  it("puts the key facts in a table wherever the caller knows them", () => {
    for (const [name, mail] of Object.entries(mails)) {
      // The bare relay form is the one staff mail that is given only a
      // subject and a sentence.
      if (name === "relay") continue;
      expect(`${name}:${mail.html.includes('width="30%"')}`).toBe(`${name}:true`);
      expect(`${name}:${mail.html.includes(">What to do</td>")}`).toBe(`${name}:true`);
    }
  });

  it("grades them calmly", () => {
    expect(mails.blockLikely.html).toContain('class="nx-chip-urgent"');
    expect(mails.heartbeatGap.html).toContain('class="nx-chip-urgent"');
    expect(mails.blockReminder.html).toContain("&nbsp;Reminder</td>");
    expect(mails.blockRecovered.html).toContain("&nbsp;Resolved</td>");
    expect(mails.reachabilityAlert.html).toContain('class="nx-chip-warning"');
    expect(mails.reachabilityRecovery.html).toContain('class="nx-chip-info"');
    // A sign-in is routine with a second factor, and worth a look without.
    expect(mails.signIn.html).toContain('class="nx-chip-info"');
    expect(mails.signInPasswordOnly.html).toContain('class="nx-chip-warning"');
  });

  it("does not repeat the whole text under a facts table that already says it", () => {
    // The text is the plain part. The html shows the facts once.
    expect(mails.heartbeatGap.html).not.toContain("The agent on node-a has sent no heartbeat");
    expect(mails.heartbeatGap.text).toContain("The agent on node-a has sent no heartbeat");
  });
});

describe("fillBrandSlots", () => {
  const en = verificationEmail("en", "tok", "123456").html;
  const fa = verificationEmail("fa", "tok", "123456").html;
  const none = { links: [] };

  it("puts the logo in as an image that holds its place when blocked", () => {
    const html = fillBrandSlots(en, { ...none, logoBaseUrl: "https://api.example.com/brand" });
    expect(html).not.toContain(BRAND_LOGO_SLOT);
    expect(html).toContain('src="https://api.example.com/brand/email-logo-light-2x.png" width="40" height="40" alt=""');
    expect(html).toContain('src="https://api.example.com/brand/email-logo-dark-2x.png" width="40" height="40" alt=""');
  });

  it("shows the pearl plate unless the style block says dark", () => {
    const html = fillBrandSlots(en, { ...none, logoBaseUrl: "https://api.example.com/brand" });
    expect(html).toMatch(/class="nx-logo-l"[^>]*style="display:inline-block;/);
    expect(html).toMatch(/class="nx-logo-d"[^>]*style="display:none;/);
    // Word shows a `display:none` image anyway, so Outlook never gets it.
    expect(html).toContain('<!--[if !mso]><!--><img class="nx-logo-d"');
    expect(html).toContain(".nx-logo-d{display:inline-block!important;}");
  });

  it("puts the gap on the wordmark's side in either direction", () => {
    const base = { ...none, logoBaseUrl: "https://api.example.com/brand" };
    expect(fillBrandSlots(en, base)).toContain("margin:0 10px 0 0;");
    expect(fillBrandSlots(fa, base)).toContain("margin:0 0 0 10px;");
  });

  it("leaves the wordmark alone when there is nowhere to fetch a logo from", () => {
    const html = fillBrandSlots(en, none);
    expect(html).not.toContain(BRAND_LOGO_SLOT);
    expect(html).not.toContain("<img");
    expect(html).toContain(">Neoxify</span>");
  });

  it("names the footer links in the reader's language", () => {
    const links = [
      { kind: "website" as const, url: "https://example.com" },
      { kind: "telegram" as const, url: "https://example.com/t" },
    ];
    const english = fillBrandSlots(en, { links });
    expect(english).toContain('href="https://example.com"');
    expect(english).toContain(">Website</a>");
    expect(english).toContain(">Telegram</a>");
    const persian = fillBrandSlots(fa, { links });
    expect(persian).toContain(">وب‌سایت</a>");
    expect(persian).toContain(">تلگرام</a>");
    expect(persian).not.toContain(">Website</a>");
  });

  it("renders no links row when none are set", () => {
    const html = fillBrandSlots(en, none);
    expect(html).not.toContain(BRAND_LINKS_SLOT);
    expect(html).not.toContain("&middot;");
  });

  it("escapes an operator-entered link and does not read it as a pattern", () => {
    const html = fillBrandSlots(en, { links: [{ kind: "website", url: 'https://example.com/?a=$&"><b>' }] });
    expect(html).toContain('href="https://example.com/?a=$&amp;&quot;&gt;&lt;b&gt;"');
  });

  it("draws the panel button when the panel's address is known, and nothing when it is not", () => {
    const ops = operationsEmail({
      severity: "info",
      title: "t",
      panel: { path: "/block-watch", label: "Open Block watch" },
    });
    const known = fillBrandSlots(ops, { ...none, panelUrl: "https://panel.example.com" });
    expect(known).toMatch(/<a href="https:\/\/panel\.example\.com\/block-watch"[^>]*>Open Block watch<\/a>/);
    const unknown = fillBrandSlots(ops, none);
    expect(unknown).not.toContain("neoxify:panel");
    expect(unknown).not.toContain("Open Block watch");
  });
});

describe("panelUrlFrom", () => {
  it("takes the panel to be where the API is, less its /api", () => {
    expect(panelUrlFrom("https://panel.example.com/api")).toBe("https://panel.example.com");
    expect(panelUrlFrom("https://panel.example.com/api/")).toBe("https://panel.example.com");
  });

  it("does not guess from any other shape", () => {
    // A button in an outage alert that opens the wrong site is worse
    // than no button.
    expect(panelUrlFrom(undefined)).toBeUndefined();
    expect(panelUrlFrom("")).toBeUndefined();
    expect(panelUrlFrom("https://api.example.com")).toBeUndefined();
    expect(panelUrlFrom("https://example.com/v1/api")).toBeUndefined();
  });
});

describe("the email logo files", () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it("are the rendered plates, not the fallback", () => {
    // email-logo.ts falls back to the flat mark when a file is missing,
    // so the API still boots. That is right in production and would
    // hide a deleted asset here.
    for (const file of EMAIL_LOGO_FILES) {
      const png = EMAIL_LOGOS[file];
      expect(png.subarray(0, 8).equals(PNG)).toBe(true);
      expect(png.equals(BRAND_LOGO_PNG)).toBe(false);
      // IHDR: width then height, big-endian, straight after the header.
      const size = file.includes("-2x") ? 80 : 40;
      expect(`${file}:${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`).toBe(`${file}:${size}x${size}`);
    }
  });
});
