import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/** Where the motion pass is wired into the screens and the window: pinned
 * at the source, because each of these is a line that a later edit could
 * quietly drop and every test of behaviour would still pass. */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("the first-launch window is shown only once it is sized", () => {
  const lib = read("../../src-tauri/src/lib.rs");
  const fit = read("../../src-tauri/src/window_fit.rs");
  const conf = read("../../src-tauri/tauri.conf.json");

  it("is created hidden, in memory, from the config the app was built with", () => {
    expect(lib).toContain("let mut context = tauri::generate_context!();");
    expect(lib).toContain("window_fit::start_hidden(&mut context.config_mut().app.windows);");
    expect(lib.indexOf("window_fit::start_hidden(")).toBeLessThan(lib.indexOf("tauri::Builder::default()"));
    expect(lib).toContain(".run(context)");
    expect(lib).not.toContain(".run(tauri::generate_context!())");
    expect(fit).toMatch(/pub fn start_hidden\(windows: &mut \[WindowConfig\]\) \{\s*for window in windows\.iter_mut\(\)\.filter\(\|w\| w\.label == MAIN\) \{\s*window\.visible = false;/);
  });

  it("does not touch tauri.conf.json: no `visible` there", () => {
    expect(conf).not.toMatch(/"visible"/);
  });

  it("is sized and placed, then shown -- whatever the sizing did", () => {
    const body = fit.slice(fit.indexOf("pub fn fit_main_window"), fit.indexOf("fn size_main_window"));
    expect(body).toMatch(/size_main_window\(app, &window\);\s*paint_base\(&window\);\s*let _ = window\.show\(\);/);
    const sizing = fit.slice(fit.indexOf("fn size_main_window"), fit.indexOf("/// Keeps the size the window is closed at"));
    expect(sizing).toContain("window.set_size(");
    expect(sizing).toContain("window.set_position(");
    expect(sizing).not.toContain("show()");
  });

  it("is fitted first in setup, so nothing before it can leave the window unshown", () => {
    const setup = lib.slice(lib.indexOf(".setup(|app| {"));
    const firstCall = setup.indexOf("window_fit::fit_main_window(app);");
    expect(firstCall).toBeGreaterThan(0);
    expect(firstCall).toBeLessThan(setup.indexOf("app.deep_link().register"));
    expect(firstCall).toBeLessThan(setup.indexOf("tauri::async_runtime::spawn"));
  });

  it("its first frame, before the page paints, is the theme's base colour, not the webview's white", () => {
    const paint = fit.slice(fit.indexOf("fn paint_base"), fit.indexOf("}", fit.indexOf("set_background_color")) + 1);
    expect(paint).toContain("window.theme()");
    expect(paint).toContain("Ok(tauri::Theme::Dark) => BASE_DARK,");
    expect(paint).toContain("let _ = window.set_background_color(Some(base));");
    // The same colours as theme.css's --base, light and dark.
    const theme = read("../theme.css");
    const hex = (name: "BASE_LIGHT" | "BASE_DARK") => {
      const m = new RegExp(`const ${name}: Color = Color\\(0x(\\w\\w), 0x(\\w\\w), 0x(\\w\\w), 255\\);`).exec(fit);
      expect(m, name).not.toBeNull();
      return `#${m![1]}${m![2]}${m![3]}`;
    };
    const bases = [...theme.matchAll(/--base: (#[0-9a-f]{6});/g)].map((m) => m[1]);
    expect(bases[0]).toBe(hex("BASE_LIGHT"));
    expect(bases.slice(1)).toEqual([hex("BASE_DARK"), hex("BASE_DARK")]);
  });

  it("the single-instance hand-off still shows and focuses it", () => {
    expect(lib).toMatch(/window\.unminimize\(\);\s*let _ = window\.show\(\);\s*let _ = window\.set_focus\(\);/);
  });
});

describe("overlays leave the way they came", () => {
  const overlay = read("../components/overlay.tsx");

  it("every dialog, sheet and menu is kept for its exit, marked closed and inert", () => {
    expect(overlay.match(/usePresence\(open\)/g)?.length).toBe(5);
    expect(overlay.match(/data-state=\{state\}/g)?.length).toBeGreaterThanOrEqual(8);
    expect(overlay).toContain('data-state={closing ? "closed" : "open"}');
    expect(overlay.match(/inert=\{closing \|\| undefined\}/g)?.length).toBe(5);
    expect(overlay).not.toMatch(/if \(!open \|\| typeof document === "undefined"\) return null;/);
  });

  it("both sheets follow the finger, the scrim thinning with them", () => {
    expect(overlay.match(/useSheetDrag\(/g)?.length).toBe(3);
    expect(overlay).toContain("scrimRef.current.style.opacity = String(scrimFor(d.dy, d.h));");
    expect(overlay).toContain('if (dragOutcome(d.dy, elapsed) === "close")');
  });

  it("a closing dialog draws what it said open: its title, sentence, buttons and list", () => {
    expect(overlay).toContain("const held = useOpenSnapshot(open, { title, description, actions, children });");
    expect(overlay).toContain("const held = useOpenSnapshot(open, { title, headActions, search, note, children, foot });");
    expect(overlay).toContain("<h2 id={titleId}>{held.title}</h2>");
    expect(overlay).toContain("<div className=\"nx-actions\">{held.actions}</div>");
    expect(overlay).toContain("<h2 id={titleId}>{shownTitle}</h2>");
    const dialogs = overlay.slice(overlay.indexOf("export function Dialog("), overlay.indexOf("export function BottomSheet("));
    expect(dialogs).not.toContain("<h2 id={titleId}>{title}</h2>");
    expect(dialogs).not.toContain("{children}");
  });

  it("focus goes in without scrolling what is underneath", () => {
    expect(overlay).toContain("preventScroll: true");
  });
});

describe("every change of page or view slides", () => {
  it("the phone hands its screens to the View Transitions API, as the desktop does", () => {
    expect(read("../../../mobile/src/App.tsx")).toMatch(/<ScreenTransition screenKey=\{screen\} viewTransitions>/);
    expect(read("../App.tsx")).toContain("<ScreenTransition screenKey={screen} viewTransitions>");
  });

  it("in-screen views go through swapView: the main page and Locations, Settings' pages, Support, the payment step", () => {
    for (const rel of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      expect(read(rel)).toContain('swapView(() => setViewNow(next), next === "locations" ? "forward" : "back");');
    }
    expect(read("../screens/Settings.tsx")).toContain('swapView(() => setSub(next), next === null ? "back" : "forward")');
    expect(read("../screens/Support.tsx")).toContain('swapView(() => setShown(next), next.kind === "list" ? "back" : "forward")');
    expect(read("../screens/Plans.tsx")).toContain('swapView(() => setStage({ name: "awaiting", payment: payment.data }), "forward");');
  });

  it("the nav pills travel: the sidebar's, the tablet tabs' and the phone's", () => {
    const shell = read("../components/shell/AppShell.tsx");
    expect(shell.match(/item\.id === active \? <span className="nx-tabpill" aria-hidden \/> : null/g)?.length).toBe(2);
    const css = read("../motion.css");
    expect(css).toMatch(/\.nx-nav-pill \{\s*view-transition-name: nxpill;/);
    expect(css).toMatch(/view-transition-name: nxtabpill;/);
    expect(css).toMatch(/view-transition-name: nxmnavpill;/);
  });

  it("the leaving screen of the stylesheet's fallback is really inert", () => {
    const st = read("../components/ScreenTransition.tsx");
    expect(st).not.toMatch(/^\s*inert=""$/m);
    expect(st).toMatch(/aria-hidden="true"\s*inert\s/);
  });
});

describe("first entrances", () => {
  it("each page, the main page, the location list and the usage chart, once a session", () => {
    expect(read("../components/shell/Page.tsx")).toContain("useStagger<HTMLDivElement>(pageKey(rest, className))");
    expect(read("../components/main/MainView.tsx")).toContain('const enter = useFirstView("main");');
    expect(read("../components/LocationList.tsx")).toContain("useFirstView(status ? null : `locations:${variant}`)");
    expect(read("../screens/Activity.tsx")).toContain('const grow = useFirstView("chart:usage");');
  });
});

describe("lists", () => {
  const list = read("../components/LocationList.tsx");

  it("a country opens and closes in place: drawn sliding, laid out once", () => {
    expect(list).toContain("onClick={() => toggle(place, open)}");
    expect(list).toContain("revealBelow(panel, true, { boundary: listRef.current });");
    expect(list).toContain("flushSync(() => setOpen(place.key, false));");
    // The keyboard opens and closes the same way.
    expect(list).toContain("if (forward && !open) toggle(place, false);");
  });

  it("a search or a filter moves the rows that stay and fades the rest", () => {
    expect(list.match(/rememberRows\(\);/g)?.length).toBeGreaterThanOrEqual(5);
    expect(list).toContain("if (before && listRef.current) flipList(listRef.current, before, FLIP_ROWS);");
  });

  it("a disclosure opens the same way", () => {
    expect(read("../components/ui.tsx")).toContain("revealBelow(panel.current, true);");
  });
});

describe("words that change, and the pill", () => {
  it("the ladder's rung and the reconnect's attempt swap; the countdown's second does not", () => {
    const line = read("../components/main/ProgressLine.tsx");
    expect(line).toContain('key={`lad:${step}`} className="nx-swap"');
    expect(line).toContain('key={`auto:${step}`} className="nx-swap"');
    // The key names the attempt, never the seconds.
    const key = line.slice(line.indexOf("key={`rc:"), line.indexOf('className="nx-swap"', line.indexOf("key={`rc:")));
    expect(key).not.toContain("seconds");
  });

  it("the connect pill's width morphs by scale, and its label is added to, not replaced", () => {
    const orb = read("../components/ConnectOrb.tsx");
    expect(orb).toContain("const frames = widthMorph(from, to, motionReduced());");
    expect(orb).toContain('play(child, frames.content, { ...timing, composite: "add" });');
    expect(orb).not.toContain("button.style.width");
  });

  it("copied, done: the check pops and the words swap", () => {
    for (const rel of ["../components/BackupRoute.tsx", "../components/RepairNetwork.tsx", "../screens/Plans.tsx", "../screens/Referrals.tsx", "../screens/Support.tsx"]) {
      const src = read(rel);
      expect(src, rel).toContain("nx-done-in");
      expect(src, rel).toContain('<span key={copied ? "done" : "copy"} className="nx-swap">');
    }
  });
});

describe("loading, and what arrives after it", () => {
  it("skeletons hold the shape of what is being read, beside the words that say so", () => {
    for (const rel of ["../screens/Activity.tsx", "../screens/Plans.tsx", "../screens/StorePlans.tsx", "../screens/Referrals.tsx", "../screens/Support.tsx"]) {
      expect(read(rel), rel).toMatch(/<Skeleton /);
    }
    const ui = read("../components/ui.tsx");
    expect(ui).toMatch(/<div className=\{cn\("nx-skels", className\)\} aria-hidden>/);
  });

  it("the main page's banners leave the way they came", () => {
    for (const rel of ["../screens/Dashboard.tsx", "../../../mobile/src/screens/Dashboard.tsx"]) {
      expect(read(rel).match(/<Presence show=/g)?.length, rel).toBe(3);
    }
  });

  it("the room a leaving banner was given goes back once it is gone, not while it fades", () => {
    // data-banner (the sentence's reserve, the switch, the location card)
    // and the map's alert (the stage, the compact window's band) are held
    // through the banner's exit, on the same timer Presence keeps it by.
    expect(read("./motion.ts")).toMatch(/export function useHeldThroughExit\(on: boolean, ms: number = EXIT_MS\): boolean \{\s*return usePresence\(on, ms\)\.mounted;/);
    const shell = read("../components/shell/AppShell.tsx");
    expect(shell).toContain("const bannerHeld = useHeldThroughExit(Boolean(props.banner));");
    expect(shell).toContain('data-banner={bannerHeld ? "1" : undefined}');
    const map = read("../components/main/WorldMap.tsx");
    expect(map).toContain("const alert = useHeldThroughExit(alertNow);");
    expect(map).toContain('data-alert={host === "stage" && alert ? "1" : undefined}');
  });

  it("a payment that could not start is said beside the button pressed, so nothing above it moves", () => {
    const plans = read("../screens/Plans.tsx");
    expect(plans).toContain("setPayError({ planId: plan.id, text: failureText(created, t) });");
    expect(plans).toContain("setPayError({ planId: plan.id, text: failureText(payment, t) });");
    expect(plans).toContain("{payError?.planId === plan.id ? (");
    expect(plans).not.toContain("setError(failureText(created, t));");
  });

  it("an opened disclosure is brought into view, clear of the column's fade", () => {
    expect(read("../components/ui.tsx")).toContain('panel.current.scrollIntoView?.({ block: "nearest", behavior: motionReduced() ? "auto" : "smooth" });');
    expect(read("../pearl.css")).toMatch(/\.nx-dpanel \{\s*scroll-margin-block: 12px 40px;/);
  });

  it("a sheet is dragged from its handle and its head, where no pan may start", () => {
    expect(read("../pearl.css")).toMatch(/\.nx-sheet \.handle,\s*\.nx-sheet \.nx-sheet-head \{\s*touch-action: none;/);
  });
});
