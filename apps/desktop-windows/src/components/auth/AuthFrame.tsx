import type { ReactNode } from "react";
import mapSvg from "../../assets/world-map.svg?raw";
import { LANGUAGES, useI18n, type Language } from "../../lib/i18n";
import { MARK_TONE } from "../../lib/logo-geometry";
import { LogoMark } from "../Logo";
import { GlassLogo } from "../main/GlassLogo";
import { PearlScope } from "../ui";

/** The page around sign-in, registration, password reset and email
 * verification (design-system.md 4.14), matching the website's sign-in
 * that went out first: the wordmark and a language switch at the top; on
 * a wide window the glass Neoxify mark and the tagline on the start side
 * and the strong-glass card on the end side; one column on a phone, where
 * the card is the page and it fits one screen.
 *
 * The world map is behind it, with no lights: before sign-in there is no
 * route list to speak for (5.3), so nothing on this page may look like a
 * location working. The mark wears its resting look -- frosted, unlit --
 * because there is no tunnel to be verified. Decorative throughout.
 *
 * The page's own column scrolls only as a last resort, for text scaled
 * past what the screen can hold; at every phone size the preview offers,
 * in both languages, each screen fits (`pnpm check:phone-fit`). */
export function AuthFrame({ step, children }: { step: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <PearlScope>
      <div className="nx-app nx-auth" data-step={step}>
        <div className="nx-auth-scene" aria-hidden>
          <div className="nx-auth-map" dangerouslySetInnerHTML={{ __html: mapSvg }} />
        </div>
        <div className="nx-auth-scroll">
          <header className="nx-auth-top">
            {/* The brand stays Latin and left to right in both languages. */}
            <p className="nx-auth-brand" lang="en" dir="ltr">
              <LogoMark className="nx-auth-logo drop-shadow-none" />
              <span>NEOXIFY</span>
            </p>
            <LanguageSwitch />
          </header>
          <main className="nx-auth-main">
            <div className="nx-auth-hero" aria-hidden>
              <div className="nx-auth-mark">
                <GlassLogo x={0} y={0} size={180} tone={MARK_TONE} />
              </div>
              <p className="nx-auth-tag wide">
                <span>{t("tagline.line1")}</span>
                <span>{t("tagline.line2")}</span>
              </p>
              <p className="nx-auth-tag mob">
                <span>{t("tagline.mobile1")}</span>
                <span>{t("tagline.mobile2")}</span>
              </p>
            </div>
            <section className="nx-glass strong nx-auth-card" aria-labelledby="nx-auth-title">
              {/* Keyed, so each step rises in on its own. */}
              <div className="nx-auth-step" key={step}>
                {children}
              </div>
            </section>
          </main>
        </div>
      </div>
    </PearlScope>
  );
}

/** English or Persian, before anyone has signed in: the same switch the app
 * keeps in Settings (`setLanguage`), remembered on this device. */
function LanguageSwitch() {
  const { t, language, setLanguage } = useI18n();
  return (
    <div className="nx-langsw" role="group" aria-label={t("settings.language")}>
      {(Object.keys(LANGUAGES) as Language[]).map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          dir={LANGUAGES[code].dir}
          aria-pressed={language === code}
          onClick={() => {
            if (language !== code) setLanguage(code);
          }}
        >
          {LANGUAGES[code].nativeLabel}
        </button>
      ))}
    </div>
  );
}

/** The card's heading and the sentence under it. */
export function AuthHead({ title, lead }: { title: ReactNode; lead?: ReactNode }) {
  return (
    <div className="nx-auth-head">
      <h1 id="nx-auth-title">{title}</h1>
      {lead ? <p>{lead}</p> : null}
    </div>
  );
}
