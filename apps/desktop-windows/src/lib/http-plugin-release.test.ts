import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/** The HTTP plugin's own `fetch`, as pnpm installs it -- with the patch in
 * `patches/@tauri-apps__plugin-http@2.5.9.patch` applied -- against a
 * stand-in for the Rust side.
 *
 * Why this exists: the plugin parks every response in the webview's
 * resource table and frees it only when the body is read to its end or
 * cancelled. A response whose status has no body (204, 205, 304) gets a
 * `null` body from the plugin's JS and neither ever happens, so the
 * response -- and with it the HTTP/2 stream and the connection under it
 * -- is never released. The app's attempt flush and its device-slot
 * release both answer 204, and the release is sent on purpose on the bare
 * line after a teardown; on the VM, connections of exactly that shape
 * went on sending keep-alives by the physical adapter for the whole of
 * the next session (116 and 38 frames to the API front in two runs).
 *
 * If a plugin upgrade drops the patch, the first test here fails. */

type Call = { command: string; args: Record<string, unknown> };
const calls: Call[] = [];
let status = 204;
let chunks: number[][] = [];

// Stood in at the bottom of `@tauri-apps/api`, where the real `invoke`
// hands every call to the webview -- not by mocking a module, because the
// plugin is loaded from node_modules as installed and its own import of
// the API is not one a module mock reaches.
vi.stubGlobal("window", {
  __TAURI_INTERNALS__: {
    invoke: async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      switch (command) {
        case "plugin:http|fetch":
          return 7;
        case "plugin:http|fetch_send":
          return { status, statusText: "", url: "https://api.example.test/x", headers: [], rid: 42 };
        case "plugin:http|fetch_read_body":
          // The plugin's framing: a chunk ends in 0, the end of the body is [1].
          return chunks.shift() ?? [1];
        case "plugin:http|fetch_cancel_body":
        case "plugin:http|fetch_cancel":
          return null;
        default:
          throw new Error(`unexpected ${command}`);
      }
    },
  },
});

const { fetch } = await import("@tauri-apps/plugin-http");

afterAll(() => {
  vi.unstubAllGlobals();
});

const cancels = () => calls.filter((c) => c.command === "plugin:http|fetch_cancel_body");

/** Lets the fire-and-forget release land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  calls.length = 0;
  chunks = [];
  status = 204;
});

describe("the HTTP plugin's fetch", () => {
  it("null_body_status_releases_the_response", async () => {
    for (const nullBody of [204, 205, 304]) {
      calls.length = 0;
      status = nullBody;
      const res = await fetch("https://api.example.test/x", { method: "POST", body: "{}" });
      await settle();
      expect(res.status).toBe(nullBody);
      expect(res.body).toBeNull();
      expect(cancels(), `status ${nullBody} left its response parked`).toEqual([
        { command: "plugin:http|fetch_cancel_body", args: { rid: 42 } },
      ]);
    }
  });

  it("does not release a body twice once it was read to the end", async () => {
    status = 200;
    chunks = [[104, 105, 0], [1]];
    const res = await fetch("https://api.example.test/x");
    expect(await res.text()).toBe("hi");
    await settle();
    // Reading to the end is what frees it on the Rust side; a cancel on
    // top would ask to close a resource that is already gone.
    expect(cancels()).toEqual([]);
  });

  it("still releases a body that is cancelled unread", async () => {
    status = 200;
    const res = await fetch("https://api.example.test/x");
    await res.body?.cancel();
    await settle();
    expect(cancels()).toHaveLength(1);
  });
});
