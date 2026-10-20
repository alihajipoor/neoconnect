import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Search as SearchIcon, X } from "lucide-react";
import { cn } from "../lib/utils";

/** Dialogs and menus, rendered through a portal at the document root.
 *
 * Never inside a glass element: `backdrop-filter` makes an element the
 * containing block for its `position: fixed` children, so an overlay drawn
 * inside one is clipped to it (GamePicker.tsx documents the same trap).
 * Each takes focus on open, keeps it inside, closes on Escape and gives
 * focus back to whatever had it. */

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
    (initialFocus?.current ?? node?.querySelector<HTMLElement>("[data-autofocus]") ?? (node ? focusables(node)[0] : null) ?? node)?.focus();
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
  useFocusTrap(ref, open, onClose, initialFocus);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="nx-scrim" aria-hidden onClick={onClose} />
      <div className="nx-dlgwrap" onClick={(event) => event.target === event.currentTarget && onClose?.()}>
        <div
          ref={ref}
          role={alert ? "alertdialog" : "dialog"}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          className="nx-glass strong nx-dlg"
        >
          <h2 id={titleId}>{title}</h2>
          {description ? <p id={descriptionId}>{description}</p> : null}
          {children}
          <div className="nx-actions">{actions}</div>
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
  useFocusTrap(ref, open, onClose);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="nx-scrim" aria-hidden onClick={onClose} />
      <div className="nx-dlgwrap" onClick={(event) => event.target === event.currentTarget && onClose()}>
        <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="nx-glass strong nx-dlg nx-pick">
          <div className="nx-pick-head">
            <h2 id={titleId}>{title}</h2>
            {headActions}
            <button type="button" className="nx-ibtn sm" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
              <X aria-hidden />
            </button>
          </div>
          {search ? (
            <div className="nx-search">
              <SearchIcon className="i" aria-hidden />
              <input
                type="search"
                data-autofocus
                value={search.value}
                onChange={(event) => search.onChange(event.target.value)}
                placeholder={search.placeholder}
                aria-label={search.placeholder}
              />
            </div>
          ) : null}
          {note ? <p className="nx-pick-note">{note}</p> : null}
          <div className="nx-pick-body">{children}</div>
          {foot ? <div className="nx-actions">{foot}</div> : null}
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
  const titleId = useId();
  useFocusTrap(ref, open, onClose);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <>
      <div className="nx-scrim" aria-hidden onClick={onClose} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="nx-glass strong nx-sheet">
        <div className="handle" aria-hidden />
        <div className="nx-sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="nx-ibtn" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            <X aria-hidden />
          </button>
        </div>
        <div className="nx-sheet-body">{children}</div>
      </div>
    </>,
    container ?? document.body,
  );
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
  useFocusTrap(ref, open, onClose);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = anchor.current?.getBoundingClientRect();
      if (!box) return;
      const rtl = (document.documentElement.dir === "rtl") !== (align === "end");
      const horizontal: React.CSSProperties = rtl
        ? { right: Math.max(8, window.innerWidth - box.right), transformOrigin: placement === "above" ? "bottom right" : "top right" }
        : { left: Math.max(8, box.left), transformOrigin: placement === "above" ? "bottom left" : "top left" };
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

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className={cn("nx-glass strong nx-menu")} style={style} onKeyDown={onKeyDown}>
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
  const anchor = useRef<HTMLSpanElement>(null);
  const [container, setContainer] = useState<Element | null>(null);
  const titleId = useId();
  const drag = useRef<{ y0: number; t0: number; dy: number; id: number } | null>(null);
  useFocusTrap(ref, open && container !== null, undefined);

  useLayoutEffect(() => {
    if (open) setContainer(anchor.current?.closest(".nx-app") ?? document.body);
  }, [open]);

  function onDown(event: React.PointerEvent<HTMLElement>) {
    const sheet = ref.current;
    if (!sheet || event.button !== 0 || !dismissible) return;
    drag.current = { y0: event.clientY, t0: performance.now(), dy: 0, id: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    sheet.style.transition = "none";
  }
  function onMove(event: React.PointerEvent<HTMLElement>) {
    const sheet = ref.current;
    const d = drag.current;
    if (!sheet || !d || d.id !== event.pointerId) return;
    d.dy = Math.max(0, event.clientY - d.y0);
    sheet.style.transform = `translateY(${d.dy}px)`;
  }
  function onUp(event: React.PointerEvent<HTMLElement>) {
    const sheet = ref.current;
    const d = drag.current;
    drag.current = null;
    if (!sheet || !d || d.id !== event.pointerId) return;
    const speed = d.dy / Math.max(1, performance.now() - d.t0);
    const reduce = document.documentElement.dataset.motion === "reduce";
    if (d.dy > 120 || speed > 0.6) {
      if (reduce) {
        onClose();
        return;
      }
      sheet.style.transition = "transform 220ms cubic-bezier(.4,0,1,1)";
      sheet.style.transform = "translateY(110%)";
      setTimeout(onClose, 220);
      return;
    }
    sheet.style.transition = reduce ? "none" : "transform var(--dur-snappy) var(--spring-snappy)";
    sheet.style.transform = "";
  }
  const handle = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };

  return (
    <>
      <span ref={anchor} hidden />
      {open && container
        ? createPortal(
            <>
              <div className="nx-scrim" aria-hidden onClick={dismissible ? onClose : undefined} />
              <div
                ref={ref}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                className="nx-glass strong nx-sheet nx-locsheet"
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
