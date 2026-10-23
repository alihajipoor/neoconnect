import { useEffect, useRef, useState } from "react";
import { collectSocialHandoff } from "@shared/lib/auth";
import { useI18n } from "@shared/lib/i18n";
import { failureText, type ShownFailure } from "@shared/lib/failure-text";
import { Message } from "./controls";
import { useCopy, type CopyKey } from "./copy";
import { FacebookMark, GoogleMark } from "./marks";
import {
  NO_RETURN,
  WEB_PROVIDERS,
  beginWebSocialSignIn,
  claim,
  takeSocialReturn,
  type PendingSocial,
  type SocialReturn,
  type WebProvider,
} from "./social-web";

/** What App hands the sign-in screens for a provider sign-in: what the page
 * arrived with, and what to carry across the trip. */
export interface PortalSocial {
  returned: SocialReturn;
  carry: Pick<PendingSocial, "voucher" | "plan">;
}

export const NO_SOCIAL: PortalSocial = { returned: NO_RETURN, carry: { voucher: null, plan: false } };

/** How long the page waits, once it has sent the browser to a provider,
 * before saying the provider may be blocked. The page stays on screen
 * until the next one loads, so a blocked provider would otherwise leave
 * the button spinning for as long as the browser keeps trying. */
export const SLOW_LEAVE_MS = 12_000;

/** The server's short codes (OauthFlowService.webErrorCode), and the
 * page's own `lost`, as the portal words them. Anything else -- `failed`,
 * `invalid`, a code from a newer server -- is the apps' general line. */
const ERROR_COPY: Readonly<Record<string, CopyKey>> = {
  expired: "socialExpired",
  disabled: "socialDisabled",
  exists: "socialExists",
  unverified: "socialUnverified",
  "no-email": "socialNoEmail",
  lost: "socialLost",
};

type Shown = { tone: "danger" | "neutral"; text: string } | null;

/** The words a return is answered with: the portal's own (`say`, with the
 * provider's name put in) and the apps' (`t`). */
export interface ReturnWords {
  say: (key: CopyKey, provider: WebProvider | null) => string;
  t: (key: "auth.socialFailed") => string;
  failure: (result: ShownFailure) => string;
}

/** What a return comes to: a stored session, a sentence, or nothing.
 *
 * A handoff is collected with the verifier its trip left with, and only
 * then is it a sign-in. A refusal is worded by its code; a code this page
 * does not know -- `failed`, `invalid`, one a newer server adds -- is the
 * apps' general line rather than nothing. */
export async function settleReturn(
  found: SocialReturn,
  words: ReturnWords,
  collect: typeof collectSocialHandoff = collectSocialHandoff,
): Promise<{ signedIn: true } | { signedIn: false; shown: Shown }> {
  switch (found.kind) {
    case "handoff": {
      const result = await collect(found.code, found.pending.verifier);
      if (result.ok) return { signedIn: true };
      return { signedIn: false, shown: { tone: "danger", text: words.failure(result) || words.t("auth.socialFailed") } };
    }
    case "error": {
      const key = ERROR_COPY[found.code];
      const text = key ? words.say(key, found.pending?.provider ?? null) : words.t("auth.socialFailed");
      return { signedIn: false, shown: { tone: "danger", text } };
    }
    case "unfinished":
      return { signedIn: false, shown: { tone: "neutral", text: words.say("socialNotFinished", found.pending.provider) } };
    default:
      // Nothing to say: no trip, or Cancel pressed at the provider.
      return { signedIn: false, shown: null };
  }
}

/**
 * "Continue with Google" and "Continue with Facebook", as the portal draws
 * them, above the email form on Sign in and Create account -- where the
 * apps put theirs, for the same reason: they are for people who would
 * rather not fill in the form.
 *
 * Unlike the apps' buttons (components/SocialSignIn.tsx), these leave the
 * page; social-web.ts is the trip. What comes back is finished here:
 * a handoff is collected with the verifier and then goes exactly where a
 * password sign-in goes (`onSuccess`), a refusal is said in the visitor's
 * language, and a trip that came back with nothing says plainly that the
 * provider may be blocked, rather than leaving a button spinning.
 *
 * Apple is not offered: on the web it needs an Apple Services ID that
 * does not exist yet.
 */
