import { useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PillButton, TextLink } from "@shared/components/ui";
import { AuthFrame, AuthHead } from "@shared/components/auth/AuthFrame";
import { useI18n } from "@shared/lib/i18n";

/** The in-app prominent disclosure Google Play requires of a VPN app.
 *
 * Play's VpnService declaration asks for a video of a disclosure shown
 * *inside* the app that explains why the app needs VpnService and what
 * personal data it collects, accepted by a deliberate tap. A link to the
 * privacy policy in Settings does not satisfy it, and neither does the
 * store listing: the requirement is runtime, before the collection
 * starts.
 *
 * So this sits ahead of the Login screen rather than behind it.
 * Registration is where the first personal data (an email address) is
 * collected and connecting is where VpnService is used, and the
 * disclosure has to precede both -- gating on the earlier of the two
 * means gating the whole app, which is also the simplest thing to film.
 *
 * The copy summarises `website/inc/content/privacy.php` rather than
 * restating a template. If the product's logging changes, both move
 * together -- in particular `disclosure.dataServerLogs` is true only
 * while the nodes' Xray config keeps an access log, and must come out
 * if that is ever set to "none".
 */

/** Where the acceptance is recorded.
 *
 * Its own file rather than a key in an existing store: this must survive
 * a sign-out, which clears session state, because the disclosure is
 * about the app and not about an account. Someone who signs out and
 * back in has already been shown it.
 */
const STORE_FILE = "disclosure.json";
const KEY = "acceptedVersion";

/** Bumped only when the disclosure's substance changes -- a new data
 * type, a new purpose. A wording fix is not a reason to show it again to
 * people who already accepted, and a typo correction that re-prompts
 * every user is its own kind of broken. */
export const DISCLOSURE_VERSION = 1;

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  // Same shape as per-app.ts: a rejected promise is never cached, or one
  // transient failure breaks the store for the life of the process.
  storePromise ??= load(STORE_FILE, { autoSave: false }).catch((err) => {
    storePromise = null;
    throw err;
  });
  return storePromise;
}

/** Whether the current disclosure has already been accepted.
 *
 * Fails closed. If the store cannot be read we show the disclosure
 * again, because showing it twice is a small annoyance and skipping it
 * is a policy breach.
 */
export async function hasAcceptedDisclosure(): Promise<boolean> {
  try {
    const store = await getStore();
    const accepted = await store.get<number>(KEY);
    return typeof accepted === "number" && accepted >= DISCLOSURE_VERSION;
  } catch {
    return false;
  }
}

async function recordAcceptance(): Promise<void> {
  try {
    const store = await getStore();
    await store.set(KEY, DISCLOSURE_VERSION);
    await store.save();
  } catch {
    // Swallowed on purpose. A failed write means the disclosure is shown
    // again next launch, which is the safe direction to fail in, and is
    // not worth blocking someone at the front door over.
  }
}

const PRIVACY_URL = "https://neoxify.net/privacy";
const PRIVACY_URL_FA = "https://neoxify.net/fa/privacy";

export function ProminentDisclosure({ onAccept }: { onAccept: () => void }) {
  const { t, language } = useI18n();
  const [pending, setPending] = useState(false);

  async function accept() {
    setPending(true);
    await recordAcceptance();
    onAccept();
  }

  // Drawn in the sign-in screens' frame (AuthFrame), which comes straight
  // after it: the wordmark and the language switch at the top, the card
  // below. The words, their order and when this shows are unchanged.
  //
  // The language switch is the frame's, above the text it governs rather
  // than buried in Settings -- Settings does not exist yet at this point,
  // and consenting to a document you cannot read is not consent. The
  // language is detected here (OS locale, then the country the CDN
  // reports), so a customer can land on the wrong one through no choice of
  // their own; this is the only screen where that is unrecoverable.
  // Choosing here also persists, so the country default stops overriding
  // on later launches.
  //
  // The page scrolls, as it always has: the whole disclosure is read
  // before the button that accepts it.
  return (
    <AuthFrame step="disclosure">
      <AuthHead title={t("disclosure.title")} lead={t("disclosure.subtitle")} />

      <section className="nx-dsc-sec">
        <h2>{t("disclosure.vpnHeading")}</h2>
        <p>{t("disclosure.vpnBody")}</p>
        <p>{t("disclosure.vpnBody2")}</p>
      </section>

      <section className="nx-dsc-sec">
        <h2>{t("disclosure.dataHeading")}</h2>
        {/* A list rather than a paragraph: a reviewer checks that each
            declared data type is named here, and so can a customer. */}
        <ul className="nx-dsc-list">
          {(
            [
              "disclosure.dataEmail",
              "disclosure.dataSupport",
              "disclosure.dataDiagnostics",
              "disclosure.dataServerLogs",
            ] as const
          ).map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        <p>{t("disclosure.dataNotSold")}</p>
      </section>

      <TextLink strong className="nx-dsc-link" onClick={() => void openUrl(language === "fa" ? PRIVACY_URL_FA : PRIVACY_URL)}>
        {t("disclosure.privacyLink")}
      </TextLink>

      {/* The affirmative action Play asks for. Nothing proceeds on a
          scroll or a back press -- only this. */}
      <PillButton className="nx-auth-submit" disabled={pending} onClick={() => void accept()}>
        {t("disclosure.accept")}
      </PillButton>
    </AuthFrame>
  );
}
