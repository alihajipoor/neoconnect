import { effects } from "@shared/lib/effects";

/** Which of the portal's two looks is on screen, on <html> as
 * `data-surface`: the sign-in steps in the website's own ("auth", ./auth),
 * or the apps' shared screens behind sign-in ("app").
 *
 * The sign-in follows the system's light or dark and nothing else: its
 * tokens are its own (auth.css), and were never written for a theme chosen
 * in Settings. That choice is the shared screens' -- `data-theme` on
 * <html>, set by the effects (lib/effects.ts) -- and left there it
 * outranked the sign-in: theme.css's `:root[data-theme]` beats auth.css's
 * `html[data-surface="auth"]`, so a visitor who once chose Dark, on a light
 * system, got the light sign-in with dark scrollbars, autofill and form
 * chrome, and the shared pieces in the card read the dark tokens. So the
 * theme is on <html> only while the shared screens are. */
export type Surface = "auth" | "app";

export function setSurface(surface: Surface, root: HTMLElement = document.documentElement): void {
  root.dataset.surface = surface;
  applyTheme(root);
}

/** The stored theme while the shared screens show, none on the sign-in. */
export function applyTheme(root: HTMLElement = document.documentElement): void {
  const theme = root.dataset.surface === "auth" ? "system" : effects.current().theme;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Right after `startEffects()`: takes the theme it set off the sign-in the
 * page opens on, and again whenever the effects apply themselves anew -- a
 * system setting changing while someone is signing in. */
export function keepThemeOffSignIn(): () => void {
  applyTheme();
  return effects.subscribe(() => applyTheme());
}
