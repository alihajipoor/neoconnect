// Renders every email the backend sends to a folder of standalone HTML
// files, for looking at.
//
//   cd apps/backend
//   pnpm exec ts-node --transpile-only --project tsconfig.json ../../scripts/email-previews/render.ts <out-dir>
//   node ../../scripts/email-previews/shoot.mjs <out-dir>
//
// The first command writes one .html (and the .txt alternative) per email
// plus index.html; the second screenshots each at 600 and 380 pixels wide.
// Give it a folder outside the repo: the output is for review, not for
// committing.
//
// Nothing here is sent anywhere. The templates are called exactly as the
// services call them, with made-up data: documentation addresses
// (203.0.113.0/24, example.com) and server names that belong to nobody.
// The brand slots are filled the way EmailBrandService fills them, except
// that the logo is read from a copy beside the files rather than from the
// API, so the previews work offline.

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  announcementEmail,
  announcementText,
  expiringSoonEmail,
  fillBrandSlots,
  invoiceIssuedEmail,
  invoiceOverdueEmail,
  lowDataWarningEmail,
  operationsEmail,
  opsTitle,
  passwordResetEmail,
  referralFriendJoinedEmail,
  referralRewardEmail,
  resellerVoucherEmail,
  supportReplyEmail,
  verificationEmail,
  type Locale,
} from "../../apps/backend/src/modules/email/templates";
import type { Page } from "../../apps/backend/src/modules/alerting/pager.service";
import {
  digestPage,
  groupedPage,
  likelyBlockedPage,
  recoveriesPage,
  remindersPage,
  type IncidentView,
} from "../../apps/backend/src/modules/block-watch/block-watch.messages";
import { heartbeatGapPage, heartbeatReturnPage } from "../../apps/backend/src/modules/nodes/heartbeat-gap.messages";
import { signInAlert, wrongPasswordsAlert } from "../../apps/backend/src/modules/auth/admin-sign-in-alerts.emails";
import {
  reachabilityAlertEmail,
  reachabilityRecoveryEmail,
} from "../../apps/backend/src/modules/reachability/reachability.emails";
import {
  RELAY_PANEL,
  relayOperatorMail,
  relayReadingFacts,
} from "../../apps/backend/src/modules/relay-auth/relay-alerts";

interface Rendered {
  /** File name without extension. */
  name: string;
  group: "customer" | "operations";
  title: string;
  subject: string;
  html: string;
  text: string;
}

const out = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: ts-node render.ts <out-dir>");
  process.exit(1);
}

const API = "https://panel.example.com/api";
const SITE = "https://example.com";

// ------------------------------------------------------------ customer

