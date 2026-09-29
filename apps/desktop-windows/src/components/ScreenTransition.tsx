import { useEffect, useRef, useState, type ReactNode } from "react";

/** Motion between screens.
 *
 * The app swapped screens by returning a different component, so a tap
 * on Settings replaced the entire view in one frame -- the Dashboard
 * animates its own contents in, and then every navigation after that
 * was a hard cut. Reported as "no animation when opening or closing",
 * which was fair: the app looks alive until you go anywhere.
 *
 * Both halves are animated, not just the arrival. An enter-only
 * transition still reads as a cut, because the thing you were looking
 * at vanishes instantly and the new screen appears over the gap.
 *
 * Done without an animation library on purpose. The rest of the app's
 * motion is hand-written CSS in theme.css, and adding Motion to a
 * binary that ships to people on censored networks is a lot of
 * JavaScript to buy two keyframes that already exist.
 */

/** How deep each screen sits, which is what decides the direction.
 *
 * Going deeper slides forward, coming back slides back -- the same
 * grammar every phone OS uses, and the reason back feels like back
 * rather than another arrival. Screens not listed are depth 0, so an
 * unrecognised one still animates rather than failing to render. */
const DEPTH: Record<string, number> = {
  loading: 0,
  disclosure: 0,
  login: 0,
  register: 1,
  forgot: 1,
  verify: 2,
  dashboard: 0,
  settings: 1,
  plans: 1,
  referrals: 2,
  support: 2,
};

/** Matches the CSS below. Long enough to read as movement, short enough
 * that it never feels like waiting for the app. */
const DURATION_MS = 220;

export function ScreenTransition({
  screenKey,
  children,
}: {
  screenKey: string;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState({ key: screenKey, node: children });
  const [leaving, setLeaving] = useState<{
    key: string;
    node: ReactNode;
  } | null>(null);
  const [back, setBack] = useState(false);

  // Held in a ref because `children` is a new element on every render:
  // depending on it in the effect would restart the transition
  // continuously, and depending on `current` would make the effect
  // re-run on its own update.
  const latest = useRef(children);
  latest.current = children;
  const showing = useRef(screenKey);

  useEffect(() => {
    if (showing.current === screenKey) return;
    const from = showing.current;
    showing.current = screenKey;
    setBack((DEPTH[screenKey] ?? 0) < (DEPTH[from] ?? 0));
    setLeaving({ key: from, node: current.node });
    setCurrent({ key: screenKey, node: latest.current });
    const timer = setTimeout(() => setLeaving(null), DURATION_MS);
    return () => clearTimeout(timer);
    // `current` is deliberately not a dependency -- it is written here,
    // and reading the outgoing node is the only thing it is needed for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenKey]);

  // Keep the visible screen's content fresh while it is not transitioning,
  // otherwise state updates inside a screen would stop rendering.
  useEffect(() => {
    if (leaving === null && current.key === screenKey)
      setCurrent({ key: screenKey, node: children });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {leaving ? (
        // Absolutely positioned so the two screens overlap for the
        // handover instead of stacking and shoving the layout down.
        // aria-hidden and inert: it is on its way out, and a screen
        // reader or a stray tap should not reach it.
        <div
          key={leaving.key}
          aria-hidden="true"
          // @ts-expect-error -- `inert` is valid HTML that React's types
          // have not caught up with on this version.
          inert=""
          className={`absolute inset-0 h-full ${back ? "screen-leave-back" : "screen-leave"}`}
        >
          {leaving.node}
        </div>
      ) : null}
      <div
        key={current.key}
        className={`h-full ${back ? "screen-enter-back" : "screen-enter"}`}
      >
        {current.node}
      </div>
    </div>
  );
}
