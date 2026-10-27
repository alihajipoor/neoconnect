import { useI18n, type Language } from "@shared/lib/i18n";

/**
 * Words the portal's sign-in screens need that the apps' dictionary does
 * not have.
 *
 * Kept here rather than added to the shared i18n.tsx, the same way
 * screens/Account.tsx keeps its own: these exist only on the web, and the
 * shared dictionary is being reworked on the app's redesign branch at the
 * same time. Everything the apps already say -- "Sign in", the error
 * wording, the relay notes -- still comes from the shared `t()`, so the
 * portal and the apps cannot drift apart on those.
 *
 * Persian digits in Persian strings; `{email}` is substituted by the
 * caller, inside an LTR isolate.
 */
export const COPY = {
  en: {
    // The owner's fixed tagline (design-system.md, section 0): the wide
    // one beside the card, the phone one above it.
    taglineWide1: "Your internet.",
    taglineWide2: "Without limits.",
    taglinePhone1: "A little more",
    taglinePhone2: "freedom.",
    // Only what the account area really does: plans, vouchers, support.
    lede: "Manage your Neoxify plan and vouchers, or contact support.",
    signInLead: "Sign in to your Neoxify account.",
    showPassword: "Show password",
    passwordTooShort: "Password must be at least 8 characters.",
    verifyLead: "We sent a 6-digit code to {email}. Enter it below to activate your account.",
    resent: "Sent. Check your inbox, and your spam folder too.",
    loading: "Loading…",
    home: "neoxify.net",
    privacy: "Privacy",
    contact: "Contact",
    titleLogin: "Sign in",
    titleRegister: "Create account",
    titleForgot: "Reset your password",
    titleVerify: "Confirm your email",
    // A signed-in screen whose file did not arrive (App.tsx).
    loadFailed: "This page didn't load. Reload to try again.",
    reload: "Reload",
    // Google and Facebook sign-in (SocialSignIn.tsx). `{provider}` is
    // nameGoogle or nameFacebook.
    nameGoogle: "Google",
    nameFacebook: "Facebook",
    socialSlow:
      "Still waiting for {provider} to open. If it doesn't open, it may be blocked on this network, as Facebook is in some countries. Sign in with your email instead.",
    socialNotFinished:
      "The {provider} sign-in didn't finish. If a page didn't load along the way, it may be blocked on this network, as Facebook is in some countries. Sign in with your email, or try again on another connection.",
    socialExpired: "The sign-in took too long and expired. Try again.",
    socialDisabled: "This Neoxify account is disabled. If you think this is a mistake, contact support.",
    socialExists:
      "An account with this email already exists. Sign in with your password to finish setting it up.",
    socialUnverified:
      "Your {provider} account's email isn't confirmed. Confirm it with {provider}, or sign up with your email instead.",
    socialNoEmail:
      "This {provider} account has no email address. Neoxify needs one for your plan and for support messages, so sign up with your email instead.",
    socialLost:
      "This sign-in came back to a different tab or browser than the one it started in, so it couldn't finish here. Start it again on this page.",
    socialUnsafe:
      "This browser can't keep a {provider} sign-in secure on the way out and back. Sign in with your email, or try another browser.",
  },
  fa: {
    taglineWide1: "اینترنت شما.",
    taglineWide2: "بدون محدودیت.",
    taglinePhone1: "کمی آزادیِ",
    taglinePhone2: "بیشتر.",
    lede: "پلن و کدهای هدیهٔ نئوکسیفای را اینجا مدیریت کنید یا به پشتیبانی پیام بدهید.",
    signInLead: "وارد حساب نئوکسیفای خود شوید.",
    showPassword: "نمایش رمز عبور",
    passwordTooShort: "رمز عبور باید حداقل ۸ کاراکتر باشد.",
    verifyLead: "یک کد ۶ رقمی به {email} فرستادیم. برای فعال شدن حساب، آن را این پایین وارد کنید.",
    resent: "فرستاده شد. صندوق ورودی و پوشهٔ اسپم را هم ببینید.",
    loading: "در حال بارگذاری…",
    home: "neoxify.net",
    privacy: "حریم خصوصی",
    contact: "تماس با ما",
    titleLogin: "ورود",
    titleRegister: "ساخت حساب",
    titleForgot: "بازنشانی رمز عبور",
    titleVerify: "تأیید ایمیل",
    loadFailed: "این صفحه بارگذاری نشد. صفحه را دوباره بارگذاری کنید.",
    reload: "بارگذاری دوباره",
    nameGoogle: "گوگل",
    nameFacebook: "فیس‌بوک",
    socialSlow:
      "هنوز منتظر باز شدن {provider} هستیم. اگر باز نشد، ممکن است در این شبکه مسدود باشد؛ مثلاً فیس‌بوک در بعضی کشورها مسدود است. به‌جای آن با ایمیل خود وارد شوید.",
    socialNotFinished:
      "ورود با {provider} کامل نشد. اگر صفحه‌ای در این میان باز نشد، ممکن است در این شبکه مسدود باشد؛ مثلاً فیس‌بوک در بعضی کشورها مسدود است. با ایمیل خود وارد شوید یا با اینترنت دیگری دوباره امتحان کنید.",
    socialExpired: "زمان این ورود تمام شد. دوباره امتحان کنید.",
    socialDisabled: "این حساب نئوکسیفای غیرفعال است. اگر فکر می‌کنید اشتباهی شده، به پشتیبانی پیام بدهید.",
    socialExists: "با این ایمیل از قبل حسابی ساخته شده است. برای کامل کردن آن، با رمز عبور خود وارد شوید.",
    socialUnverified:
      "ایمیل حساب {provider} شما تأیید نشده است. آن را در {provider} تأیید کنید، یا به‌جای آن با ایمیل خود ثبت‌نام کنید.",
    socialNoEmail:
      "حساب {provider} شما ایمیل ندارد. نئوکسیفای برای پلن و پیام‌های پشتیبانی به ایمیل نیاز دارد؛ با ایمیل خود ثبت‌نام کنید.",
    socialLost:
      "این ورود به برگه یا مرورگر دیگری برگشت و اینجا کامل نشد. دوباره از همین صفحه شروع کنید.",
    socialUnsafe:
      "این مرورگر نمی‌تواند ورود با {provider} را در رفت و برگشت امن نگه دارد. با ایمیل خود وارد شوید یا مرورگر دیگری را امتحان کنید.",
  },
} satisfies Record<Language, Record<string, string>>;

export type CopyKey = keyof (typeof COPY)["en"];

/** The portal's own words in the language the interface is showing. */
export function useCopy(): (typeof COPY)["en"] {
  const { language } = useI18n();
  return COPY[language] ?? COPY.en;
}

/** The marketing site's pages in the same language: the Persian mirror
 * lives under /fa/ (website/README.md). */
export function sitePath(language: Language, path: "" | "privacy/" | "contact/"): string {
  return language === "fa" ? `/fa/${path}` : `/${path}`;
}
