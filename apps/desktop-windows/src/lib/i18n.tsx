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

  "common.loading": "Loading...",
} as const;

export type TranslationKey = keyof typeof en;

/** Persian. Kept as a full record so TypeScript refuses to build when a
 * key is added to English and not translated -- a half-translated screen
 * is worse than an untranslated one, because it looks broken rather than
 * unfinished. */
const fa: Record<TranslationKey, string> = {
  "app.tagline": "خصوصی، سریع، مال شما.",

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
