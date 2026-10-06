import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Which trigger the resume hook hands its refresh.
 *
 * The refresh's failure report used to describe every run as a connect
 * -- "connecting on cached credentials" -- including the ones fired by a
 * foreground or a returning network, after which nothing connects. The
 * hook is what knows which event it was.
 *
 * No DOM here, so the two React hooks are replaced by their simplest
 * honest versions -- a ref is a box, an effect runs once -- and the
 * document and window are bare event targets. */
vi.mock("react", () => ({
  useRef: <T>(value: T) => ({ current: value }),
  useEffect: (effect: () => void) => void effect(),
}));
vi.mock("./credential-cache", () => ({
  isSnapshotStale: () => true,
  loadSnapshot: async () => null,
}));

const realDocument = (globalThis as { document?: unknown }).document;
const realWindow = (globalThis as { window?: unknown }).window;
const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
const win = new EventTarget();

beforeAll(() => {
  Object.assign(globalThis, { document: doc, window: win });
});
afterAll(() => {
  Object.assign(globalThis, { document: realDocument, window: realWindow });
});

const { useRefreshOnResume } = await import("./resume");

describe("useRefreshOnResume", () => {
  const seen: string[] = [];
  beforeAll(() => {
    useRefreshOnResume(async (trigger) => {
      seen.push(trigger);
    });
  });

  it("calls a returning network 'online'", async () => {
    win.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(seen).toEqual(["online"]));
  });

  it("calls a foreground 'resume', from either event that signals one", async () => {
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(seen).toEqual(["online", "resume"]));
    win.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(seen).toEqual(["online", "resume", "resume"]));
  });
});
