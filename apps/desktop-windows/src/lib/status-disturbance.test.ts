import { describe, expect, it, vi } from "vitest";

/** What may have caught a status answer, and so may not stand as a drop.
 *
 * Found by review of the engine-death branch: a Custom-mode change
 * rebuilds the tunnel, taking the Xray adapter down for seconds, and the
 * Custom-mode probe holds the service's owning thread -- either way a
 * status asked meanwhile can say "no tunnel" over a tunnel that is up,
 * and the app would have told the customer their connection was lost.
 */

/** The service's reply to a Custom-mode change, held until the test
 * releases it -- a rebuild in progress. */
let releaseChange: () => void = () => undefined;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) => {
    if (cmd !== "vpn_set_split_tunnel") return Promise.reject(new Error(`unexpected ${cmd}`));
    return new Promise<void>((resolve) => {
      releaseChange = resolve;
    });
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () => Promise.resolve({ get: () => Promise.resolve(null), set: () => Promise.resolve(), save: () => Promise.resolve() }),
}));

const { Disturbances, statusDisturbances, CUSTOM_MODE_CHANGE_CAP_MS, PROBE_CAP_MS } = await import("./status-disturbance");
const { pushSplitTunnel, EMPTY_SPLIT_TUNNEL } = await import("./split-tunnel");

describe("Disturbances", () => {
  it("is quiet when nothing has happened", () => {
    const d = new Disturbances();
    const mark = d.mark();
    expect(d.busy(0)).toBe(false);
    expect(d.since(mark, 0)).toBe(false);
  });

  it("is busy while something runs, and not once it has ended", () => {
    const d = new Disturbances();
    const done = d.begin(10_000, 1_000);
    expect(d.busy(1_500)).toBe(true);
    done();
    expect(d.busy(1_600)).toBe(false);
  });

  it("disturbs an answer whose fetch something began during, even if it has ended", () => {
    // The probe race: the look takes its mark, the health poll starts
    // the probe and it finishes, and then the look's answer arrives.
    // Nothing is running any more, and the answer may still be the
    // fallback's.
    const d = new Disturbances();
    const mark = d.mark();
    const done = d.begin(10_000, 1_000);
    done();
    expect(d.busy(2_000)).toBe(false);
    expect(d.since(mark, 2_000)).toBe(true);
    // A look that begins afterwards is not disturbed by it.
    expect(d.since(d.mark(), 2_000)).toBe(false);
  });

  it("disturbs an answer fetched while something was already running", () => {
    const d = new Disturbances();
    const done = d.begin(10_000, 1_000);
    const mark = d.mark();
    expect(d.since(mark, 1_500)).toBe(true);
    done();
    expect(d.since(mark, 1_600)).toBe(false);
  });

  it("does not let a call that never answers switch the drop check off for good", () => {
    const d = new Disturbances();
    d.begin(PROBE_CAP_MS, 0);
    expect(d.busy(PROBE_CAP_MS - 1)).toBe(true);
    expect(d.busy(PROBE_CAP_MS)).toBe(false);
    expect(d.since(d.mark(), PROBE_CAP_MS)).toBe(false);
  });

  it("counts each of two overlapping things until its own end", () => {
    const d = new Disturbances();
    const first = d.begin(60_000, 0);
    const second = d.begin(60_000, 10);
    first();
    expect(d.busy(20)).toBe(true);
    second();
    expect(d.busy(30)).toBe(false);
  });
});

describe("a Custom-mode change", () => {
  it("is marked from the moment it is sent until the service answers", async () => {
    const mark = statusDisturbances.mark();
    expect(statusDisturbances.busy()).toBe(false);

    const pushed = pushSplitTunnel({ ...EMPTY_SPLIT_TUNNEL, enabled: true });
    expect(statusDisturbances.busy()).toBe(true);
    expect(statusDisturbances.since(mark)).toBe(true);

    releaseChange();
    await pushed;
    expect(statusDisturbances.busy()).toBe(false);
    // Still disturbs an answer fetched across it.
    expect(statusDisturbances.since(mark)).toBe(true);
  });

  it("is believed running for as long as the app would wait for the reply", () => {
    // REPLY_TIMEOUT in src-tauri/src/vpn.rs is 45s; a rebuild runs under
    // the service's 38s connect budget.
    expect(CUSTOM_MODE_CHANGE_CAP_MS).toBeGreaterThanOrEqual(45_000);
  });
});
