import { useEffect, useState } from "react";
import { Button, Card } from "@shared/components/ui";
import { Logo } from "@shared/components/Logo";
import { useI18n } from "@shared/lib/i18n";
import { getMe, getSubscriptions } from "@shared/lib/customer";
import { logout } from "@shared/lib/auth";
import type { Customer, Subscription } from "@shared/lib/types";

/**
 * The portal's home screen, standing in for the apps' Dashboard.
 *
 * The Dashboard is the one screen that could not be reused: it drives a
 * VPN tunnel, and a web page has no tunnel to drive. Everything else --
 * sign-in, registration, verification, password reset, plans and
 * purchase, vouchers, referrals, support, settings -- is the apps'
 * screen imported unchanged.
 *
 * This screen is therefore deliberately NOT a connect button that does
 * nothing. It reports the state of the subscription and sends the
 * customer to the app to actually connect. Showing a disabled or fake
 * connect control here would be the same class of dishonesty as a
 * "Connected" label that has not been verified.
 */

const COPY = {
  en: {
    signOut: "Sign out",
    loading: "Loading your account…",
    plan: "Your plan",
    noPlanTitle: "No active plan",
    noPlanBody: "Choose a plan to start using Neoxify, or redeem a voucher if you were given one.",
    browsePlans: "Browse plans",
    expires: "Renews or expires",
    dataUsed: "Data used",
    unlimited: "Unlimited",
    connectTitle: "Connecting happens in the app",
    connectBody:
      "This page manages your account. To actually connect, install the Neoxify app and sign in with the same email.",
    download: "Download the app",
    settings: "Settings",
    support: "Support",
    referrals: "Refer a friend",
    statusActive: "Active",
    statusPending: "Awaiting payment",
    statusSuspended: "Suspended",
    statusExpired: "Expired",
    statusCancelled: "Cancelled",
  },
  fa: {
    signOut: "خروج",
    loading: "در حال بارگذاری حساب شما…",
    plan: "اشتراک شما",
    noPlanTitle: "اشتراک فعالی ندارید",
    noPlanBody: "برای شروع یک اشتراک انتخاب کنید، یا اگر کد هدیه دارید آن را وارد کنید.",
    browsePlans: "مشاهده اشتراک‌ها",
    expires: "تمدید یا انقضا",
    dataUsed: "مصرف",
    unlimited: "نامحدود",
    connectTitle: "اتصال از داخل برنامه انجام می‌شود",
    connectBody:
      "این صفحه برای مدیریت حساب شماست. برای اتصال، برنامه نئوکسیفای را نصب کنید و با همین ایمیل وارد شوید.",
    download: "دانلود برنامه",
    settings: "تنظیمات",
    support: "پشتیبانی",
    referrals: "معرفی به دوستان",
    statusActive: "فعال",
    statusPending: "در انتظار پرداخت",
    statusSuspended: "معلق",
    statusExpired: "منقضی شده",
    statusCancelled: "لغو شده",
  },
} as const;

/** Bytes as something a person reads, matching the apps' phrasing. */
function formatBytes(value: string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 GB";
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

interface Props {
  onBrowsePlans: () => void;
  onOpenSettings: () => void;
  onOpenSupport: () => void;
  onOpenReferrals: () => void;
  onLoggedOut: () => void;
}

export function Account({
  onBrowsePlans,
  onOpenSettings,
  onOpenSupport,
  onOpenReferrals,
  onLoggedOut,
}: Props) {
  const { language } = useI18n();
  const c = COPY[language === "fa" ? "fa" : "en"];

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);

  useEffect(() => {
    void (async () => {
      const [me, subs] = await Promise.all([getMe(), getSubscriptions()]);
      if (me.ok) setCustomer(me.data);
      // An empty list and a failed request are deliberately different:
      // [] means "no plan, offer one", null stays "still loading" so a
      // transient network failure never renders as "you have no plan"
      // to somebody who does.
      if (subs.ok) setSubscriptions(subs.data);
    })();
  }, []);

  // PENDING is excluded on purpose -- a subscription exists before its
  // payment clears, and showing it as a plan would tell someone they
  // had bought something they had not yet paid for.
  const active = subscriptions?.find((s) => s.status === "ACTIVE" || s.status === "SUSPENDED") ?? null;

  const statusLabel: Record<Subscription["status"], string> = {
    ACTIVE: c.statusActive,
    PENDING: c.statusPending,
    SUSPENDED: c.statusSuspended,
    EXPIRED: c.statusExpired,
    CANCELLED: c.statusCancelled,
  };

  async function signOut() {
    await logout();
    onLoggedOut();
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-5">
      <header className="flex items-center justify-between">
        <Logo />
        <button
          onClick={() => void signOut()}
          className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {c.signOut}
        </button>
      </header>

      {customer && <p className="-mt-2 truncate text-xs text-muted-foreground">{customer.email}</p>}

      {subscriptions === null ? (
        <Card className="p-5 text-sm text-muted-foreground">{c.loading}</Card>
      ) : active ? (
        <Card className="flex flex-col gap-3 p-5">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{c.plan}</span>
            <span
              className={
                active.status === "ACTIVE"
                  ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-400"
                  : "rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-400"
              }
            >
              {statusLabel[active.status]}
            </span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{c.expires}</span>
            <span>{new Date(active.expireAt).toLocaleDateString()}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">{c.dataUsed}</span>
            <span>
              {formatBytes(active.dataUsedBytes)}
              {active.dataCapBytes ? ` / ${formatBytes(active.dataCapBytes)}` : ` / ${c.unlimited}`}
            </span>
          </div>
        </Card>
      ) : (
        // The empty state the store split makes unavoidable, and the one
        // the spec explicitly called out: a customer with no plan must
        // land on something that explains itself, never a blank screen.
        <Card className="flex flex-col gap-3 p-5">
          <span className="text-sm font-medium">{c.noPlanTitle}</span>
          <p className="text-sm text-muted-foreground">{c.noPlanBody}</p>
          <Button onClick={onBrowsePlans}>{c.browsePlans}</Button>
        </Card>
      )}

      <Card className="flex flex-col gap-2 p-5">
        <span className="text-sm font-medium">{c.connectTitle}</span>
        <p className="text-sm text-muted-foreground">{c.connectBody}</p>
        <a
          href="/download/"
          className="mt-1 text-sm text-primary underline-offset-4 hover:underline"
        >
          {c.download}
        </a>
      </Card>

      <nav className="mt-auto grid grid-cols-3 gap-2 pt-2">
        <Button variant="outline" onClick={onOpenSettings}>
          {c.settings}
        </Button>
        <Button variant="outline" onClick={onOpenSupport}>
          {c.support}
        </Button>
        <Button variant="outline" onClick={onOpenReferrals}>
          {c.referrals}
        </Button>
      </nav>
    </div>
  );
}
