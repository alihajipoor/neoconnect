import { describe, expect, it } from "vitest";

import {
  CURVES,
  DISMISS_PX,
  EXIT_MS,
  FLING_PX_PER_MS,
  FirstViews,
  OpenSnapshot,
  REDUCED_CURVES,
  curve,
  dragOutcome,
  motionReduced,
  nextPresence,
  parseTime,
  revealFrames,
  scrimFor,
  widthMorph,
} from "./motion";
import { stepDirection } from "../components/auth/AuthFrame";

/** The properties a keyframe may move: the compositor's two. */
const COMPOSITOR = new Set(["transform", "opacity", "offset", "easing", "composite"]);
const onlyCompositor = (frames: Keyframe[]) => frames.every((frame) => Object.keys(frame).every((key) => COMPOSITOR.has(key)));

describe("leaving the way it came (usePresence)", () => {
  it("shows at once, keeps a closing element for its exit, and is gone after", () => {
    expect(nextPresence("closed", true)).toBe("open");
    expect(nextPresence("open", false)).toBe("closing");
    expect(nextPresence("closing", false)).toBe("closing");
    expect(nextPresence("closed", false)).toBe("closed");
  });

  it("reopened mid-exit simply stays", () => {
    expect(nextPresence("closing", true)).toBe("open");
  });

  it("waits no longer than the exit token with room to spare", () => {
    expect(EXIT_MS).toBeGreaterThanOrEqual(CURVES.exit.duration);
    expect(EXIT_MS).toBeLessThan(300);
  });

  it("a closing dialog draws what it said open, never its new props", () => {
    // Connected, "Switch to Germany · Stealth?", Switch pressed: the switch
    // request is cleared at once, and the props for the exit would read
    // "Switch to Automatic?" with Cancel in place of Stay connected.
    const held = new OpenSnapshot<{ title: string; stay: string }>();
    expect(held.take(true, { title: "Switch to Germany · Stealth?", stay: "Stay connected" })).toEqual({ title: "Switch to Germany · Stealth?", stay: "Stay connected" });
    expect(held.take(false, { title: "Switch to Automatic?", stay: "Cancel" })).toEqual({ title: "Switch to Germany · Stealth?", stay: "Stay connected" });
    expect(held.take(false, { title: "Sign out ?", stay: "Cancel" }).title).toBe("Switch to Germany · Stealth?");
    // Opened again, it says what it is asked now.
    expect(held.take(true, { title: "Sign out Pixel 7?", stay: "Cancel" }).title).toBe("Sign out Pixel 7?");
  });

  it("one never opened draws what it is given", () => {
    expect(new OpenSnapshot<string>().take(false, "A")).toBe("A");
  });
});

describe("a view's first entrance (useFirstView)", () => {
  it("is claimed once a session: never again on a return, a re-filter or a re-render", () => {
    const views = new FirstViews();
    expect(views.fresh("page:data-settings")).toBe(true);
    expect(views.claim("page:data-settings")).toBe(true);
    expect(views.fresh("page:data-settings")).toBe(false);
    expect(views.claim("page:data-settings")).toBe(false);
    // Another view is its own first.
    expect(views.claim("page:data-activity")).toBe(true);
    views.reset();
    expect(views.fresh("page:data-settings")).toBe(true);
  });
});

describe("the tokens, read in script", () => {
  it("parses the stylesheets' times", () => {
    expect(parseTime("540ms")).toBe(540);
    expect(parseTime(" 0.9s ")).toBe(900);
    expect(parseTime("var(--x)")).toBeNull();
    expect(parseTime("")).toBeNull();
  });

  it("falls back to reduced motion where there is no document to ask", () => {
    expect(motionReduced(undefined)).toBe(true);
    expect(curve("snappy", undefined)).toEqual(REDUCED_CURVES.snappy);
  });

  it("reduced motion's curves are short ease-outs", () => {
    for (const name of Object.keys(REDUCED_CURVES) as (keyof typeof REDUCED_CURVES)[]) {
      expect(REDUCED_CURVES[name].easing).toBe("ease-out");
      expect(REDUCED_CURVES[name].duration).toBeLessThanOrEqual(200);
    }
  });

  it("the defaults are the design system's springs (design-system.md 6.1)", () => {
    expect(CURVES.smooth.duration).toBe(590);
    expect(CURVES.snappy.duration).toBe(540);
    expect(CURVES.press.duration).toBe(300);
    expect(CURVES.morph.duration).toBe(350);
    expect(CURVES.bouncy.duration).toBe(560);
  });
});

describe("opening in place (revealBelow)", () => {
  it("moves by transform and opacity only, the part and what follows by the same amount", () => {
    const { panel, after } = revealFrames(120, true, false);
    expect(onlyCompositor(panel)).toBe(true);
    expect(after && onlyCompositor(after)).toBe(true);
    expect(panel[0].transform).toBe("translateY(-120px)");
    expect(after?.[0].transform).toBe("translateY(-120px)");
    expect(panel[panel.length - 1].transform).toBe("translateY(0)");
  });

  it("closing is the opening reversed", () => {
    const open = revealFrames(80, true, false);
    const close = revealFrames(80, false, false);
    expect(close.panel).toEqual([...open.panel].reverse());
    expect(close.after).toEqual([...(open.after ?? [])].reverse());
  });

  it("under reduced motion only fades: nothing after it moves", () => {
    const { panel, after } = revealFrames(120, true, true);
    expect(after).toBeNull();
    expect(panel).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(panel.some((frame) => "transform" in frame)).toBe(false);
  });
});

describe("a sheet let go of", () => {
  it("closes past 120px or a flick faster than .6px/ms, and springs back otherwise", () => {
    expect(DISMISS_PX).toBe(120);
    expect(FLING_PX_PER_MS).toBe(0.6);
    expect(dragOutcome(121, 2_000)).toBe("close");
    expect(dragOutcome(60, 50)).toBe("close");
    expect(dragOutcome(60, 400)).toBe("stay");
    expect(dragOutcome(0, 10)).toBe("stay");
  });

  it("its scrim thins with it, never below nothing or above full", () => {
    expect(scrimFor(0, 400)).toBe(1);
    expect(scrimFor(200, 400)).toBe(0.5);
    expect(scrimFor(800, 400)).toBe(0);
    expect(scrimFor(10, 0)).toBe(1);
  });
});

describe("the pill's width (ConnectOrb)", () => {
  it("grows by scale from the old width, its label counter-scaled", () => {
    const morph = widthMorph(160, 200, false);
    expect(morph).not.toBeNull();
    expect(onlyCompositor(morph!.box)).toBe(true);
    expect(onlyCompositor(morph!.content)).toBe(true);
    expect(morph!.box[0].transform).toBe("scaleX(0.8000)");
    expect(morph!.content[0].transform).toBe("scaleX(1.2500)");
  });

  it("does nothing under reduced motion, or when nothing visible changes", () => {
    expect(widthMorph(160, 200, true)).toBeNull();
    expect(widthMorph(160, 160.4, false)).toBeNull();
    expect(widthMorph(0, 200, false)).toBeNull();
  });
});

describe("the sign-in steps' direction", () => {
  it("goes forward deeper into a flow and back out of it", () => {
    expect(stepDirection("forgot", "forgot-code")).toBe("forward");
    expect(stepDirection("forgot-code", "forgot-recovered")).toBe("forward");
    expect(stepDirection("forgot-recovery", "forgot")).toBe("back");
    expect(stepDirection("register-recovery", "register")).toBe("back");
    // A step the order does not know arrives forward.
    expect(stepDirection("disclosure", "login")).toBe("forward");
  });
});
