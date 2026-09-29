import { useEffect, useRef, useState, type ReactNode } from "react";

/** A full-screen layer that animates in and back out.
 *
 * The location picker -- which Server, Protocol and Change location all
 * open -- was rendered as `{open ? <Picker/> : null}`, so it covered the
 * app in a single frame and vanished the same way. Adding an entry
 * animation alone would fix half of it: the close would still be a cut,
 * and closing is the half you see more often, because you open the
 * picker to change one thing and then leave.
 *
 * So this keeps its children mounted for the length of the exit. The
 * wrapper carries the positioning rather than leaving it to the child:
 * an animated transform creates a containing block, so a child that
 * positions itself `absolute inset-0` would otherwise resolve against
 * this element once it started animating and collapse to nothing.
 */
const DURATION_MS = 200;

export function Sheet({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  // The last children rendered while open. On the way out the caller has
  // usually already dropped the data the sheet was showing -- the picker
  // needs a subscription, and `open` going false is often the same
  // render that clears it -- so the closing frame has to draw what was
  // there, not what is there now.
  const held = useRef<ReactNode>(children);
  if (open) held.current = children;

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, DURATION_MS);
    return () => clearTimeout(timer);
    // `mounted` is written here and only read to avoid starting a close
    // for a sheet that was never open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={`absolute inset-0 z-20 ${closing ? "sheet-leave" : "sheet-enter"}`}
      // On the way out it is decoration: it must not take a tap meant
      // for the screen underneath, or hold screen-reader focus.
      aria-hidden={closing ? "true" : undefined}
      style={closing ? { pointerEvents: "none" } : undefined}
    >
      {held.current}
    </div>
  );
}
