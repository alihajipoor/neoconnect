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
    lede: "Your Neoxify account: plans, vouchers and support, in one place.",
    signInLead: "Sign in to your Neoxify account.",
    showPassword: "Show password",
    passwordTooShort: "Password must be at least 8 characters.",
    verifyLead: "We sent a 6-digit code to {email}. Enter it below to activate your account.",
    resent: "Sent! Check your inbox (and spam folder).",
    loading: "Loading…",
    home: "neoxify.net",
    privacy: "Privacy",
    contact: "Contact",
    titleLogin: "Sign in",
    titleRegister: "Create account",
    titleForgot: "Reset your password",
    titleVerify: "Confirm your email",
    // A signed-in screen whose file did not arrive (App.tsx).
    loadFailed: "Could not load this page. Reload to try again.",
    reload: "Reload",
    // Google and Facebook sign-in (SocialSignIn.tsx). `{provider}` is
    // nameGoogle or nameFacebook.
    nameGoogle: "Google",
    nameFacebook: "Facebook",
    socialSlow:
      "Still waiting for {provider} to open. If it does not, it may be blocked on this network (Facebook is blocked in Iran, for example). Sign in with your email instead.",
    socialNotFinished:
      "The {provider} sign-in was not finished. If a page did not load on the way, it may be blocked on this network (Facebook is blocked in Iran, for example). Sign in with your email, or try again on another connection.",
    socialExpired: "That sign-in took too long and has expired. Please try again.",
    socialDisabled: "This Neoxify account is disabled. If you think this is a mistake, contact support.",
    socialExists:
      "An account with this email already exists. Sign in with your password to finish setting it up.",
    socialUnverified:
      "Your {provider} account has not verified its email address. Verify it with {provider}, or sign up with your email instead.",
    socialNoEmail:
      "That {provider} account has no email address. Neoxify needs one for your subscription and support messages, so please sign up with your email instead.",
    socialLost:
      "This sign-in came back to a different tab or browser from the one it started in, so it could not be finished here. Please start it again on this page.",
    socialUnsafe:
      "This browser cannot keep a {provider} sign-in safe on its way out and back. Sign in with your email, or try another browser.",
  },
  fa: {
    taglineWide1: "اینترنت شما.",
    taglineWide2: "بدون محدودیت.",
    taglinePhone1: "کمی آزادیِ",
    taglinePhone2: "بیشتر.",
    lede: "حساب نئوکسیفای شما: اشتراک، کد هدیه و پشتیبانی، همه در یک جا.",
    signInLead: "وارد حساب نئوکسیفای خود شوید.",
    showPassword: "نمایش رمز عبور",
    passwordTooShort: "رمز عبور باید حداقل ۸ نویسه باشد.",
    verifyLead: "یک کد ۶ رقمی به {email} فرستادیم. برای فعال‌سازی حساب، آن را در زیر وارد کنید.",
    resent: "ارسال شد! صندوق ورودی (و پوشهٔ هرزنامه) را بررسی کنید.",
    loading: "در حال بارگذاری…",
    home: "neoxify.net",
    privacy: "حریم خصوصی",
    contact: "تماس با ما",
    titleLogin: "ورود",
    titleRegister: "ساخت حساب",
    titleForgot: "بازنشانی رمز عبور",
    titleVerify: "تأیید ایمیل",
    loadFailed: "این صفحه بارگذاری نشد. برای تلاش دوباره، صفحه را دوباره بارگذاری کنید.",
    reload: "بارگذاری دوباره",
    nameGoogle: "گوگل",
    nameFacebook: "فیسبوک",
    socialSlow:
      "هنوز منتظر باز شدن {provider} هستیم. اگر باز نشد، ممکن است در این شبکه مسدود باشد (برای نمونه فیسبوک در ایران مسدود است). به‌جای آن با ایمیل خود وارد شوید.",
    socialNotFinished:
      "ورود با {provider} کامل نشد. اگر صفحه‌ای در این مسیر باز نشد، ممکن است در این شبکه مسدود باشد (برای نمونه فیسبوک در ایران مسدود است). با ایمیل خود وارد شوید یا با اتصال دیگری دوباره تلاش کنید.",
    socialExpired: "مهلت این ورود به پایان رسید. لطفاً دوباره تلاش کنید.",
    socialDisabled: "این حساب نئوکسیفای غیرفعال شده است. اگر فکر می‌کنید اشتباهی رخ داده، با پشتیبانی تماس بگیرید.",
    socialExists: "حسابی با این ایمیل از قبل وجود دارد. برای تکمیل راه‌اندازی آن، با رمز عبور خود وارد شوید.",
    socialUnverified:
      "ایمیل حساب {provider} شما تأیید نشده است. آن را در {provider} تأیید کنید، یا به‌جای آن با ایمیل خود ثبت‌نام کنید.",
    socialNoEmail:
      "حساب {provider} شما نشانی ایمیل ندارد. نئوکسیفای برای پیام‌های اشتراک و پشتیبانی به ایمیل نیاز دارد؛ لطفاً با ایمیل خود ثبت‌نام کنید.",
    socialLost:
      "این ورود به برگه یا مرورگری غیر از آنچه در آن آغاز شده بود برگشت و نمی‌توان آن را اینجا کامل کرد. لطفاً دوباره از همین صفحه شروع کنید.",
    socialUnsafe:
      "این مرورگر نمی‌تواند ورود با {provider} را در مسیر رفت و برگشت ایمن نگه دارد. با ایمیل خود وارد شوید یا مرورگر دیگری را امتحان کنید.",
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
