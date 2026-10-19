/** How much glass and motion the app draws, set on <html> for the
 * stylesheets to read (theme.css, pearl.css):
 *
 *  - `data-glass`: "full" (24px blur), "lite" (12px) or "flat" (no
 *    backdrop-filter anywhere, solid fills);
 *  - `data-motion`: "reduce" when the OS or the app's own switch asks for
 *    less motion, absent otherwise;
 *  - `data-theme`: "light" or "dark" when the customer has chosen one,
 *    absent to follow the system (the default: Pearl light, Smoked dark).
 *
 * The OS settings win over any choice: reduced transparency forces flat,
 * and reduced motion forces reduce. Settings shows those as "set by
 * Windows" and disables the control (`osSet`). The device heuristics only
 * pick a starting tier for "auto"; none of them is verified on real
 * low-end hardware yet (design-system.md, section 7). */

export type GlassTier = "full" | "lite" | "flat";
export type GlassChoice = GlassTier | "auto";
export type ThemeChoice = "system" | "light" | "dark";

export interface DeviceHints {
  /** `navigator.deviceMemory`, in GB, where the engine reports it. */
  readonly deviceMemory?: number | null;
  /** The WebGL renderer string, where it can be read. */
  readonly renderer?: string | null;
  /** A tier a frame probe on this device already settled on. */
  readonly probed?: GlassTier | null;
}

/** Renderers that draw in software: a live blur there is paid for on the
 * CPU every frame. The VM this project tests on is one of them. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|basic render|microsoft basic|software/i;

/** The tier "auto" starts at on this device. */
export function startingTier(hints: DeviceHints): GlassTier {
  if (hints.probed) return hints.probed;
  if (hints.renderer && SOFTWARE_RENDERER.test(hints.renderer)) return "flat";
  if (typeof hints.deviceMemory === "number" && hints.deviceMemory > 0 && hints.deviceMemory <= 2) return "lite";
  return "full";
}

export interface GlassInput {
  readonly choice: GlassChoice;
  /** The OS asks for reduced transparency. */
  readonly reducedTransparency: boolean;
  readonly hints: DeviceHints;
}

/** The tier drawn, and whether the OS decided it. */
export function glassTier({ choice, reducedTransparency, hints }: GlassInput): { tier: GlassTier; osSet: boolean } {
  if (reducedTransparency) return { tier: "flat", osSet: true };
  return { tier: choice === "auto" ? startingTier(hints) : choice, osSet: false };
}

/** Whether motion is reduced, and whether the OS decided it. `choice` is
 * the app's own switch: null follows the OS. */
export function motionReduced(osReduce: boolean, choice: boolean | null): { reduce: boolean; osSet: boolean } {
  if (osReduce) return { reduce: true, osSet: true };
  return { reduce: choice === true, osSet: false };
}

/** One tier down: what a slow frame probe moves to. */
export function lowerTier(tier: GlassTier): GlassTier {
  return tier === "full" ? "lite" : "flat";
}

/** The 90th percentile of frame gaps, in ms. */
export function p90(gaps: readonly number[]): number {
  if (gaps.length === 0) return 0;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

/** Frames slower than this, at the 90th percentile, cost the device a tier.
 * A first guess: it needs tuning on a real low-end laptop. */
export const SLOW_FRAME_P90_MS = 24;

// --- applying it -----------------------------------------------------------

const PROBE_KEY = "nx.effects.probed";
const GLASS_KEY = "nx.effects.glass";
const MOTION_KEY = "nx.effects.motion";
const THEME_KEY = "nx.effects.theme";

/** Per-device conveniences, so browser storage is enough; every read and
 * write survives storage being unavailable. */
function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Nothing: the choice lasts for this run only.
  }
}

function media(query: string): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

function webglRenderer(): string | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

export interface EffectsState {
  glass: GlassTier;
  glassOsSet: boolean;
  glassChoice: GlassChoice;
  reduceMotion: boolean;
  motionOsSet: boolean;
  motionChoice: boolean | null;
  theme: ThemeChoice;
}

let state: EffectsState | null = null;
let renderer: string | null | undefined;
const listeners = new Set<() => void>();

function compute(): EffectsState {
  const glassChoice = (read(GLASS_KEY) as GlassChoice | null) ?? "auto";
  const motionStored = read(MOTION_KEY);
  const motionChoice = motionStored === "reduce" ? true : motionStored === "full" ? false : null;
  const theme = (read(THEME_KEY) as ThemeChoice | null) ?? "system";
  if (renderer === undefined && glassChoice === "auto") renderer = webglRenderer();
  const nav = typeof navigator !== "undefined" ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  const glass = glassTier({
    choice: glassChoice,
    reducedTransparency: media("(prefers-reduced-transparency: reduce)")?.matches ?? false,
    hints: { deviceMemory: nav?.deviceMemory ?? null, renderer: renderer ?? null, probed: read(PROBE_KEY) as GlassTier | null },
  });
  const motion = motionReduced(media("(prefers-reduced-motion: reduce)")?.matches ?? false, motionChoice);
  return {
    glass: glass.tier,
    glassOsSet: glass.osSet,
    glassChoice,
    reduceMotion: motion.reduce,
    motionOsSet: motion.osSet,
    motionChoice,
    theme,
  };
}

function apply(next: EffectsState): void {
  state = next;
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.glass = next.glass;
  if (next.reduceMotion) root.dataset.motion = "reduce";
  else delete root.dataset.motion;
  if (next.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = next.theme;
  for (const listener of listeners) listener();
}

/** Reads the settings and the OS, sets the attributes, and keeps them in
 * step with the OS. Called once at start; safe to call again. */
export function startEffects(): void {
  apply(compute());
  for (const query of ["(prefers-reduced-transparency: reduce)", "(prefers-reduced-motion: reduce)"]) {
    media(query)?.addEventListener?.("change", () => apply(compute()));
  }
}

export const effects = {
  // Cached, so a reader that asks before anything was applied (a page
  // drawn outside the desktop app) is given the same object each time.
  current: (): EffectsState => state ?? (state = compute()),
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setGlass(choice: GlassChoice): void {
    write(GLASS_KEY, choice === "auto" ? null : choice);
    apply(compute());
  },
  setMotion(choice: boolean | null): void {
    write(MOTION_KEY, choice === null ? null : choice ? "reduce" : "full");
    apply(compute());
  },
  setTheme(choice: ThemeChoice): void {
    write(THEME_KEY, choice === "system" ? null : choice);
    apply(compute());
  },
};

/** Samples 60 frames after the first glass paint and, for "auto" only,
 * drops a tier on this device when they are slow -- remembered, so the
 * probe runs once per device. Never while the window is hidden: a
 * throttled background tab would read as a slow machine. */
export function probeFrames(frames = 60): void {
  if (typeof window === "undefined" || typeof requestAnimationFrame !== "function") return;
  const now = effects.current();
  if (now.glassChoice !== "auto" || now.glass === "flat" || read(PROBE_KEY) !== null) return;
  if (document.visibilityState === "hidden") return;
  const gaps: number[] = [];
  let last = 0;
  const step = (time: number) => {
    if (document.visibilityState === "hidden") return;
    if (last) gaps.push(time - last);
    last = time;
    if (gaps.length < frames) {
      requestAnimationFrame(step);
      return;
    }
    const tier = p90(gaps) > SLOW_FRAME_P90_MS ? lowerTier(now.glass) : now.glass;
    write(PROBE_KEY, tier);
    if (tier !== now.glass) apply(compute());
  };
  requestAnimationFrame(step);
}
