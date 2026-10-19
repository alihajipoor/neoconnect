import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The shared code keeps its state in localStorage (src/shims/plugin-store.ts)
// and reads it as it loads; node has none, so a Map stands in.
vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
});

import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@shared/lib/i18n";
import { RecoveryCodeNotice } from "@shared/components/BackupRoute";
import { AuthShell, LANGUAGE_STORE, RecoveryStep } from "./AuthShell";
import { beforeSubmit } from "./controls";
import { PortalLogin } from "./PortalLogin";
import { PortalRegister } from "./PortalRegister";
import { PortalVerifyEmail } from "./PortalVerifyEmail";
import { PortalForgotPassword } from "./PortalForgotPassword";
import { COPY } from "./copy";
import { toLatinDigits } from "./digits";

/**
 * The portal draws its own sign-in screens (the Pearl Glass redesign) but
 * must behave exactly as the apps' do. Each line below is load-bearing in
 * the apps' screen -- an API call and its arguments, a check made before a
 * request, a branch that keeps something private -- and is asserted in BOTH
 * files, so a change to either one fails here until the other follows.
 */

const read = (url: URL) => readFileSync(url, "utf8");
const shared = (name: string) => read(new URL(`../../../desktop-windows/src/screens/${name}.tsx`, import.meta.url));
const portal = (name: string) => read(new URL(`./${name}.tsx`, import.meta.url));

const PAIRS: [apps: string, portal: string, lines: string[]][] = [
  [
    "Login",
    "PortalLogin",
    [
      "const result = await login(email, password);",
      'if ("requiresVerification" in result.data) {',
      "onNeedsVerification(email, password);",
      "const pendingLong = useStillTrying(pending);",
      "const { active: relayActive, status: relayStatus } = useRelayMode();",
      "relayActive && relayStatus?.intranet",
      't("relay.intranetLimits")',
      "<SocialSignIn onSuccess={onSuccess} disabled={pending} />",
      "failureText(error, t)",
      't("common.stillTrying")',
    ],
  ],
  [
    "Register",
    "PortalRegister",
    [
      "if (password.length < 8) {",
      "const result = await register(email, password, referralCode.trim() || undefined);",
      "onNeedsVerification(email, password);",
      "if (result.relaySignup) setRelayOffered(true);",
      "const [viaRelay, setViaRelay] = useState(() => relayModeActive());",
      'setError({ error: t("forgot.tooShort") });',
      "if (email.trim().toLowerCase() !== emailAgain.trim().toLowerCase()) {",
      'setError({ error: t("relay.emailMismatch") });',
      "const result = await relayRegister(email.trim(), emailAgain.trim(), password);",
      "if (result.ok) setRecoveryCode(result.data.recoveryCode);",
      "<RecoveryCodeNotice code={recoveryCode} onSaved={() => (onRelaySignedUp ?? onSuccess)()} />",
      "<SocialSignIn onSuccess={onSuccess} disabled={pending} />",
      't("relay.signupNote")',
      't("relay.offerSignup")',
      "const pendingLong = useStillTrying(pending);",
    ],
  ],
  [
    "VerifyEmail",
    "PortalVerifyEmail",
    [
      "const VERIFICATION_POLL_MS = 20_000;",
      "if (!password) return;",
      'if (result.ok && !("requiresVerification" in result.data)) {',
      "const result = await verifyEmailByCode(email, code);",
      "const loginResult = await login(email, password);",
      "const check = await login(email, password);",
      "const result = await resendVerification(email);",
      "if (!result.ok) setError(failureText(result, t));",
      'pattern="[0-9]{6}"',
      "disabled={pending || code.length !== 6}",
      "<StillTrying waiting={pending || resending}",
    ],
  ],
  [
    "ForgotPassword",
    "PortalForgotPassword",
    [
      "const result = await forgotPassword(email);",
      "if (!result.ok && result.error) setError(failureText(result, t));\n    setSent(true);",
      'if (password.length < 8) return setError(t("forgot.tooShort"));',
      'if (password !== confirm) return setError(t("forgot.mismatch"));',
      "const result = await resetPasswordByCode(email, code.trim(), password);",
      'onDone(t("forgot.done"));',
      "const result = await resetPasswordByRecoveryCode(email.trim(), recoveryCode.trim(), password);",
      "setNextRecoveryCode(result.data.recoveryCode);",
      'lead={t("forgot.recoveryDone")}',
      't("forgot.relayHint")',
      "onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}",
    ],
  ],
];

