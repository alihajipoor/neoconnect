import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { RELAY_CALLS, relayAllows } from "./relay-calls";

/** Three copies of one list -- the Rust command's (the client's
 * authority), this mirror, and the backend's -- kept in step by these
 * tests rather than by hand. */

const rust = readFileSync(new URL("../../src-tauri/src/relay_http.rs", import.meta.url), "utf8");
const backend = readFileSync(
  new URL("../../../backend/src/common/relay/relay-allowlist.ts", import.meta.url),
  "utf8",
);

function rustList(name: string): string[] {
  const block = new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(rust);
  if (!block) throw new Error(`${name} not found in relay_http.rs`);
  return [...block[1].matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
}

const UUID = "3f2b8c1e-9a4d-4e6f-8b0a-1c2d3e4f5a6b";

/** The backend's list as `METHOD path`, with `:id` filled in. */
function backendList(): string[] {
  const block = /export const RELAY_ALLOWLIST[^=]*=\s*\[([\s\S]*?)\n\];/.exec(backend);
  if (!block) throw new Error("RELAY_ALLOWLIST not found");
  return [...block[1].matchAll(/\{ method: "(GET|POST)", path: "([^"]+)" \}/g)].map(
    (m) => `${m[1]} ${m[2].replace(":id", UUID)}`,
  );
}

const key = (method: string, path: string) => `${method} ${path}`;

describe("the relay's list of calls", () => {
  it("mirrors relay_http.rs exactly", () => {
    expect([...RELAY_CALLS.POST].sort()).toEqual(rustList("POST_PATHS").sort());
    expect([...RELAY_CALLS.GET].sort()).toEqual(rustList("GET_PATHS").sort());
  });

  it("asks the backend for nothing it would refuse", () => {
    const served = new Set(backendList());
    const ours = [...RELAY_CALLS.POST.map((p) => key("POST", p)), ...RELAY_CALLS.GET.map((p) => key("GET", p))];
    expect(ours.filter((call) => !served.has(call))).toEqual([]);
  });

  it("leaves out only card and crypto checkout from what the backend allows", () => {
    const ours = new Set([
      ...RELAY_CALLS.POST.map((p) => key("POST", p)),
      ...RELAY_CALLS.GET.map((p) => key("GET", p)),
      key("GET", `/customer/subscriptions/${UUID}/routes`),
      key("POST", `/customer/subscriptions/${UUID}/route`),
    ]);
    const missing = backendList().filter((call) => !ours.has(call) && !relayAllows(call.split(" ")[0], call.split(" ")[1]));
    // Checkout through the relay is a later infra item (the payment-only
    // path); attempt reports are not spent from the relay's small budget.
    expect(missing.sort()).toEqual(
      ["POST /client-attempts", "POST /customer/billing/payments", "POST /customer/subscriptions"].sort(),
    );
  });

  it("forwards the install id the backend reads on relay sign-up", () => {
    expect(rust).toMatch(/"x-neoxify-install-id",/);
  });

  it("matches a subscription id only in the shape of a UUID, and nothing approximate", () => {
    expect(relayAllows("GET", `/customer/subscriptions/${UUID}/routes`)).toBe(true);
    expect(relayAllows("POST", `/customer/subscriptions/${UUID}/route`)).toBe(true);
    for (const [method, path] of [
      ["GET", "/customer/subscriptions/not-a-uuid/routes"],
      ["GET", `/customer/subscriptions/${UUID}/routes/x`],
      ["GET", "/health?x=1"],
      ["GET", "/health/"],
      ["POST", "/customer/me"],
      ["DELETE", "/customer/me"],
      ["POST", "/customer/subscriptions"],
      ["POST", "/customer/billing/payments"],
      ["GET", "/customer/gaming-profile"],
      ["POST", "/client-attempts"],
      ["get", "/health"],
    ] as const) {
      expect([method, path, relayAllows(method, path)]).toEqual([method, path, false]);
    }
  });
});

describe("a store build", () => {
  it("carries no voucher path at all, which App Review would read as selling", async () => {
    vi.stubEnv("VITE_DISTRIBUTION", "store");
    vi.resetModules();
    try {
      const store = await import("./relay-calls");
      expect(store.RELAY_CALLS.POST.filter((path) => path.includes("voucher"))).toEqual([]);
      expect(store.relayAllows("POST", "/customer/vouchers/redeem")).toBe(false);
      expect(store.relayAllows("POST", "/customer-auth/relay-register")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});
