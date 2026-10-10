import { useState, type ReactElement } from "react";

import { AppleIcon, FacebookIcon, GoogleIcon } from "./BrandIcons";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { socialSignIn } from "../lib/auth";
import {
  appleSignInAvailable,
  socialSignInAvailable,
  type SocialProvider,
} from "../lib/social-auth";

/** The providers this build can actually complete a sign-in with.
 *
 * Apple is dropped off iOS-less platforms rather than shown and then
 * failing: see appleSignInAvailable(). Google and Facebook work
 * everywhere, because their flow is a browser and a server exchange
 * rather than a platform API.
 */
export function availableSocialProviders(): SocialProvider[] {
  // The web portal reuses these screens and can complete none of these
  // flows -- see socialSignInAvailable(). An empty list renders nothing,
  // including the "or use email" divider, so the form stands alone as it
  // did before.
  if (!socialSignInAvailable()) return [];
  return appleSignInAvailable()
    ? ["apple", "google", "facebook"]
    : ["google", "facebook"];
}

/** The provider buttons, above the email form on Login and Register.
 *
 * Above rather than below on purpose. These exist for people who do not
 * want to fill in a form, so putting them under the form they are
 * avoiding is the one placement that fails the audience they are for.
 *
 * Which providers appear is decided by the caller, not here. Apple is
 * offered only where the native sheet exists, because Sign in with
 * Apple on Android and Windows needs the web flow and a Services ID we
 * do not have yet -- and a button that opens a broken flow is worse
 * than no button.
 */
export function SocialSignIn({
  providers = availableSocialProviders(),
  onSuccess,
  disabled,
}: {
  providers?: SocialProvider[];
  /** Called once a session exists and is stored. Everything before that
   * -- the provider trip, the exchange, storing the tokens -- is the
   * same for Login and Register, so it lives in socialSignIn() rather
   * than being repeated in both screens. What differs is only where the
   * app goes next, which is this. */
  onSuccess: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<SocialProvider | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (providers.length === 0) return null;

  async function start(provider: SocialProvider) {
    setError(null);
    setBusy(provider);
    try {
      const result = await socialSignIn(provider);
      // A cancelled sheet is not a failure and must not show an error --
      // the customer knows what they just did, and telling them it went
      // wrong is both wrong and alarming.
      if (result === null) return;
      if (!result.ok) {
        setError(failureText(result, t) || t("auth.socialFailed"));
        return;
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("auth.socialFailed"));
    } finally {
      setBusy(null);
    }
  }

  const label: Record<SocialProvider, string> = {
    google: t("auth.continueWithGoogle"),
    apple: t("auth.continueWithApple"),
    facebook: t("auth.continueWithFacebook"),
  };
  const icon: Record<SocialProvider, ReactElement> = {
    google: <GoogleIcon className="size-5 shrink-0" />,
    apple: <AppleIcon className="size-5 shrink-0" />,
    facebook: <FacebookIcon className="size-5 shrink-0 text-[#1877F2]" />,
  };

  return (
    <div className="animate-rise">
      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => void start(p)}
            disabled={disabled || busy !== null}
            // A neutral surface rather than the app's violet gradient:
            // the gradient is the primary action, and three of them
            // competing with "Sign in" would leave no primary action at
            // all. The provider's own mark carries the recognition.
            className="press flex w-full items-center justify-center gap-3 rounded-lg border border-white/12 bg-white/[0.04] px-4 py-3 text-sm font-medium text-foreground hover:border-white/20 hover:bg-white/[0.07] disabled:opacity-50"
          >
            {busy === p ? (
              <span className="size-5 shrink-0 animate-spin-slow rounded-full border-2 border-white/25 border-t-white/80" />
            ) : (
              icon[p]
            )}
            <span>{label[p]}</span>
          </button>
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      {/* The divider says what the form below is for, rather than a bare
          rule that leaves the reader to work out why there are two ways
          to do the same thing. */}
      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t("auth.orUseEmail")}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}