function customer(locale: Locale): Rendered[] {
  const announcement =
    locale === "fa"
      ? "امشب از ساعت ۲ تا ۳ بامداد روی سرورها کار می‌کنیم.\n\nدر این یک ساعت ممکن است اتصال شما چند بار قطع و وصل شود. لازم نیست کاری بکنید."
      : "We're doing maintenance tonight between 02:00 and 03:00 UTC.\n\nYour connection may drop and come back a few times in that hour. You don't need to do anything.";
  const reply =
    locale === "fa"
      ? "سلام،\nممنون که خبر دادید. مشکل از سمت ما بود و برطرف شد.\n\nاگر باز هم وصل نشد، برنامه را یک بار ببندید و دوباره باز کنید."
      : "Hi,\nThanks for letting us know. The fault was on our side and it is fixed now.\n\nIf it still won't connect, close the app once and open it again.";

  const items: [string, string, { subject: string; html: string; text: string }][] = [
    ["verification", "Verification", verificationEmail(locale, "tok-123", "493021", API)],
    ["password-reset", "Password reset", passwordResetEmail(locale, "118204")],
    ["low-data", "Low data", lowDataWarningEmail(locale, 1.5)],
    ["expiring-soon", "Expiring soon", expiringSoonEmail(locale, 3)],
    ["referral-joined", "Referral: friend joined", referralFriendJoinedEmail(locale, "a••••••r@example.com", 2)],
    ["referral-reward", "Referral: reward", referralRewardEmail(locale, 30, "Pro")],
    [
      "announcement",
      "Announcement",
      {
        subject: locale === "fa" ? "کار روی سرورها، امشب" : "Maintenance tonight",
        html: announcementEmail(locale, announcement),
        text: announcementText(locale, announcement),
      },
    ],
    ["support-reply", "Support reply", supportReplyEmail(locale, locale === "fa" ? "وصل نمی‌شود" : "Cannot connect", reply)],
    [
      "invoice-issued",
      "Invoice issued",
      invoiceIssuedEmail({
        locale,
        invoiceNumber: "NX-00042",
        planName: "Pro",
        amountUsd: "12.00",
        currency: "usd",
        documentUrl: `${API}/invoices/view/sample`,
      }),
    ],
    [
      "invoice-overdue",
      "Invoice overdue",
      invoiceOverdueEmail({
        locale,
        invoiceNumber: "NX-00042",
        amountUsd: "12.00",
        currency: "usd",
        documentUrl: `${API}/invoices/view/sample`,
      }),
    ],
    [
      "voucher",
      "Reseller voucher",
      resellerVoucherEmail({
        locale,
        code: "ABCDEFGH2345",
        planName: "Pro",
        activationUrl: `${SITE}/account/?voucher=ABCDEFGH2345`,
        publicApiUrl: API,
        expiresAt: new Date("2026-12-31T00:00:00Z"),
      }),
    ],
  ];
  return items.map(([name, title, mail]) => ({
    name: `customer-${name}-${locale}`,
    group: "customer",
    title: `${title} (${locale})`,
    ...mail,
  }));
}

// ---------------------------------------------------------- operations

const NOW = new Date("2026-11-10T09:30:00Z");

function incident(nodeName: string, hoursAgo: number, likely = true): IncidentView {
  return {
    nodeName,
    openedAt: new Date(NOW.getTime() - hoursAgo * 3_600_000),
    evidence: {
      evaluatedAt: NOW.toISOString(),
      current: likely ? "LIKELY_BLOCKED" : "SUSPECT",
      reason: likely ? "two independent signals agree: app reports and the probe" : "app reports alone",
      since: {},
      families: [
        {
          family: "client",
          firing: true,
          thin: false,
          healthy: false,
          onset: null,
          summary: "Apps: 14 of 17 customers on 3 networks could not connect in the last 2 h; before, 1 of 19",
          networks: [],
        },
        {
          family: "probe",
          firing: likely,
          thin: false,
          healthy: false,
          onset: null,
          summary: "Probe: 7 of 8 vantages could not open a connection, 3 checks in a row",
          networks: [],
        },
        {
          family: "traffic",
          firing: false,
          thin: true,
          healthy: false,
          onset: null,
          summary: "Traffic: too little history to judge (4 sending in the last 6 h, usually 11 on 2 comparable days)",
          networks: [],
        },
      ],
      outage: null,
      blockType: likely ? "address" : null,
      thinResidential: false,
      country: "ir",
      clearing: null,
    },
  };
}

/** What PagerService.page does with a page, without the sending. */
function paged(name: string, title: string, page: Page): Rendered {
  return {
    name: `ops-${name}`,
    group: "operations",
    title,
    subject: page.subject,
    text: page.text,
    html: operationsEmail({ severity: "info", body: page.text, ...page.mail, title: opsTitle(page.subject) }),
  };
}