export function SocialSignIn({
  social = NO_SOCIAL,
  from,
  onSuccess,
  disabled,
}: {
  social?: PortalSocial;
  /** The screen this is on, to come back to. */
  from: PendingSocial["screen"];
  /** Called once the session is stored -- the same handler a password
   * sign-in calls. */
  onSuccess: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const copy = useCopy();
  // Leaving for this provider: the address race, then the navigation.
  const [leaving, setLeaving] = useState<WebProvider | null>(null);
  // Collecting the session this provider's trip came back with.
  const [collecting, setCollecting] = useState<WebProvider | null>(null);
  const [slow, setSlow] = useState<WebProvider | null>(null);
  const [shown, setShown] = useState<Shown>(null);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest handlers, for the page-lifecycle listeners registered once.
  const settleRef = useRef<(found: SocialReturn) => void>(() => {});

  const name = (p: WebProvider | null) => (p === "facebook" ? copy.nameFacebook : copy.nameGoogle);
  const say = (key: CopyKey, provider: WebProvider | null) => copy[key].split("{provider}").join(name(provider));

  async function settle(found: SocialReturn) {
    if (found.kind === "handoff") setCollecting(found.pending.provider);
    const outcome = await settleReturn(found, { say, t, failure: (result) => failureText(result, t) });
    setCollecting(null);
    if (outcome.signedIn) onSuccess();
    else setShown(outcome.shown);
  }
  settleRef.current = (found) => void settle(found);

  // What the page arrived with, once.
  useEffect(() => {
    if (claim(social.returned)) settleRef.current(social.returned);
  }, [social.returned]);

  // Back from the provider's page into a page the browser kept whole
  // (the back-forward cache): no load, so nothing above runs again, and
  // the button would still be spinning. Read the trip afresh instead.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      if (slowTimer.current) clearTimeout(slowTimer.current);
      setLeaving(null);
      setSlow(null);
      const found = takeSocialReturn();
      if (claim(found)) settleRef.current(found);
    };
    // Gone to the provider: the slow note is for a page still showing.
    const onHide = () => {
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
    window.addEventListener("pageshow", onShow);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pageshow", onShow);
      window.removeEventListener("pagehide", onHide);
      if (slowTimer.current) clearTimeout(slowTimer.current);
    };
  }, []);

  async function start(provider: WebProvider) {
    setShown(null);
    setSlow(null);
    setLeaving(provider);
    let outcome: "left" | "unsafe";
    try {
      outcome = await beginWebSocialSignIn(provider, { screen: from, ...social.carry });
    } catch {
      outcome = "unsafe";
    }
    if (outcome === "unsafe") {
      setLeaving(null);
      setShown({ tone: "danger", text: say("socialUnsafe", provider) });
      return;
    }
    // Sent. The spinner stays until the provider's page replaces this one;
    // if that takes too long, say why it might not.
    slowTimer.current = setTimeout(() => setSlow(provider), SLOW_LEAVE_MS);
  }

  const busy = leaving ?? collecting;
  const label: Record<WebProvider, string> = {
    google: t("auth.continueWithGoogle"),
    facebook: t("auth.continueWithFacebook"),
  };

  return (
    <div className="pa-social">
      <div className="pa-social-row">
        {WEB_PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            className="pa-soc"
            onClick={() => void start(p)}
            disabled={disabled || busy !== null}
            aria-busy={busy === p || undefined}
          >
            {busy === p ? (
              <span className="pa-spin pa-spin-ink" aria-hidden="true" />
            ) : p === "google" ? (
              <GoogleMark className="pa-soc-mark" />
            ) : (
              <FacebookMark className="pa-soc-mark" />
            )}
            <span>{label[p]}</span>
          </button>
        ))}
      </div>

      {collecting ? (
        <p className="pa-note" role="status">
          {t("auth.signingIn")}
        </p>
      ) : null}
      {slow ? (
        <Message tone="neutral" data-social-slow>
          {say("socialSlow", slow)}
        </Message>
      ) : null}
      {shown ? <Message tone={shown.tone}>{shown.text}</Message> : null}

      {/* What the form below is for, rather than a bare rule. */}
      <div className="pa-or">
        <span>{t("auth.orUseEmail")}</span>
      </div>
    </div>
  );
}
