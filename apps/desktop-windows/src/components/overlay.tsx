import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search as SearchIcon, X } from "lucide-react";
import { curve, dragOutcome, motionReduced, play, scrimFor, useOpenSnapshot, usePresence } from "../lib/motion";
import { cn } from "../lib/utils";

/** Dialogs and menus, rendered through a portal at the document root.
 *
 * Never inside a glass element: `backdrop-filter` makes an element the
 * containing block for its `position: fixed` children, so an overlay drawn
 * inside one is clipped to it (GamePicker.tsx documents the same trap).
 * Each takes focus on open, keeps it inside, closes on Escape and gives
 * focus back to whatever had it.
 *
 * Each also leaves the way it came (lib/motion.ts `usePresence`): kept
 * for its exit, marked `data-state="closed"` and inert, so the scrim
 * fades, a dialog or a menu shrinks back into place and a sheet slides
 * down (motion.css) -- nothing vanishes in one frame. Focus goes back at
 * once, when it closes, not when the exit ends. */

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** Focus in, kept in, and back out; Escape. */
function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onEscape: (() => void) | undefined,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = ref.current;
    // A field marked `data-autofocus` -- the location sheet's search -- before
    // the first control, which is the close button.
    // Without scrolling: an overlay is still arriving (a sheet starts below
    // the edge), and focusing it must not scroll whatever is under it.
    (initialFocus?.current ?? node?.querySelector<HTMLElement>("[data-autofocus]") ?? (node ? focusables(node)[0] : null) ?? node)?.focus({
      preventScroll: true,
    });
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!escapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
      // A dialog opened over this one -- the switch confirmation over the
      // location sheet -- keeps the focus it has.
      const above = document.activeElement?.closest('[aria-modal="true"]');
      if (above && above !== node && !node.contains(above)) return;
      const items = focusables(node);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!node.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (previous?.isConnected) previous.focus();
    };
    // Once per opening: refs are read when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** A modal dialog over a scrim: strong glass, labelled and described.
 * Initial focus goes to the safe action -- pass it as `initialFocus`. */