function operations(): Rendered[] {
  const mailed = (name: string, title: string, mail: { subject: string; html: string; text: string }): Rendered => ({
    name: `ops-${name}`,
    group: "operations",
    title,
    ...mail,
  });
  const reading = { ir: 12, irMedian: 240, other: 510, otherMedian: 495 };
  const cleared = { ...incident("node-b", 9), closedAt: NOW };
  cleared.evidence = { ...cleared.evidence, current: null, clearing: "the probes connect and traffic is back near usual" };

  return [
    paged("block-likely", "Block watch: likely blocked", likelyBlockedPage(incident("node-a", 3), NOW)),
    paged(
      "block-grouped",
      "Block watch: several at once",
      groupedPage([incident("node-a", 1), incident("node-b", 1), incident("node-c", 1)], 1, NOW),
    ),
    paged("block-reminder", "Block watch: reminder", remindersPage([incident("node-a", 26)], NOW)),
    paged("block-recovered", "Block watch: recovered", recoveriesPage([cleared], NOW)),
    paged(
      "block-digest",
      "Block watch: daily digest",
      digestPage(
        {
          open: [incident("node-a", 26), incident("node-d", 5, false)],
          cleared: [cleared],
          undelivered: [],
          reopened: [],
          heldProbeAlerts: ["node-a"],
          inside: ["node-a: failed 31 of 48 data checks", "node-d: failed 2 of 48 data checks"],
          calibrating: false,
          country: "ir",
        },
        NOW,
      ),
    ),
    paged(
      "heartbeat-gap",
      "Heartbeat gap",
      heartbeatGapPage([{ name: "node-a", since: "2026-11-10T09:18:00.000Z", minutes: 12 }]),
    ),
    paged(
      "heartbeat-gap-many",
      "Heartbeat gap: several",
      heartbeatGapPage([
        { name: "node-a", since: "2026-11-10T09:18:00.000Z", minutes: 12 },
        { name: "node-b", since: "2026-11-10T09:19:00.000Z", minutes: 11 },
      ]),
    ),
    paged(
      "heartbeat-back",
      "Heartbeat back",
      heartbeatReturnPage([{ name: "node-a", pagedAt: new Date("2026-11-10T09:30:00Z") }]),
    ),
    mailed(
      "sign-in",
      "Admin sign-in (two-factor)",
      signInAlert({ email: "owner@example.com", role: "SUPERADMIN" }, "203.0.113.10 (Example ISP, DE)", true, NOW),
    ),
    mailed(
      "sign-in-password-only",
      "Admin sign-in (password only)",
      signInAlert({ email: "owner@example.com", role: "SUPERADMIN" }, "203.0.113.10 (Example ISP, DE)", false, NOW),
    ),
    mailed(
      "wrong-passwords",
      "Wrong passwords",
      wrongPasswordsAlert({ email: "owner@example.com", role: "SUPERADMIN" }, 25, "203.0.113.77 (Example Hosting, NL)"),
    ),
    mailed("reachability-alert", "Reachability: unreachable", reachabilityAlertEmail("node-a", "ir", 3, 443)),
    mailed("reachability-recovery", "Reachability: recovered", reachabilityRecoveryEmail("node-a", "ir", 95)),
    mailed(
      "relay-drop",
      "Relay: traffic dropped",
      relayOperatorMail(
        "Iranian traffic has dropped: possible national intranet",
        "Iranian requests on the normal routes in the last half hour: 12 (7-day median 240); everyone else: 510 (median 495). " +
          "This has held for 30 minutes. It can also mean only our domains are blocked in Iran. " +
          "Nothing customers see has changed. If Iran's international links are cut, declare the intranet in " +
          "Panel -> Settings -> Relay sign-up. If it holds another 30 minutes, relay sign-up caps rise to the intranet tier.",
        {
          severity: "warning",
          facts: [
            { label: "What", value: "Requests from Iran have dropped while everyone else's have not" },
            ...relayReadingFacts(reading),
            { label: "Held for", value: "30 minutes" },
            { label: "How sure", value: "Unsure. It can be a national intranet, or only our domains being blocked in Iran." },
            {
              label: "What to do",
              value:
                "If Iran's international links are cut, declare the intranet under Settings, Relay sign-up. " +
                "If the drop holds another 30 minutes, relay sign-up caps rise to the intranet tier on their own.",
            },
          ],
          body: "",
          panel: RELAY_PANEL,
          note: "Nothing customers see has changed.",
        },
      ),
    ),
    mailed(
      "relay-recovered",
      "Relay: traffic recovered",
      relayOperatorMail(
        "Iranian traffic has recovered",
        "Iranian requests on the normal routes in the last half hour: 231 (7-day median 240); everyone else: 502 (median 495). " +
          "The drop is over; relay sign-up caps are back to normal.",
        {
          severity: "info",
          chip: "Resolved",
          facts: [
            { label: "What", value: "The drop is over; relay sign-up caps are back to normal" },
            ...relayReadingFacts({ ir: 231, irMedian: 240, other: 502, otherMedian: 495 }),
            { label: "What to do", value: "Nothing." },
          ],
          body: "",
          panel: RELAY_PANEL,
        },
      ),
    ),
  ];
}

