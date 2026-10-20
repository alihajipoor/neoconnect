import { createContext, useContext, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import mapSvg from "../../assets/world-map.svg?raw";
import { useI18n } from "../../lib/i18n";
import { useStagger } from "../../lib/motion";
import { cn } from "../../lib/utils";
import { PearlScope } from "../ui";

/** Whether a page is drawn inside the signed-in shell (AppShell), which
 * brings the sidebar, the tablet tabs or the phone's bottom nav. The phone
 * client and the web portal draw the same pages without it. */
export const ShellContext = createContext(false);

export function useInShell(): boolean {
  return useContext(ShellContext);
}

/** The quiet canvas behind a page: the map's two tones and its dots, faint,
 * with no lights -- a page speaks for no route, so nothing on it may look
 * like a location working. Decorative. */
export function PageScene() {
  return (
    <div className="nx-scene nx-pscene" aria-hidden>
      <div className="nx-pmap" dangerouslySetInnerHTML={{ __html: mapSvg }} />
    </div>
  );
}

/** Which page this is, for its first entrance (lib/motion.ts): the data
 * attribute that marks it -- `data-settings`, `data-settings-sub="custom"`,
 * `data-plans-awaiting` -- which every page carries for its tests, or its
 * class. Stable across languages, so changing the language is not a first
 * view. */
export function pageKey(rest: Record<string, unknown>, className?: string): string | null {
  const marks = Object.entries(rest)
    .filter(([name]) => name.startsWith("data-"))
    .map(([name, value]) => (value === true || value === "" || value === undefined ? name : `${name}=${String(value)}`));
  if (marks.length > 0) return `page:${marks.join("&")}`;
  return className ? `page.${className}` : null;
}

/** One of the signed-in pages -- Settings, Activity, Plans, Support, Invite
 * friends -- in the Pearl Glass system: a title and its sentence, then
 * content cards, in a column that scrolls inside its own panel (only the
 * page scrolls, never the window).
 *
 * The first time a page is shown in a session its header, cards and groups
 * rise in order and their rows fade in after them (motion.css); never
 * again until the app is opened anew.
 *
 * `back` is drawn where nothing else leads back: always for the pages one
 * level down (Plans, Support, Invite friends), and for Settings and
 * Activity only outside the shell, whose nav already holds them. */
export function Page({
  title,
  lede,
  back,
  backAlways = false,
  backLabel,
  wide = false,
  className,
  children,
  ...rest
}: {
  title: ReactNode;
  lede?: ReactNode;
  back?: () => void;
  backAlways?: boolean;
  backLabel?: string;
  /** Two columns of cards where the window allows. */
  wide?: boolean;
  className?: string;
  children: ReactNode;
} & Record<`data-${string}`, unknown>) {
  const { t } = useI18n();
  const inShell = useInShell();
  const showBack = back !== undefined && (backAlways || !inShell);
  const { ref, enter } = useStagger<HTMLDivElement>(pageKey(rest, className));
  const page = (
    <PearlScope>
      <div ref={ref} className={cn("nx-page", wide && "wide", className)} data-enter={enter ? "" : undefined} {...rest}>
        <div className="nx-pscroll">
          <div className="nx-pinner">
            <header className="nx-phead">
              {showBack ? (
                <button type="button" className="nx-back" onClick={back}>
                  <ArrowLeft className="nx-mir" aria-hidden />
                  {backLabel ?? t("nav.back")}
                </button>
              ) : null}
              <h1>{title}</h1>
              {lede ? <p>{lede}</p> : null}
            </header>
            {children}
          </div>
        </div>
      </div>
    </PearlScope>
  );
  if (inShell) return page;
  // Outside the shell -- the phone client, the web portal -- the page is its
  // own root, with the canvas behind it.
  return (
    <div className="nx-app nx-solo">
      <PageScene />
      {page}
    </div>
  );
}

/** Cards side by side where the page is wide enough, one column below. */
export function Columns({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("nx-cols", className)}>{children}</div>;
}