export function Dialog({
  open,
  title,
  description,
  onClose,
  actions,
  alert = false,
  initialFocus,
  children,
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  /** Anything between the sentence and the buttons: a list, a field. */
  children?: ReactNode;
  /** Escape and the scrim. Absent, neither closes it: a choice must be made. */
  onClose?: () => void;
  actions: ReactNode;
  alert?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const { mounted, closing } = usePresence(open);
  // Drawn from what it said open, while it closes (lib/motion.ts).
  const held = useOpenSnapshot(open, { title, description, actions, children });
  useFocusTrap(ref, open, onClose, initialFocus);
  if (!mounted || typeof document === "undefined") return null;
  const state = closing ? "closed" : "open";
  return createPortal(
    <>
      <div className="nx-scrim" data-state={state} aria-hidden onClick={closing ? undefined : onClose} />
      <div
        className="nx-dlgwrap"
        data-state={state}
        inert={closing || undefined}
        onClick={(event) => !closing && event.target === event.currentTarget && onClose?.()}
      >
        <div
          ref={ref}
          role={alert ? "alertdialog" : "dialog"}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={held.description ? descriptionId : undefined}
          tabIndex={-1}
          className="nx-glass strong nx-dlg"
        >
          <h2 id={titleId}>{held.title}</h2>
          {held.description ? <p id={descriptionId}>{held.description}</p> : null}
          {held.children}
          <div className="nx-actions">{held.actions}</div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** A modal list to pick from -- the running apps, the game catalogue: a
 * title and its buttons, a search field that takes the first focus, a
 * note, the list (the one part that scrolls) and a foot. Strong glass over
 * a scrim, through a portal at the document root, focus kept inside and
 * given back, Escape and the scrim to close: the same as `Dialog`, sized
 * for a list. */
export function PickerDialog({
  open,
  title,
  onClose,
  closeLabel,
  headActions,
  search,
  note,
  children,
  foot,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  closeLabel: string;
  /** Buttons beside the close button: Refresh. */
  headActions?: ReactNode;
  search?: { value: string; onChange: (value: string) => void; placeholder: string };
  /** A line under the search, about what the list is. */
  note?: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { mounted, closing } = usePresence(open);
  // Drawn from what it said open, while it closes (lib/motion.ts).
  const held = useOpenSnapshot(open, { title, headActions, search, note, children, foot });
  useFocusTrap(ref, open, onClose);
  if (!mounted || typeof document === "undefined") return null;
  const state = closing ? "closed" : "open";
  const { title: shownTitle, headActions: shownHead, search: shownSearch, note: shownNote, children: shownBody, foot: shownFoot } = held;
  return createPortal(
    <>
      <div className="nx-scrim" data-state={state} aria-hidden onClick={closing ? undefined : onClose} />
      <div
        className="nx-dlgwrap"
        data-state={state}
        inert={closing || undefined}
        onClick={(event) => !closing && event.target === event.currentTarget && onClose()}
      >
        <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="nx-glass strong nx-dlg nx-pick">
          <div className="nx-pick-head">
            <h2 id={titleId}>{shownTitle}</h2>
            {shownHead}
            <button type="button" className="nx-ibtn sm" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
              <X aria-hidden />
            </button>
          </div>
          {shownSearch ? (
            <div className="nx-search">
              <SearchIcon className="i" aria-hidden />
              <input
                type="search"
                data-autofocus
                value={shownSearch.value}
                onChange={(event) => shownSearch.onChange(event.target.value)}
                placeholder={shownSearch.placeholder}
                aria-label={shownSearch.placeholder}
              />
            </div>
          ) : null}
          {shownNote ? <p className="nx-pick-note">{shownNote}</p> : null}
          <div className="nx-pick-body">{shownBody}</div>
          {shownFoot ? <div className="nx-actions">{shownFoot}</div> : null}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** A sheet from the bottom edge over a scrim, for what a phone's one screen
 * folds away: labelled, modal, and the one thing on that screen that may
 * scroll -- its body does, inside it, when it is taller than 88% of the
 * screen. `container` is where it is drawn: the app root, which holds
 * fixed-position children to its own box (it is a size container) and
 * carries the safe areas; the document root otherwise. */
export function BottomSheet({
  open,
  title,
  closeLabel,
  onClose,
  container,
  children,
}: {
  open: boolean;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  container?: Element | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { mounted, closing } = usePresence(open);
  // Drawn where it opened, and kept there while it slides away.
  const held = useRef<Element | null>(null);
  if (open) held.current = container ?? null;
  useFocusTrap(ref, open, onClose);
  const handle = useSheetDrag(ref, scrim, onClose, open, open);
  if (!mounted || typeof document === "undefined") return null;
  const state = closing ? "closed" : "open";
  return createPortal(
    <>
      <div ref={scrim} className="nx-scrim" data-state={state} aria-hidden onClick={closing ? undefined : onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="nx-glass strong nx-sheet"
        data-state={state}
        inert={closing || undefined}
      >
        <div className="handle" aria-hidden {...handle} />
        <div className="nx-sheet-head" {...handle}>
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="nx-ibtn"
            onClick={onClose}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={closeLabel}
            title={closeLabel}
          >
            <X aria-hidden />
          </button>
        </div>
        <div className="nx-sheet-body">{children}</div>
      </div>
    </>,
    held.current ?? container ?? document.body,
  );
}

/** A sheet's handle and head follow the finger down. Let go past 120px, or
 * flung faster than .6px/ms, and it goes the rest of the way at about the
 * speed it was going; otherwise it springs back on the snappy spring
 * (design-system.md 6.1). The scrim thins as it goes. Under reduced motion
 * it still follows the finger -- that is the customer moving it, not the
 * app -- but closes or returns at once. Never while it may not close
 * (`dismissible`: a switch in flight). */
function useSheetDrag(
  sheetRef: RefObject<HTMLDivElement | null>,
  scrimRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  dismissible: boolean,
  open: boolean,
) {
  const drag = useRef<{ y0: number; t0: number; dy: number; id: number; h: number } | null>(null);
  /** A flick's way out, held at its end: let go if the sheet is opened
   * again before its exit is over, or it would stay out of sight. */
  const away = useRef<Animation[]>([]);
  useEffect(() => {
    if (!open) return;
    away.current.forEach((a) => a.cancel());
    away.current = [];
  }, [open]);
  function onDown(event: React.PointerEvent<HTMLElement>) {
    const sheet = sheetRef.current;
    if (!sheet || event.button !== 0 || !dismissible) return;
    drag.current = { y0: event.clientY, t0: performance.now(), dy: 0, id: event.pointerId, h: sheet.getBoundingClientRect().height };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    sheet.dataset.drag = "1";
  }
  function onMove(event: React.PointerEvent<HTMLElement>) {
    const sheet = sheetRef.current;
    const d = drag.current;
    if (!sheet || !d || d.id !== event.pointerId) return;
    d.dy = Math.max(0, event.clientY - d.y0);
    sheet.style.transform = `translateY(${d.dy}px)`;
    if (scrimRef.current) scrimRef.current.style.opacity = String(scrimFor(d.dy, d.h));
  }
  function onUp(event: React.PointerEvent<HTMLElement>) {
    const sheet = sheetRef.current;
    const d = drag.current;
    drag.current = null;
    if (!sheet || !d || d.id !== event.pointerId) return;
    delete sheet.dataset.drag;
    const scrim = scrimRef.current;
    const reduce = motionReduced();
    const elapsed = Math.max(1, performance.now() - d.t0);
    const settle = () => {
      sheet.style.transform = "";
      if (scrim) scrim.style.opacity = "";
    };
    if (dragOutcome(d.dy, elapsed) === "close") {
      if (reduce) {
        settle();
        onClose();
        return;
      }
      const rest = Math.max(0, d.h - d.dy);
      const ms = Math.round(Math.min(240, Math.max(140, rest / Math.max(0.8, d.dy / elapsed))));
      const out = { duration: ms, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" as const };
      settle();
      for (const a of [
        play(sheet, [{ transform: `translateY(${d.dy}px)` }, { transform: "translateY(110%)" }], out),
        scrim ? play(scrim, [{ opacity: scrimFor(d.dy, d.h) }, { opacity: 0 }], out) : null,
      ]) {
        if (a) away.current.push(a);
      }
      setTimeout(onClose, ms);
      return;
    }
    if (reduce || d.dy === 0) {
      settle();
      return;
    }
    const back = curve("snappy");
    const scrimFrom = scrimFor(d.dy, d.h);
    settle();
    play(sheet, [{ transform: `translateY(${d.dy}px)` }, { transform: "translateY(0)" }], back);
    if (scrim) play(scrim, [{ opacity: scrimFrom }, { opacity: 1 }], back);
  }
  return { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };
}

/** A menu that springs from its trigger: arrows, Home and End move focus,
 * Escape and a press outside close it and give focus back. */
export function Menu({
  open,
  anchor,
  onClose,
  label,
  placement = "above",
  align = "start",
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  placement?: "above" | "below";
  /** Which edge of the trigger the menu lines up with: its inline start, or
   * its inline end -- for a trigger at the window's end edge. */
  align?: "start" | "end";
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });
  const { mounted, closing } = usePresence(open);
  useFocusTrap(ref, open, onClose);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      const rtl = (document.documentElement.dir === "rtl") !== (align === "end");
      // Never wider than the room on the side it grows into: a menu lined
      // up with the wrong edge of its trigger wraps its rows rather than
      // leaving the screen.
      const right = Math.max(8, window.innerWidth - box.right);
      const left = Math.max(8, box.left);
      const horizontal: React.CSSProperties = rtl
        ? { right, maxWidth: window.innerWidth - right - 8, transformOrigin: placement === "above" ? "bottom right" : "top right" }
        : { left, maxWidth: window.innerWidth - left - 8, transformOrigin: placement === "above" ? "bottom left" : "top left" };
      setStyle(
        placement === "above"
          ? { ...horizontal, bottom: window.innerHeight - box.top + 8 }
          : { ...horizontal, top: box.bottom + 8 },
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor, placement, align]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, anchor, onClose]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const items = ref.current ? Array.from(ref.current.querySelectorAll<HTMLElement>('[role="menuitem"]')) : [];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      event.preventDefault();
      items[(i + items.length) % items.length].focus();
    };
    if (event.key === "ArrowDown") go(at + 1);
    else if (event.key === "ArrowUp") go(at - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(items.length - 1);
  }

  if (!mounted || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={cn("nx-glass strong nx-menu")}
      data-state={closing ? "closed" : "open"}
      inert={closing || undefined}
      style={style}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The phone's location list (design-system.md 4.8): a sheet from the
 * bottom edge, modal, with a scrim, focus kept inside and given back to
 * whatever opened it (the location card), and a handle that follows the
 * finger -- released past 120px, or flung faster than .6px/ms, it closes;
 * otherwise it springs back.
 *
 * Escape is the list's own (`LocationPicker`): it is ignored while a switch
 * is in flight, because closing would not recall a request already sent.
 * The sheet's own ways out -- the scrim, the handle, the close button -- go
 * by the same rule (`dismissible`): closed mid-switch, the list was gone
 * when its answer came, and a switch that failed was never said.
 *
 * Drawn into the app root, which holds fixed-position children to its own
 * box and carries the safe areas; found from where the sheet is placed. */
export function LocationSheet({
  open,
  title,
  closeLabel,
  onClose,
  dismissible = true,
  children,
}: {
  open: boolean;
  title: ReactNode;
  closeLabel: string;
  onClose: () => void;
  /** False while a switch is in flight: nothing closes the sheet. */
  dismissible?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<Element | null>(null);
  const titleId = useId();
  const { mounted, closing } = usePresence(open);
  useFocusTrap(ref, open && container !== null, undefined);

  useLayoutEffect(() => {
    if (open) setContainer(anchor.current?.closest(".nx-app") ?? document.body);
  }, [open]);

  const handle = useSheetDrag(ref, scrim, onClose, dismissible, open);
  const state = closing ? "closed" : "open";

  return (
    <>
      <span ref={anchor} hidden />
      {mounted && container
        ? createPortal(
            <>
              <div
                ref={scrim}
                className="nx-scrim"
                data-state={state}
                aria-hidden
                onClick={dismissible && !closing ? onClose : undefined}
              />
              <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="nx-glass strong nx-sheet nx-locsheet"
                data-state={state}
                inert={closing || undefined}
              >
                <div className="handle" aria-hidden {...handle} />
                <div className="nx-sheet-head" {...handle}>
                  <h2 id={titleId}>{title}</h2>
                  <button
                    type="button"
                    className="nx-ibtn"
                    onClick={onClose}
                    onPointerDown={(event) => event.stopPropagation()}
                    disabled={!dismissible}
                    aria-label={closeLabel}
                    title={closeLabel}
                  >
                    <X aria-hidden />
                  </button>
                </div>
                {children}
              </div>
            </>,
            container,
          )
        : null}
    </>
  );
}
