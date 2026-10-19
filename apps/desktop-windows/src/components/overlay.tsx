import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
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
    (initialFocus?.current ?? (node ? focusables(node)[0] : null) ?? node)?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!escapeRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !node) return;
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
}: {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
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
          <div className="nx-actions">{actions}</div>
        </div>
      </div>
    </>,
    document.body,
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
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  placement?: "above" | "below";
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
      const rtl = document.documentElement.dir === "rtl";
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
  }, [open, anchor, placement]);

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
