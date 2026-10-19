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
