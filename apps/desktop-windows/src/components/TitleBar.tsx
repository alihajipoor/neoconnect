import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useI18n } from "../lib/i18n";

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
 * bar. It is a transparent strip over the window rather than a bar above
 * it: the redesigned shell runs its scene to the top edge and keeps the
 * strip in its own top padding, and the screens not yet redesigned are
 * given the same 32px by App.tsx. The buttons stay on the physical right
 * in both languages -- they follow Windows, not the app's language.
 */
export function TitleBar() {
  const { t } = useI18n();
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
    <div data-tauri-drag-region className="nx-tbar">
      <CaptionButton label={t("tb.minimize")} onClick={() => void win.minimize()}>
        <line x1="3" y1="8" x2="13" y2="8" />
      </CaptionButton>

      <CaptionButton label={maximized ? t("tb.restore") : t("tb.maximize")} onClick={() => void win.toggleMaximize()}>
        {maximized ? (
          <>
            <rect x="3.5" y="5.5" width="7" height="7" />
            <polyline points="5.5,5.5 5.5,3.5 12.5,3.5 12.5,10.5 10.5,10.5" />
          </>
        ) : (
          <rect x="3.5" y="3.5" width="9" height="9" />
        )}
      </CaptionButton>

      <CaptionButton label={t("tb.close")} onClick={() => void win.close()} danger>
        <line x1="4" y1="4" x2="12" y2="12" />
        <line x1="12" y1="4" x2="4" y2="12" />
      </CaptionButton>
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
      className={danger ? "x" : undefined}
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
