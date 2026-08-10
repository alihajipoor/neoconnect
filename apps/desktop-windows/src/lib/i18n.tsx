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

  "forgot.link": "Forgot your password?",
  "forgot.title": "Reset your password",
  "forgot.subtitle": "We'll email you a code to set a new one.",
  "forgot.sendCode": "Send me a code",
  "forgot.sending": "Sending...",
  "forgot.sent": "If that address is registered, a code is on its way. It expires in 30 minutes.",
  "forgot.code": "Code from the email",
  "forgot.newPassword": "New password",
  "forgot.confirmPassword": "Confirm new password",
  "forgot.submit": "Set new password",
  "forgot.submitting": "Saving...",
  "forgot.done": "Password changed. You can sign in now.",
  "forgot.backToSignIn": "Back to sign in",
  "forgot.tooShort": "At least 8 characters.",
  "forgot.mismatch": "These don't match.",

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

  "auth.referralCode": "Referral code (optional)",
  "auth.referralCodeHint": "From a friend who invited you",
  "update.downloading": "Downloading Neoxify {version}...",
  "update.downloadingPercent": "Downloading Neoxify {version} — {percent}%",
  "update.ready": "Neoxify {version} is ready to install.",
  "update.restart": "Restart now",
  "update.restarting": "Restarting...",
  "update.connectedFirst": "Disconnect before updating.",
  "dash.customModeDetached": "Connected, but Custom mode could not attach — your selected apps are going out unprotected.",
  "dash.unlimited": "Unlimited",
  "support.title": "Support",
  "support.subtitle": "Ask us anything — we answer as soon as we can.",
  "support.new": "New message",
  "support.newTitle": "What can we help with?",
  "support.subject": "Subject",
  "support.subjectHint": "A few words, e.g. \"Can't connect on Stealth\"",
  "support.message": "Message",
  "support.messageHint": "Tell us what happened, and what you already tried.",
  "support.send": "Send",
  "support.sending": "Sending...",
  "support.reply": "Write a reply",
  "support.replyWithin": "We usually reply within {hours} hours.",
  "support.replyWithinDay": "We usually reply within a day.",
  "support.closed": "Support is closed to new messages right now. Please check back later.",
  "support.closedTitle": "Not taking new messages",
  "support.empty": "No conversations yet.",
  "support.emptyHint": "Start one and it will appear here.",
  "support.you": "You",
  "support.team": "Support",
  "support.statusOpen": "Waiting for a reply",
  "support.statusAnswered": "Replied",
  "support.statusResolved": "Resolved",
  "support.unread": "New reply",
  "support.notLive": "This is not a live chat — you can close the app, and your reply will be here (and in your email) when it arrives.",
  "referrals.title": "Invite friends",
  "referrals.subtitle": "Share your code and earn free Neoxify time.",
  "referrals.off": "The referral programme isn't running at the moment. Check back soon.",
  "referrals.yourCode": "Your referral code",
  "referrals.rule": "Get {days} free days when one friend pays for {months} months, or {friends} friends pay for {each} each.",
  "referrals.copy": "Copy",
  "referrals.copied": "Copied",
  "referrals.progress": "Next free month",
  "referrals.monthsToGo": "{count} paid months to go",
  "referrals.almost": "Ready on the next check",
  "referrals.progressHint": "Best friend so far: {best} paid months. Friends who qualify: {qualifying}.",
  "referrals.friends": "Friends you invited",
  "referrals.friendsHint": "Shown partly hidden — their address stays private.",
  "referrals.noFriends": "Nobody yet. Share your code to get started.",
  "referrals.joined": "Joined",
  "referrals.pending": "Not activated",
  "referrals.paidMonths": "{count} paid months",
  "referrals.earned": "Free time you've earned",
  "referrals.freeDays": "{days} free days",
  "nav.referrals": "Invite friends",
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
  "dash.customActive": "Custom mode: only your chosen apps are going through the VPN.",
  "voucher.title": "Have a voucher?",
  "voucher.subtitle": "Enter a code to activate a plan without paying.",
  "voucher.placeholder": "Enter your code",
  "voucher.check": "Check",
  "voucher.valid": "This code is valid",
  "voucher.days": "days",
  "voucher.confirm": "Activate this plan",
  "voucher.cancel": "Cancel",
  "settings.general": "General",
  "settings.account": "Account",
  "settings.sections": "Sections",
  "settings.custom": "Custom mode",
  "settings.customBeta": "Beta",
  "settings.customHint": "Send only the apps you choose through the VPN. Everything else uses your normal connection. Still new — tell us if something looks wrong.",
  "settings.customOn": "On",
  "settings.customOff": "Off",
  "settings.customAddApp": "Add an app",
  "settings.customNoApps": "No apps chosen yet, so nothing is being routed. Add one to start.",
  "settings.customRemove": "Remove",
  "settings.customApplies": "Applies from your next connection.",
  "settings.customFailOpen": "While the app is switching servers, chosen apps briefly use your normal connection instead of stalling.",
  "settings.customTooMany": "You can choose up to {max} apps.",
  "settings.customAlready": "That app is already on the list.",
  // Android picks from the installed-app list rather than a file
  // dialog, so these have no Windows counterpart.
  //
  // customAllApps is not a translation of customNoApps -- it is the
  // opposite fact. On Windows, on-with-nothing-chosen routes nothing;
  // on Android an empty allow-list would route nothing at all, so the
  // app falls back to a full tunnel instead. Same toggle state, opposite
  // consequence, and telling somebody the wrong one is worse than saying
  // nothing.
  // Android only: this build carries one engine, and a customer who
  // picked another protocol deserves the reason rather than a silent
  // substitution.
  // Shown when the control plane could not be reached and the screen is
  // running on the cached snapshot. Names the age of the data, because
  // the alternative is presenting a stale usage total as today's.
  "dash.offlineTitle": "Can't reach Neoxify right now — you can still connect.",
  "dash.offlineHint":
    "Using your saved servers. Data usage and expiry were last updated {when} and may be out of date.",
  "dash.androidWireguardOnly":
    "{protocol} isn't in the Android app yet, so it will connect with Fast instead.",
  "settings.customAllApps": "No apps chosen yet, so every app uses the VPN. Pick one to route just that app.",
  "settings.customHintNative": "Send only the apps you choose through the VPN. Everything else uses your normal connection.",
  "settings.customSearch": "Search apps",
  "settings.customNoMatches": "No apps match that.",
  "settings.customClear": "Clear selection",
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

  "forgot.link": "رمز عبور را فراموش کرده‌اید؟",
  "forgot.title": "بازنشانی رمز عبور",
  "forgot.subtitle": "کدی برای تعیین رمز جدید ایمیل می‌کنیم.",
  "forgot.sendCode": "ارسال کد",
  "forgot.sending": "در حال ارسال...",
  "forgot.sent": "اگر این نشانی ثبت شده باشد، کد ارسال می‌شود. اعتبار آن ۳۰ دقیقه است.",
  "forgot.code": "کد داخل ایمیل",
  "forgot.newPassword": "رمز عبور جدید",
  "forgot.confirmPassword": "تکرار رمز عبور جدید",
  "forgot.submit": "ثبت رمز جدید",
  "forgot.submitting": "در حال ذخیره...",
  "forgot.done": "رمز عبور تغییر کرد. اکنون می‌توانید وارد شوید.",
  "forgot.backToSignIn": "بازگشت به ورود",
  "forgot.tooShort": "حداقل ۸ نویسه.",
  "forgot.mismatch": "یکسان نیستند.",

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

  "auth.referralCode": "کد معرف (اختیاری)",
  "auth.referralCodeHint": "از دوستی که شما را دعوت کرده",
  "update.downloading": "در حال دریافت نئوکسیفای {version}...",
  "update.downloadingPercent": "در حال دریافت نئوکسیفای {version} — {percent}٪",
  "update.ready": "نئوکسیفای {version} آماده نصب است.",
  "update.restart": "راه‌اندازی مجدد",
  "update.restarting": "در حال راه‌اندازی مجدد...",
  "update.connectedFirst": "برای به‌روزرسانی ابتدا قطع کنید.",
  "dash.customModeDetached": "متصل شد، اما حالت سفارشی وصل نشد — ترافیک برنامه‌های انتخابی شما بدون محافظت خارج می‌شود.",
  "dash.unlimited": "نامحدود",
  "support.title": "پشتیبانی",
  "support.subtitle": "هر سوالی دارید بپرسید — در اولین فرصت پاسخ می‌دهیم.",
  "support.new": "پیام جدید",
  "support.newTitle": "چه کمکی از ما بر می‌آید؟",
  "support.subject": "موضوع",
  "support.subjectHint": "در چند کلمه، مثلاً «با استلث وصل نمی‌شوم»",
  "support.message": "پیام",
  "support.messageHint": "بنویسید چه اتفاقی افتاده و چه کارهایی را امتحان کرده‌اید.",
  "support.send": "ارسال",
  "support.sending": "در حال ارسال...",
  "support.reply": "نوشتن پاسخ",
  "support.replyWithin": "معمولاً ظرف {hours} ساعت پاسخ می‌دهیم.",
  "support.replyWithinDay": "معمولاً ظرف یک روز پاسخ می‌دهیم.",
  "support.closed": "در حال حاضر پیام جدید پذیرفته نمی‌شود. لطفاً بعداً سر بزنید.",
  "support.closedTitle": "پیام جدید پذیرفته نمی‌شود",
  "support.empty": "هنوز گفتگویی ندارید.",
  "support.emptyHint": "یک گفتگو شروع کنید تا اینجا نمایش داده شود.",
  "support.you": "شما",
  "support.team": "پشتیبانی",
  "support.statusOpen": "در انتظار پاسخ",
  "support.statusAnswered": "پاسخ داده شد",
  "support.statusResolved": "بسته شد",
  "support.unread": "پاسخ جدید",
  "support.notLive": "این گفتگوی زنده نیست — می‌توانید برنامه را ببندید؛ پاسخ در همین‌جا و در ایمیل شما خواهد بود.",
  "referrals.title": "دعوت از دوستان",
  "referrals.subtitle": "کد خود را به اشتراک بگذارید و زمان رایگان بگیرید.",
  "referrals.off": "برنامه معرفی در حال حاضر فعال نیست. بعداً سر بزنید.",
  "referrals.yourCode": "کد معرف شما",
  "referrals.rule": "با {months} ماه اشتراک یک دوست، یا {friends} دوست با {each} ماه، {days} روز رایگان بگیرید.",
  "referrals.copy": "کپی",
  "referrals.copied": "کپی شد",
  "referrals.progress": "ماه رایگان بعدی",
  "referrals.monthsToGo": "{count} ماه پرداختی باقی مانده",
  "referrals.almost": "در بررسی بعدی آماده می‌شود",
  "referrals.progressHint": "بیشترین دوست: {best} ماه پرداختی. دوستان واجد شرایط: {qualifying}.",
  "referrals.friends": "دوستان دعوت‌شده",
  "referrals.friendsHint": "نیمه‌پنهان نمایش داده می‌شود — نشانی آنها خصوصی می‌ماند.",
  "referrals.noFriends": "هنوز کسی نیست. کد خود را به اشتراک بگذارید.",
  "referrals.joined": "عضو شد",
  "referrals.pending": "فعال نشده",
  "referrals.paidMonths": "{count} ماه پرداختی",
  "referrals.earned": "زمان رایگان کسب‌شده",
  "referrals.freeDays": "{days} روز رایگان",
  "nav.referrals": "دعوت از دوستان",
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
  "dash.customActive": "حالت سفارشی: فقط برنامه‌های انتخابی شما از VPN عبور می‌کنند.",
  "voucher.title": "کد هدیه دارید؟",
  "voucher.subtitle": "با وارد کردن کد، بدون پرداخت اشتراک فعال کنید.",
  "voucher.placeholder": "کد خود را وارد کنید",
  "voucher.check": "بررسی",
  "voucher.valid": "این کد معتبر است",
  "voucher.days": "روز",
  "voucher.confirm": "فعال‌سازی این پلن",
  "voucher.cancel": "انصراف",
  "settings.general": "عمومی",
  "settings.account": "حساب کاربری",
  "settings.sections": "بخش‌ها",
  "settings.custom": "حالت سفارشی",
  "settings.customBeta": "آزمایشی",
  "settings.customHint": "فقط برنامه‌هایی که انتخاب می‌کنید از VPN عبور می‌کنند. بقیه از اینترنت معمولی استفاده می‌کنند.",
  "settings.customOn": "روشن",
  "settings.customOff": "خاموش",
  "settings.customAddApp": "افزودن برنامه",
  "settings.customNoApps": "هنوز برنامه‌ای انتخاب نشده، پس چیزی از تونل عبور نمی‌کند. یکی اضافه کنید.",
  "settings.customRemove": "حذف",
  "settings.customApplies": "از اتصال بعدی اعمال می‌شود.",
  "settings.customFailOpen": "هنگام تعویض سرور، برنامه‌های انتخابی به‌جای قطع شدن، لحظه‌ای از اینترنت معمولی استفاده می‌کنند.",
  "settings.customTooMany": "حداکثر {max} برنامه می‌توانید انتخاب کنید.",
  "settings.customAlready": "این برنامه از قبل در فهرست است.",
  "dash.offlineTitle": "در حال حاضر به Neoxify دسترسی نیست — همچنان می‌توانید متصل شوید.",
  "dash.offlineHint":
    "از سرورهای ذخیره‌شده استفاده می‌شود. مصرف داده و تاریخ انقضا آخرین بار در {when} به‌روز شده و ممکن است دقیق نباشد.",
  "dash.androidWireguardOnly":
    "پروتکل {protocol} هنوز در نسخه اندروید نیست، بنابراین با Fast متصل می‌شود.",
  "settings.customAllApps":
    "هنوز برنامه‌ای انتخاب نشده، پس همه برنامه‌ها از VPN عبور می‌کنند. برای عبور فقط یک برنامه، آن را انتخاب کنید.",
  "settings.customHintNative":
    "فقط برنامه‌هایی که انتخاب می‌کنید از VPN عبور می‌کنند. بقیه از اینترنت معمولی استفاده می‌کنند.",
  "settings.customSearch": "جست‌وجوی برنامه‌ها",
  "settings.customNoMatches": "برنامه‌ای با این نام پیدا نشد.",
  "settings.customClear": "پاک کردن انتخاب‌ها",
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
