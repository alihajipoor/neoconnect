import { useEffect, useState, type ReactNode } from "react";
import { LANGUAGES, useI18n, type Language } from "@shared/lib/i18n";
import { peek } from "../shims/plugin-store";
import { BrandMark, GlassMark } from "./marks";
import { sitePath, useCopy, type CopyKey } from "./copy";
import "./scene.css";
import "./auth.css";

export type AuthScreen = "loading" | "login" | "register" | "forgot" | "verify";

const TITLE: Record<Exclude<AuthScreen, "loading">, CopyKey> = {
  login: "titleLogin",
  register: "titleRegister",
  forgot: "titleForgot",
  verify: "titleVerify",
};

/** Where the shared I18nProvider keeps the visitor's chosen language
 * (STORE_FILE and STORE_KEY in lib/i18n.tsx; pinned by the test). */
export const LANGUAGE_STORE = ["settings.json", "language"] as const;

/** The longest the page waits, after the script runs, for the chosen
 * language and its typeface before drawing anyway. */
export const READY_CAP_MS = 1200;

/** The faces each language draws the card and the tagline in. */
const FACES: Record<Language, string[]> = {
  en: ['400 16px "Inter"', '700 16px "Inter"', '700 40px "Inter Tight"'],
  fa: ['400 16px "Vazirmatn"', '800 16px "Vazirmatn"'],
};

/**
 * Whether the page can be drawn without redrawing it a moment later.
 *
 * Two things would otherwise move it under the visitor: the provider
 * restores a saved language after its first render, so a Persian reader
 * got a frame of English that then reflowed into Persian; and text drawn
 * in a fallback face reflows when the real one arrives. So the card waits
 * -- over the canvas and map, which are already on screen -- until the
 * saved language is the one showing and its face is loaded, or until
 * READY_CAP_MS has passed, whichever is first. Once drawn it never hides
 * again: a language the visitor switches to is drawn at once.
 */
function useReadyToDraw(): boolean {
  const { language } = useI18n();
  // Without a document (rendered on a server or in a test) there is
  // nothing to wait for.
  const [ready, setReady] = useState(() => typeof document === "undefined");
  const [saved] = useState(() => {
    const value = peek<string>(...LANGUAGE_STORE);
    return value && value in LANGUAGES ? (value as Language) : null;
  });
  const settled = saved === null || saved === language;

  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setReady(true), READY_CAP_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    if (ready || !settled) return;
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    if (!fonts) return setReady(true);
    let live = true;
    Promise.all(FACES[language].map((face) => fonts.load(face))).then(
      () => live && setReady(true),
      () => live && setReady(true),
    );
    return () => {
      live = false;
    };
  }, [ready, settled, language]);

  return ready;
}

/**
 * The page around the sign-in screens: the Pearl Glass look the owner
 * approved for the apps (design-system.md, 4.14), on the web.
 *
 * The world map and the canvas behind it are NOT drawn here. They are
 * static markup in index.html, so they paint before any script has run
 * -- the first thing a visitor on a slow network sees is the page, not a
 * blank screen -- and App.tsx only switches them off (data-surface) for
 * the account screens, which keep the old dark look until their own
 * redesign. No lights on the map: before sign-in there is no route list
 * to speak for (design-system.md 5.3).
 *
 * Layout: wordmark and language at the top; the glass mark and the
 * tagline on the start side; the strong-glass card on the end side. One
 * column on phones, where the card is the page.
 */
export function AuthShell({ screen, children }: { screen: AuthScreen; children: ReactNode }) {
  const { language } = useI18n();
  const copy = useCopy();
  const ready = useReadyToDraw();

  // A title that says which step this is, in the reader's language: it is
  // what a screen reader announces first and what a tab is labelled with.
  useEffect(() => {
    document.title = screen === "loading" ? "Neoxify" : `${copy[TITLE[screen]]} — Neoxify`;
  }, [screen, copy]);

  if (!ready) {
    return (
      <div className="pa" data-screen="loading">
        <p className="pa-sr" role="status">
          {copy.loading}
        </p>
      </div>
    );
  }

  return (
    <div className="pa" data-screen={screen}>
      <header className="pa-top">
        {/* The wordmark is the link's name: "Neoxify", drawn in capitals
            by CSS, so what a reader hears is what everyone sees. */}
        <a className="pa-brand" href={sitePath(language, "")}>
          <BrandMark className="pa-brand-mark" />
          <span className="pa-word" dir="ltr" lang="en">
            Neoxify
          </span>
        </a>
        <LanguageSwitch />
      </header>

      <main className="pa-main">
        <div className="pa-hero">
          <GlassMark className="pa-gm" />
          {/* The tagline is the brand's line, not this page's heading: the
              card's title is the h1. */}
          <p className="pa-tag pa-tag-wide">
            <span>{copy.taglineWide1}</span>
            <span>{copy.taglineWide2}</span>
          </p>
          <p className="pa-tag pa-tag-phone">
            <span>{copy.taglinePhone1}</span>
            <span>{copy.taglinePhone2}</span>
          </p>
          <p className="pa-lede">{copy.lede}</p>
        </div>

        {screen === "loading" ? (
          // Signed-in visitors pass through here for a moment on their way
          // to the account: say nothing on screen, but say it to a reader.
          <p className="pa-sr" role="status">
            {copy.loading}
          </p>
        ) : (
          <section className="pa-card" aria-labelledby="pa-title">
            {/* Keyed, so each step rises in on its own. */}
            <div className="pa-step" key={screen}>
              {children}
            </div>
          </section>
        )}
      </main>

      <footer className="pa-foot">
        <a href={sitePath(language, "")}>{copy.home}</a>
        <a href={sitePath(language, "privacy/")}>{copy.privacy}</a>
        <a href={sitePath(language, "contact/")}>{copy.contact}</a>
      </footer>
    </div>
  );
}

/** English or Persian, before anyone has signed in. The same switch the
 * apps keep in Settings (`setLanguage`): remembered, and told to the
 * server only once there is an account to tell. */
function LanguageSwitch() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div className="pa-lang" role="group" aria-label={t("settings.language")}>
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

/** The card's heading and the sentence under it, shared by every step. */
export function CardHead({ title, lead }: { title: string; lead?: ReactNode }) {
  return (
    <div className="pa-head">
      <h1 id="pa-title" className="pa-title">
        {title}
      </h1>
      {lead ? <p className="pa-lead">{lead}</p> : null}
    </div>
  );
}
