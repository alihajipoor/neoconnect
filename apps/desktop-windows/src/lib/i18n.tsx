import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";

/** Supported interface languages.
 *
 * Persian is here because a large share of this product's users are in
 * Iran, where an English-only VPN client is a real barrier rather than a
 * nicety. `dir` travels with the language so a future addition (Arabic,
 * Kurdish) only has to declare itself rather than have direction inferred
 * somewhere else. */
export const LANGUAGES = {
  en: { label: "English", nativeLabel: "English", dir: "ltr" },
  fa: { label: "Persian", nativeLabel: "فارسی", dir: "rtl" },
} as const;

export type Language = keyof typeof LANGUAGES;

/** Every string the interface shows.
 *
 * A plain typed dictionary rather than an i18n library: this app has a
 * handful of screens, and TypeScript makes a missing Persian key a build
 * error, which is the main thing a library would otherwise buy. Adding
 * one costs a dependency and a runtime; this costs a line.
 */
const en = {
  "app.tagline": "Private, fast, yours.",
  "auth.signInToConnect": "Sign in to connect.",
  "auth.noCardRequired": "No credit card required to get started.",
  "verify.noCode": "Didn't get a code? Resend it",
  "loc.title": "Choose location",
  "loc.disconnectFirst": "Disconnect first to switch servers",
  "loc.retry": "Retry",

  "nav.settings": "Settings",
  "nav.signOut": "Sign out",
  "nav.back": "Back",

  "auth.welcomeBack": "Welcome back",
  "auth.signIn": "Sign in",
  "auth.signingIn": "Signing in...",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.createAccount": "Create account",
  "auth.noAccount": "Don't have an account?",
  "auth.haveAccount": "Already have an account?",
  "auth.register": "Register",
  "auth.registering": "Creating...",

  "verify.title": "Check your email",
  "verify.sentTo": "We sent a code to {email}",
  "verify.code": "Verification code",
  "verify.confirm": "Confirm",
  "verify.confirming": "Confirming...",
  "verify.resend": "Send it again",
  "verify.sending": "Sending...",

  "dash.connect": "Connect",
  "dash.connecting": "Connecting...",
  "dash.disconnect": "Disconnect",
  "dash.disconnecting": "Disconnecting...",
  "dash.connected": "Connected",
  "dash.disconnected": "Not connected",
  "dash.dataUsed": "Data used",
  "dash.expires": "Expires",
  "dash.location": "Location",
  "dash.viewPlans": "View plans",
  "dash.noSubscription": "No active subscription",

  "plans.title": "Choose a plan",
  "plans.subtitle": "Pick a plan to start connecting.",
  "plans.crypto": "Crypto",
  "plans.card": "Card",
  "plans.loading": "Loading plans...",
  "plans.none": "No plans are available right now. Please check back shortly.",
  "plans.waiting": "Waiting for payment",

  "settings.title": "Settings",
  "settings.subtitle": "Manage your account.",
  "settings.language": "Language",
  "settings.languageHint": "The app restarts nothing — the change is instant.",
  "settings.changePassword": "Change password",
  "settings.changePasswordHint": "You'll stay signed in on this device.",
  "settings.currentPassword": "Current password",
  "settings.newPassword": "New password",
  "settings.confirmPassword": "Confirm new password",
  "settings.passwordChanged": "Password changed. Any other devices have been signed out.",
  "settings.changing": "Changing...",
  "settings.tooShort": "At least 8 characters.",
  "settings.mismatch": "These don't match.",

  "dash.subscription": "Subscription",
  "dash.retry": "Retry",
  "dash.loadFailed": "Could not load your account.",
  "dash.changeLocation": "Change location",
  "dash.status.active": "ACTIVE",
  "dash.server": "Server",
  "dash.protocol": "Protocol",
  "dash.session": "Session",
  "dash.daysLeft": "days left",
  "dash.change": "Change",
  "dash.protected": "You're protected",
  "dash.protectedHint": "Your traffic is encrypted and routed through Neoxify.",
  "dash.notProtected": "You're not protected",
  "dash.notProtectedHint": "Connect to encrypt your traffic and hide your IP.",
  "dash.degraded": "Not carrying traffic",
  "dash.degradedHint": "The tunnel is up but the server isn't responding. Your traffic is NOT protected. Try reconnecting or pick another server.",
  "dash.verifying": "Checking connection...",
  "dash.verifyingHint": "Setting up your tunnel — trying each protocol until one works. Click to stop.",
  "dash.switchedTo": "Your usual protocol didn't get through. Now using",
  "dash.yourIp": "Your IP:",
  "err.serviceUnavailable": "The Neoxify background service isn't running. Restarting the app usually fixes this; reinstalling will if it doesn't.",
  "err.engineMissing": "Part of the installation is missing. Please reinstall Neoxify.",
  "err.serverUnreachable": "Couldn't reach this server. Your network may be blocking it — try another location.",
  "err.notCarryingTraffic": "Connected, but no traffic got through.",
  "err.allProtocolsFailed": "Tried every available protocol — none of them carried traffic.",
  "err.concurrentLimit": "Your plan's device limit is already in use. Disconnect another device and try again.",
  "err.quotaExhausted": "You've used all the data on your plan. Upgrade or wait for it to renew.",
  "err.subscriptionInactive": "Your subscription isn't active right now. Check its status on the dashboard.",
  "err.unknown": "Couldn't connect.",
  "err.showDetail": "Technical details",

  "plans.back": "Back",
  "plans.perDays": "for {days} days",
  "plans.data": "Data",
  "plans.speed": "Speed",
  "plans.devices": "Devices",
  "plans.unlimited": "Unlimited",
  "plans.upTo": "Up to {n} Mbps",
  "plans.devicesAtOnce": "{n} at once",
  "plans.bestValue": "Best value",
  "plans.payWith": "Pay with",
  "plans.amount": "Amount",
  "plans.toAddress": "To this address",
  "plans.openCheckout": "Open checkout",
  "plans.copied": "Copied",
  "plans.browserFailed": "We could not open your browser. Use the button below to try again.",
  "plans.copyAddress": "Copy address",

  "common.loading": "Loading...",
} as const;

