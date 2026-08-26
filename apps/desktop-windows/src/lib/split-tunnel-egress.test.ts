import { beforeEach, describe, expect, it, vi } from "vitest";

/** What actually reaches the service when the selection is pushed.
 *
 * `egress` is one half of a comparison the service makes by equality
 * against each application's preferred exit. If it never leaves this
 * process, every placement is `unknown` forever -- which is exactly the
 * state per-game exits shipped in, and the reason no picker could be
 * built. So this asserts on the argument object, not on the wrapper.
 */

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return Promise.resolve();
  },
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () => Promise.resolve({ get: () => Promise.resolve(null), set: () => Promise.resolve(), save: () => Promise.resolve() }),
}));

const { pushSplitTunnel } = await import("./split-tunnel");

const RUST_LAUNCHER = String.raw`C:\Steam\steamapps\common\Rust\Rust.exe`;
const RUST_CLIENT = String.raw`C:\Steam\steamapps\common\Rust\RustClient.exe`;
const GERMANY = "aaaaaaaaaaaaaaaaaaaaaa";

const SETTINGS = {
  enabled: true,
  apps: [RUST_LAUNCHER, RUST_CLIENT],
  mode: "onlySelected" as const,
  scopes: [],
  games: [
    { slug: "rust", displayName: "Rust", names: ["Rust.exe", "RustClient.exe"], exit: GERMANY },
  ],
};

describe("pushSplitTunnel", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("names no egress by default, because nothing has been established", () => {
    // Every caller that is not the connect path sends this. It is not a
    // placeholder: the service reports a preference it cannot compare
    // as unknown, which is the truthful answer before a tunnel exists.
    return pushSplitTunnel(SETTINGS).then(() => {
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("vpn_set_split_tunnel");
      expect(calls[0].args.egress).toBeNull();
    });
  });

  it("sends the exit the session actually landed on", () => {
    return pushSplitTunnel(SETTINGS, GERMANY).then(() => {
      expect(calls[0].args.egress).toBe(GERMANY);
      // And the other half of the comparison travels with it, so the
      // two cannot arrive out of step.
      expect(calls[0].args.exits).toEqual([
        { app: RUST_LAUNCHER, exit: GERMANY, group: "rust" },
        { app: RUST_CLIENT, exit: GERMANY, group: "rust" },
      ]);
    });
  });

  it("emits a whole game or none of it, whatever egress is named", () => {
    // The all-or-nothing rule is not conditional on there being a live
    // session. A partial group gets no preference at all: the binary
    // that is not selected is not carried, so when it starts it reaches
    // the game's servers from the customer's own address while its
    // sibling reaches them from the exit -- the two-source-IP split,
    // arriving without any second exit being involved.
    const partial = { ...SETTINGS, apps: [RUST_LAUNCHER] };
    return pushSplitTunnel(partial, GERMANY).then(() => {
      expect(calls[0].args.exits).toEqual([]);
      // Still carried, still named on the wire -- withholding the
      // preference must never withhold the traffic.
      expect(calls[0].args.apps).toEqual([RUST_LAUNCHER]);
      expect(calls[0].args.egress).toBe(GERMANY);
    });
  });
});
