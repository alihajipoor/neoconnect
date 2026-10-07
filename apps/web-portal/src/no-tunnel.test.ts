import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// The portal keeps its session in localStorage (src/shims/plugin-store.ts);
// node has none, so a Map stands in. Hoisted above the imports, which
// read it as they load.
const storage = vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
  return map;
});

import "./no-tunnel";
import { endCustomerSession } from "@shared/lib/session-end";
import { getTokens, setTokens } from "@shared/lib/session";

/** Ending a session in the portal, through the shared code exactly as the
 * portal builds it: vite.config.ts's aliases put the browser shims under
 * the shared modules, so every native call throws as it does in a tab. */
describe("ending a session in the portal", () => {
  it("clears the session at once instead of waiting out a desktop tunnel teardown", async () => {
    await setTokens({ accessToken: "access", refreshToken: "refresh" });
    expect([...storage.keys()].some((k) => k.endsWith(":accessToken"))).toBe(true);

    const started = Date.now();
    const ended = await endCustomerSession();
    const took = Date.now() - started;

    // Was about 10 s (SIGN_OUT_TEARDOWN_MS) and "unconfirmed", with the
    // tokens in localStorage throughout.
    expect(took).toBeLessThan(1000);
    expect(ended).toEqual({ tunnel: "down" });
    expect(await getTokens()).toBeNull();
    expect([...storage.keys()].some((k) => k.endsWith("Token"))).toBe(false);
  });

  it("is installed before the portal renders anything", () => {
    const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const imports = main.split("\n").filter((line) => line.startsWith("import "));
    expect(imports[0]).toBe('import "./no-tunnel";');
  });
});