export type TranslationKey = keyof typeof en;

/** Persian. Kept as a full record so TypeScript refuses to build when a
 * key is added to English and not translated -- a half-translated screen
 * is worse than an untranslated one, because it looks broken rather than
 * unfinished. */
const fa: Record<TranslationKey, string> = {
  "app.tagline": "خصوصی، سریع، مال شما.",
  "auth.signInToConnect": "برای اتصال وارد شوید.",
  "auth.noCardRequired": "برای شروع نیازی به کارت بانکی نیست.",
  "verify.noCode": "کد را دریافت نکردید؟ ارسال دوباره",
  "loc.title": "انتخاب موقعیت",
  "loc.disconnectFirst": "برای تغییر سرور ابتدا قطع کنید",
  "loc.retry": "تلاش دوباره",

  "nav.settings": "تنظیمات",
  "nav.signOut": "خروج",
  "nav.back": "بازگشت",

  "auth.welcomeBack": "خوش آمدید",
  "auth.signIn": "ورود",
  "auth.signingIn": "در حال ورود...",
  "auth.email": "ایمیل",
  "auth.password": "رمز عبور",
  "auth.createAccount": "ساخت حساب",
  "auth.noAccount": "حساب کاربری ندارید؟",
  "auth.haveAccount": "قبلاً حساب ساخته‌اید؟",
  "auth.register": "ثبت‌نام",
  "auth.registering": "در حال ساخت...",

  "verify.title": "ایمیل خود را بررسی کنید",
  "verify.sentTo": "کد را به {email} فرستادیم",
  "verify.code": "کد تأیید",
  "verify.confirm": "تأیید",
  "verify.confirming": "در حال تأیید...",
  "verify.resend": "ارسال دوباره",
  "verify.sending": "در حال ارسال...",

  "dash.connect": "اتصال",
  "dash.connecting": "در حال اتصال...",
  "dash.disconnect": "قطع اتصال",
  "dash.disconnecting": "در حال قطع...",
  "dash.connected": "متصل",
  "dash.disconnected": "متصل نیستید",
  "dash.dataUsed": "مصرف داده",
  "dash.expires": "انقضا",
  "dash.location": "موقعیت",
  "dash.viewPlans": "مشاهده پلن‌ها",
  "dash.noSubscription": "اشتراک فعالی ندارید",

  "plans.title": "انتخاب پلن",
  "plans.subtitle": "برای شروع اتصال یک پلن انتخاب کنید.",
  "plans.crypto": "رمزارز",
  "plans.card": "کارت بانکی",
  "plans.loading": "در حال بارگذاری پلن‌ها...",
  "plans.none": "در حال حاضر پلنی موجود نیست. کمی بعد دوباره سر بزنید.",
  "plans.waiting": "در انتظار پرداخت",

  "settings.title": "تنظیمات",
  "settings.subtitle": "مدیریت حساب کاربری.",
  "settings.language": "زبان",
  "settings.languageHint": "تغییر زبان بلافاصله اعمال می‌شود.",
  "settings.changePassword": "تغییر رمز عبور",
  "settings.changePasswordHint": "روی این دستگاه وارد می‌مانید.",
  "settings.currentPassword": "رمز عبور فعلی",
  "settings.newPassword": "رمز عبور جدید",
  "settings.confirmPassword": "تکرار رمز عبور جدید",
  "settings.passwordChanged": "رمز عبور تغییر کرد. دستگاه‌های دیگر از حساب خارج شدند.",
  "settings.changing": "در حال تغییر...",
  "settings.tooShort": "حداقل ۸ کاراکتر.",
  "settings.mismatch": "یکسان نیستند.",

  "dash.subscription": "اشتراک",
  "dash.retry": "تلاش دوباره",
  "dash.loadFailed": "بارگذاری حساب کاربری ممکن نشد.",
  "dash.changeLocation": "تغییر موقعیت",
  "dash.status.active": "فعال",
  "dash.server": "سرور",
  "dash.protocol": "پروتکل",
  "dash.session": "مدت اتصال",
  "dash.daysLeft": "روز مانده",
  "dash.change": "تغییر",
  "dash.protected": "شما محافظت می‌شوید",
  "dash.protectedHint": "ترافیک شما رمزگذاری شده و از طریق نئوکسیفای عبور می‌کند.",
  "dash.notProtected": "شما محافظت نمی‌شوید",
  "dash.notProtectedHint": "برای رمزگذاری ترافیک و پنهان‌کردن آی‌پی خود متصل شوید.",
  "dash.degraded": "ترافیک عبور نمی‌کند",
  "dash.degradedHint": "تونل برقرار است اما سرور پاسخ نمی‌دهد. ترافیک شما محافظت نمی‌شود. دوباره وصل شوید یا سرور دیگری انتخاب کنید.",
  "dash.verifying": "در حال بررسی اتصال...",
  "dash.verifyingHint": "در حال برقراری تونل — هر پروتکل امتحان می‌شود. برای توقف کلیک کنید.",
  "dash.switchedTo": "پروتکل همیشگی شما عبور نکرد. اکنون از این استفاده می‌شود:",
  "dash.yourIp": "آی‌پی شما:",
  "err.serviceUnavailable": "سرویس پس‌زمینه نئوکسیفای اجرا نمی‌شود. معمولاً راه‌اندازی دوباره برنامه مشکل را حل می‌کند.",
  "err.engineMissing": "بخشی از نصب ناقص است. لطفاً دوباره نصب کنید.",
  "err.serverUnreachable": "این سرور در دسترس نیست. موقعیت دیگری را امتحان کنید.",
  "err.notCarryingTraffic": "اتصال برقرار شد اما ترافیکی عبور نکرد.",
  "err.allProtocolsFailed": "همه پروتکل‌های موجود امتحان شدند — هیچ‌کدام ترافیک را عبور ندادند.",
  "err.concurrentLimit": "سقف دستگاه‌های پلن شما پر شده است. یک دستگاه دیگر را قطع کنید.",
  "err.quotaExhausted": "حجم پلن شما تمام شده است.",
  "err.subscriptionInactive": "اشتراک شما فعال نیست.",
  "err.unknown": "اتصال برقرار نشد.",
  "err.showDetail": "جزئیات فنی",

  "plans.back": "بازگشت",
  "plans.perDays": "برای {days} روز",
  "plans.data": "حجم",
  "plans.speed": "سرعت",
  "plans.devices": "دستگاه",
  "plans.unlimited": "نامحدود",
  "plans.upTo": "تا {n} مگابیت",
  "plans.devicesAtOnce": "{n} همزمان",
  "plans.bestValue": "بهترین انتخاب",
  "plans.payWith": "پرداخت با",
  "plans.amount": "مبلغ",
  "plans.toAddress": "به این آدرس",
  "plans.openCheckout": "باز کردن صفحه پرداخت",
  "plans.copied": "کپی شد",
  "plans.browserFailed": "مرورگر باز نشد. با دکمه زیر دوباره تلاش کنید.",
  "plans.copyAddress": "کپی آدرس",

  "common.loading": "در حال بارگذاری...",
};

