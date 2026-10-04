import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The window's own title bar, drawn by the app instead of by Windows.
 *
 * With `decorations: false` in `tauri.conf.json` the OS draws nothing,
 * so everything a caption bar does has to be done here: dragging the
 * window, double-click to maximise, and the three buttons. Miss one and
 * the window simply cannot be moved, which is a worse outcome than the
 * light-grey bar this replaces.
 *
 * **The buttons need capability permissions, not just code.** Tauri's
 * `core:default` set does not include `window:allow-minimize`,
 * `allow-toggle-maximize`, `allow-close` or `allow-start-dragging`.
 * Without them every control here renders correctly and does nothing at
 * all -- the silent-failure shape this repo keeps getting bitten by, and
 * the reason `api-endpoints.scope.test.ts` exists for the HTTP scope.
 * They are granted in `capabilities/default.json`.
 *
 * Height is 32px to match what Windows 11 draws for a compact caption
 * bar, so the content below sits where it did before.
 */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;

    const sync = () =>
      void win.isMaximized().then(
        (m) => {
          if (alive) setMaximized(m);
        },
        () => {},
      );
    sync();

    // The window can be maximised without this bar being touched --
    // Win+Up, a drag to the top edge, a double-click on the resize
    // border -- so the glyph follows the window rather than the click.
    const unlisten = win.onResized(() => sync());
    return () => {
      alive = false;
      void unlisten.then((f) => f()).catch(() => {});
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <div
      data-tauri-drag-region
      className="flex h-8 shrink-0 select-none items-center justify-between border-b border-white/5 bg-background/80 pl-3"
    >
      {/* Also a drag target: a bar you can only move by its empty middle
          is a bar people think is stuck. */}
      <span data-tauri-drag-region className="text-xs text-muted-foreground">
        Neoxify
      </span>

      <div className="flex items-center">
        <CaptionButton label="Minimize" onClick={() => void win.minimize()}>
          <line x1="3" y1="8" x2="13" y2="8" />
        </CaptionButton>

        <CaptionButton
          label={maximized ? "Restore" : "Maximize"}
          onClick={() => void win.toggleMaximize()}
        >
          {maximized ? (
            <>
              <rect x="3.5" y="5.5" width="7" height="7" />
              <polyline points="5.5,5.5 5.5,3.5 12.5,3.5 12.5,10.5 10.5,10.5" />
            </>
          ) : (
            <rect x="3.5" y="3.5" width="9" height="9" />
          )}
        </CaptionButton>

        <CaptionButton label="Close" onClick={() => void win.close()} danger>
          <line x1="4" y1="4" x2="12" y2="12" />
          <line x1="12" y1="4" x2="4" y2="12" />
        </CaptionButton>
      </div>
    </div>
  );
}

/** One caption button.
 *
 * `aria-label` rather than a bare glyph: these are icon-only controls,
 * and a screen reader meeting three unlabelled buttons at the top of
 * the window has nothing to say about them.
 *
 * 46px wide because that is what Windows uses, so muscle memory for the
 * close button's position survives the change. No `data-tauri-drag-region`
 * here -- inheriting it would make the buttons drag the window instead of
 * pressing.
 */
function CaptionButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-8 w-[46px] place-items-center text-muted-foreground transition-colors hover:text-foreground ${
        danger ? "hover:bg-red-600 hover:text-white" : "hover:bg-white/10"
      }`}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}