const autocompletes = (source: string) => new Set([...source.matchAll(/autoComplete="([^"]+)"/g)].map((m) => m[1]));

describe("the portal's sign-in screens behave as the apps' do", () => {
  it.each(PAIRS)("%s and %s share every load-bearing line", (apps, ours, lines) => {
    const a = shared(apps);
    const b = portal(ours);
    for (const line of lines) {
      expect(a, `apps ${apps}: ${line}`).toContain(line);
      expect(b, `portal ${ours}: ${line}`).toContain(line);
    }
  });

  it.each(PAIRS)("%s and %s ask the browser for the same autofill", (apps, ours) => {
    expect(autocompletes(portal(ours))).toEqual(autocompletes(shared(apps)));
  });

  it("are the screens the portal shows, in place of the apps' ones", () => {
    const app = read(new URL("../App.tsx", import.meta.url));
    expect(app).not.toMatch(/@shared\/screens\/(Login|Register|VerifyEmail|ForgotPassword)"/);
    for (const name of ["PortalLogin", "PortalRegister", "PortalVerifyEmail", "PortalForgotPassword"]) {
      expect(app).toContain(`<${name}`);
    }
  });

  it("never let a form fall back to a GET that would put a password in the URL", () => {
    for (const [, ours] of PAIRS) {
      const source = portal(ours);
      const forms = source.match(/<form\b[^>]*>/g) ?? [];
      expect(forms.length, ours).toBeGreaterThan(0);
      for (const form of forms) expect(form, ours).toContain('method="post"');
    }
  });
});

/** Rendered as the browser gets them. */
function render(node: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}
const noop = () => {};

describe("the screens as rendered", () => {
  it("label every field and keep the browser's autofill hints", () => {
    const html = render(
      <PortalLogin onSuccess={noop} onNeedsVerification={noop} onGoRegister={noop} onGoForgotPassword={noop} />,
    );
    expect(html).toContain('<label for="email"');
    expect(html).toContain('<label for="password"');
    expect(html).toMatch(/<input[^>]*id="email"[^>]*type="email"[^>]*autoComplete="email"[^>]*required/i);
    expect(html).toMatch(/<input[^>]*id="password"[^>]*type="password"/);
    expect(html).toMatch(/autoComplete="current-password"/i);
    expect(html).toMatch(/<form[^>]*method="post"/);
    expect(html).toContain('<h1 id="pa-title"');
  });

  it("give the password a Show toggle that says what it does and whether it is on", () => {
    const html = render(<PortalRegister onNeedsVerification={noop} onSuccess={noop} onGoLogin={noop} />);
    const toggle = html.match(/<button[^>]*class="pa-eye"[^>]*>/)?.[0] ?? "";
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('aria-label="Show password"');
    expect(toggle).toContain('aria-pressed="false"');
    expect(toggle).toContain('aria-controls="password"');
    // The eight-character rule is said before it is enforced, and tied to
    // the field it is about.
    expect(html).toMatch(/aria-describedby="password-hint"/);
    expect(html).toContain('id="password-hint"');
  });

  it("keep a password left to right in either language, toggle included", () => {
    const html = render(
      <PortalLogin onSuccess={noop} onNeedsVerification={noop} onGoRegister={noop} onGoForgotPassword={noop} />,
    );
    expect(html).toContain('<div class="pa-pw" dir="ltr">');
    expect(html).toMatch(/<input[^>]*id="password"[^>]*dir="ltr"[^>]*type="password"/);
  });

  it("hide a shown password again before its form's own submit handler runs", () => {
    // On the form itself, so it runs before the event reaches React's
    // handler at the root; and synchronously (flushSync), so the field is
    // type="password" again before that handler sends anything.
    const form = new EventTarget();
    let hidden = 0;
    const stop = beforeSubmit(form, () => hidden++);
    form.dispatchEvent(new Event("submit"));
    expect(hidden).toBe(1);
    stop();
    form.dispatchEvent(new Event("submit"));
    expect(hidden).toBe(1);
    expect(beforeSubmit(null, noop)).toBeTypeOf("function");
    const source = read(new URL("./controls.tsx", import.meta.url));
    expect(source).toContain("beforeSubmit(field.current?.form, () => flushSync(() => setShown(false)))");
  });

  it("give the recovery code one heading, read out once", () => {
    const html = render(
      <RecoveryStep>
        <RecoveryCodeNotice code="ABCD-EFGH" onSaved={noop} />
      </RecoveryStep>,
    );
    const title = html.match(/<h1 id="pa-title" class="pa-title">([^<]+)<\/h1>/)?.[1] ?? "";
    expect(title).not.toBe("");
    // The apps' component sits straight inside .pa-recovery, and draws the
    // same title in its FIRST row -- the row auth.css leaves out.
    expect(html).toMatch(/<\/h1><\/div><div class="flex flex-col/);
    const rootAt = html.indexOf('<div class="flex flex-col', html.indexOf("</h1>"));
    const titleAt = html.indexOf(title, rootAt);
    expect(titleAt).toBeGreaterThan(rootAt);
    // Depth 1 is the component's root, 2 its first row: from that row's
    // opening to the title, nothing may close back to the root.
    const [, ...inside] = html.slice(rootAt, titleAt).match(/<div\b|<\/div>/g) ?? [];
    let depth = 1;
    for (const tag of inside) {
      depth += tag === "</div>" ? -1 : 1;
      expect(depth, "a row of the component closed before its title").toBeGreaterThanOrEqual(2);
    }
    expect(html.indexOf("ABCD-EFGH")).toBeGreaterThan(titleAt);
    expect(read(new URL("./auth.css", import.meta.url))).toContain(".pa-recovery > .flex-col > :first-child {\n  display: none;");
    for (const ours of ["PortalRegister", "PortalForgotPassword"]) {
      expect(portal(ours)).toContain("<RecoveryStep>");
      expect(portal(ours)).not.toContain('className="pa-sr"');
    }
  });

  it("show the address it sent a code to, isolated left to right", () => {
    const html = render(<PortalVerifyEmail email="a.b@example.com" onVerified={noop} onGoLogin={noop} />);
    expect(html).toContain('<bdi dir="ltr" class="pa-strong">a.b@example.com</bdi>');
    expect(html).toMatch(/autoComplete="one-time-code"/i);
  });

  it("start the reset by email, with the way round a mailbox that cannot be reached", () => {
    const html = render(<PortalForgotPassword onDone={noop} onCancel={noop} />);
    expect(html).toContain("Use my recovery code");
    expect(html).toContain("The reset code is sent by email.");
  });

  it("offer both languages before sign-in, and say which is on", () => {
    const html = render(
      <AuthShell screen="login">
        <p>card</p>
      </AuthShell>,
    );
    const buttons = html.match(/<button[^>]*lang="(en|fa)"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.find((b) => b.includes('lang="en"'))).toContain('aria-pressed="true"');
    expect(buttons.find((b) => b.includes('lang="fa"'))).toContain('aria-pressed="false"');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('href="/privacy/"');
    // The map is not drawn here (it is static in index.html), and there are
    // no lights before sign-in.
    expect(html).not.toMatch(/pa-map|lamp/);
  });
});

describe("codes typed on a Persian keyboard", () => {
  it("arrive as the ASCII digits the server compares", () => {
    expect(toLatinDigits("۱۲۳۴۵۶")).toBe("123456");
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
    expect(toLatinDigits("۰9۸a")).toBe("098a");
  });

  it("are read that way in both emailed-code fields", () => {
    expect(portal("PortalVerifyEmail")).toContain('setCode(toLatinDigits(e.target.value).replace(/\\D/g, ""))');
    expect(portal("PortalForgotPassword")).toContain("setCode(toLatinDigits(e.target.value))");
  });
});

describe("the first draw", () => {
  it("waits for the language where the shared provider really keeps it", () => {
    const i18n = read(new URL("../../../desktop-windows/src/lib/i18n.tsx", import.meta.url));
    expect(i18n).toContain(`const STORE_FILE = "${LANGUAGE_STORE[0]}";`);
    expect(i18n).toContain(`const STORE_KEY = "${LANGUAGE_STORE[1]}";`);
  });
});

describe("the portal's own words", () => {
  const en = COPY.en as Record<string, string>;
  const fa = COPY.fa as Record<string, string>;

  it("exist in both languages", () => {
    expect(Object.keys(fa).sort()).toEqual(Object.keys(en).sort());
  });

  it("are Persian in Persian, with Persian digits and the same placeholders", () => {
    for (const key of Object.keys(en)) {
      if (key === "home") continue; // the domain name
      expect(fa[key], key).toMatch(/[؀-ۿ]/);
      expect(fa[key], key).not.toMatch(/[0-9]/);
      expect(fa[key].match(/\{\w+\}/g) ?? [], key).toEqual(en[key].match(/\{\w+\}/g) ?? []);
    }
  });

  it("claim nothing the product cannot back", () => {
    for (const text of [...Object.values(en), ...Object.values(fa)]) {
      expect(text).not.toMatch(/no[- ]?logs?|fastest|anonymous|military|guarantee|\d+\s?%|servers? in \d/i);
    }
  });
});

describe("the sign-in page", () => {
  const app = read(new URL("../App.tsx", import.meta.url));

  it("does not wait on the screens behind sign-in", () => {
    // None of them is imported up front; each is its own file, asked for
    // when it is opened or once the sign-in card is drawn.
    expect(app).not.toMatch(/^import [^;]*(screens\/(Plans|Settings|Referrals|Support|Account))/m);
    for (const name of ["Account", "Plans", "Settings", "Referrals", "Support"]) {
      expect(app).toMatch(new RegExp(`const ${name} = lazy\\(`));
    }
    expect(app).toContain("<Suspense fallback={<ScreenLoading />}>");
    expect(app).toContain("<ScreenLoadBoundary key={screen}>");
    expect(app).toContain("setTimeout(prefetchSignedInScreens, PREFETCH_DELAY_MS)");
  });
});

describe("everything on the page is served from this site", () => {
  const html = read(new URL("../../index.html", import.meta.url));
  const css = read(new URL("./auth.css", import.meta.url));

  it("loads no font, image, style or script from another host", () => {
    for (const text of [html, css]) {
      expect(text).not.toMatch(/(?:src|href|url)\(?\s*=?\s*["']?(?:https?:)?\/\//i);
      expect(text).not.toMatch(/googleapis|gstatic|cdn\.|jsdelivr|unpkg|cloudflare/i);
    }
  });

  it("ships the licence of every bundled font and of the map", () => {
    const licences = readdirSync(new URL("../../public/licenses/", import.meta.url));
    const assets = readdirSync(new URL("./assets/", import.meta.url));
    if (assets.some((f) => f.startsWith("Inter-"))) expect(licences).toContain("Inter-OFL.txt");
    if (assets.some((f) => f.startsWith("InterTight-"))) expect(licences).toContain("InterTight-OFL.txt");
    if (assets.some((f) => f.startsWith("world-map"))) expect(licences).toContain("world-atlas-LICENSE.txt");
    // index.css re-declares the apps' Vazirmatn for the whole portal.
    expect(licences).toContain("Vazirmatn-OFL.txt");
  });
});

describe("search engines", () => {
  it("are asked not to index the page, and are let in to read that", () => {
    const html = read(new URL("../../index.html", import.meta.url));
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
    const robots = read(new URL("../../../../website/robots.txt", import.meta.url));
    expect(robots).not.toMatch(/^Disallow:\s*\/account/m);
  });
});