const DICTIONARIES: Record<Language, Record<TranslationKey, string>> = { en, fa };

const STORE_FILE = "settings.json";
const STORE_KEY = "language";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  storePromise ??= load(STORE_FILE, { autoSave: true });
  return storePromise;
}

interface I18nValue {
  language: Language;
  dir: "ltr" | "rtl";
  setLanguage: (language: Language) => void;
  /** Translates a key, substituting {placeholders} from `vars`. */
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

/** Picks the starting language when nothing has been chosen yet.
 *
 * Reads the OS locale rather than defaulting to English, so a Persian
 * speaker opening the app for the first time sees Persian without having
 * to find a setting written in a language they may not read. */
function detectLanguage(): Language {
  const locale = typeof navigator !== "undefined" ? navigator.language : "";
  return locale.toLowerCase().startsWith("fa") ? "fa" : "en";
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>(detectLanguage);

  // Restores the saved choice. Until it resolves the detected language is
  // shown, so the first paint is never blank waiting on disk.
  useEffect(() => {
    void (async () => {
      try {
        const saved = await (await getStore()).get<Language>(STORE_KEY);
        if (saved && saved in LANGUAGES) setLanguageState(saved);
      } catch {
        // A settings file that can't be read is not worth failing over --
        // the detected language is a fine answer.
      }
    })();
  }, []);

  const dir = LANGUAGES[language].dir;

  // Set on the document rather than a wrapper element so it reaches
  // portalled content -- dialogs and dropdowns render outside the React
  // tree and would otherwise stay left-to-right.
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = dir;
  }, [language, dir]);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void (async () => {
      try {
        await (await getStore()).set(STORE_KEY, next);
      } catch {
        // Persisting is best-effort: the change already applied, and
        // failing to remember it is better than refusing to switch.
      }
    })();
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      let text: string = DICTIONARIES[language][key] ?? en[key] ?? key;
      if (vars) {
        for (const [name, value] of Object.entries(vars)) {
          text = text.split(`{${name}}`).join(String(value));
        }
      }
      return text;
    },
    [language],
  );

  return <I18nContext.Provider value={{ language, dir, setLanguage, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