// --------------------------------------------------------------- write

mkdirSync(join(out, "brand"), { recursive: true });
const assets = resolve(__dirname, "../../apps/backend/src/modules/brand/assets");
for (const file of readdirSync(assets)) copyFileSync(join(assets, file), join(out, "brand", file));

const all = [...customer("en"), ...customer("fa"), ...operations()];
for (const mail of all) {
  const html = fillBrandSlots(mail.html, {
    logoBaseUrl: "brand",
    panelUrl: "https://panel.example.com",
    links:
      mail.group === "customer"
        ? [
            { kind: "website", url: SITE },
            { kind: "telegram", url: `${SITE}/telegram` },
            { kind: "instagram", url: `${SITE}/instagram` },
          ]
        : [],
  });
  writeFileSync(join(out, `${mail.name}.html`), html);
  writeFileSync(join(out, `${mail.name}.txt`), `Subject: ${mail.subject}\n\n${mail.text}\n`);
}

writeFileSync(
  join(out, "manifest.json"),
  JSON.stringify(
    all.map(({ name, group, title, subject }) => ({ name, group, title, subject })),
    null,
    2,
  ),
);

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const card = (mail: Rendered) => `
  <article>
    <h3>${esc(mail.title)}</h3>
    <p class="subject" dir="auto">${esc(mail.subject)}</p>
    <p class="links"><a href="${mail.name}.html">html</a> · <a href="${mail.name}.txt">text</a> ·
      <a href="shots/${mail.name}-600.png">600px</a> · <a href="shots/${mail.name}-380.png">380px</a></p>
    <a href="${mail.name}.html"><img loading="lazy" src="shots/${mail.name}-380.png" alt=""></a>
  </article>`;
const section = (heading: string, group: Rendered["group"]) =>
  `<h2>${heading}</h2><div class="grid">${all.filter((m) => m.group === group).map(card).join("")}</div>`;

writeFileSync(
  join(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Email previews</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body { margin: 0; padding: 32px; background: #f1f3f6; color: #090b10;
         font: 14px/1.5 Inter, system-ui, "Segoe UI", sans-serif; }
  h1 { font-size: 24px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 4px; }
  h2 { font-size: 16px; font-weight: 600; margin: 36px 0 14px; }
  .note { color: #4a5264; margin: 0; max-width: 70ch; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px; }
  article { background: #fff; border: 1px solid #dee0e5; border-radius: 18px; padding: 16px; }
  h3 { font-size: 14px; font-weight: 600; margin: 0; }
  .subject { color: #4a5264; margin: 2px 0 6px; font-size: 13px; }
  .links { margin: 0 0 10px; font-size: 12px; }
  a { color: #0b3be0; text-decoration: none; }
  img { display: block; width: 100%; border-radius: 10px; border: 1px solid #e8eaef; }
</style></head><body>
<h1>Email previews</h1>
<p class="note">${all.length} emails, rendered from the templates with sample data. The thumbnails are the 380px
(phone) screenshots; each card links to the live HTML, the plain-text alternative and both screenshots.
A browser is not a mail client: Gmail, Apple Mail and Outlook each strip or rewrite parts of this.</p>
${section("Customer emails", "customer")}
${section("Operations emails", "operations")}
</body></html>`,
);

console.log(`${all.length} emails written to ${out}`);
