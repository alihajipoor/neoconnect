import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** `onBackendAnswer`: told whenever the backend answers anything this app
 * sends, and never when only a page from in front of it does.
 *
 * What a dashboard on its cached snapshot listens to, so its "Can't reach
 * Neoxify" banner stops the moment that becomes untrue -- on the test VM
 * it stayed up a minute after the device-slot claim (200) and the queued
 * reports (204) had been answered. */

const ENDPOINTS = ["https://a.example", "https://b.example"];

const tauriFetch = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (...args: unknown[]) => tauriFetch(...args),
}));
vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve(ENDPOINTS),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  isKnownBlockPage: () => false,
}));

let api: typeof import("./api");
type BackendAnswer = import("./api").BackendAnswer;

beforeEach(async () => {
  vi.resetModules();
  api = await import("./api");
});

afterEach(() => {
  tauriFetch.mockReset();
});

function answer(status: number, type: string | null, body = ""): Response {
  const headers: Record<string, string> = type === null ? {} : { "content-type": type };
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}

/** Counts the announcements one request makes. */
async function heard(send: () => Promise<unknown>): Promise<number> {
  let count = 0;
  const stop = api.onBackendAnswer(() => {
    count += 1;
  });
  try {
    await send();
  } finally {
    stop();
  }
  return count;
}

describe("what counts as the backend answering", () => {
  it("is told of the backend's JSON", async () => {
    tauriFetch.mockResolvedValue(answer(200, "application/json", JSON.stringify({ ok: true })));
    expect(await heard(() => api.publicRequest("/config"))).toBe(1);
  });

  it("is told of a success with no body: a report delivered, a slot released", async () => {
    tauriFetch.mockResolvedValue(answer(204, null));
    expect(await heard(() => api.publicRequest("/config"))).toBe(1);
  });

  it("is told of the backend's own refusal in JSON, which is still Neoxify answering", async () => {
    tauriFetch.mockResolvedValue(answer(409, "application/json", JSON.stringify({ code: "DEVICE_LIMIT" })));
    expect(await heard(() => api.publicRequest("/config"))).toBe(1);
  });

  it("is not told of a page from in front of the backend", async () => {
    tauriFetch.mockResolvedValue(answer(502, "text/html", "<html>bad gateway</html>"));
    expect(await heard(() => api.publicRequest("/config"))).toBe(0);
  });

  it("is not told of a JSON 401, 403 or 404, which an address that is not the backend gives too", async () => {
    for (const status of [401, 403, 404]) {
      tauriFetch.mockResolvedValue(answer(status, "application/json", JSON.stringify({ message: "no" })));
      expect(await heard(() => api.publicRequest("/config"))).toBe(0);
    }
  });

  it("is not told when nothing answers", async () => {
    tauriFetch.mockRejectedValue(new Error("connection refused"));
    expect(await heard(() => api.publicRequest("/config"))).toBe(0);
  });

  it("stops telling a listener once it has stopped listening", async () => {
    tauriFetch.mockResolvedValue(answer(200, "application/json", "{}"));
    let count = 0;
    const stop = api.onBackendAnswer(() => {
      count += 1;
    });
    await api.publicRequest("/config");
    stop();
    await api.publicRequest("/config");
    expect(count).toBe(1);
  });

  /** A dashboard on its snapshot asks again at once when Neoxify answers
   * something -- but not for its own load's answers, which are reads: a
   * load answered in part would otherwise start the next the moment it
   * failed, with no backoff (offline-retry.ts). */
  it("says whether the request answered was a read", async () => {
    tauriFetch.mockResolvedValue(answer(200, "application/json", JSON.stringify({ ok: true })));
    const told = async (send: () => Promise<unknown>) => {
      const answers: BackendAnswer[] = [];
      const stop = api.onBackendAnswer((a) => answers.push(a));
      try {
        await send();
      } finally {
        stop();
      }
      return answers;
    };
    expect(await told(() => api.publicRequest("/config"))).toEqual([{ read: true }]);
    // A write: the health check its race asks first is a read, and the
    // write itself is not.
    const write = await told(() => api.publicRequest("/customer/vpn/release", { method: "POST", body: "{}" }));
    expect(write[write.length - 1]).toEqual({ read: false });
    expect(write.slice(0, -1).every((a) => a.read)).toBe(true);
    // The token refresh is sent for whatever request needed it, a load's
    // reads included.
    const refresh = await told(() => api.publicRequest("/customer-auth/refresh", { method: "POST", body: "{}" }));
    expect(refresh.every((a) => a.read)).toBe(true);
  });

  it("goes on with the request when a listener throws", async () => {
    tauriFetch.mockResolvedValue(answer(200, "application/json", JSON.stringify({ v: 1 })));
    const stop = api.onBackendAnswer(() => {
      throw new Error("a screen's handler");
    });
    try {
      await expect(api.publicRequest<{ v: number }>("/config")).resolves.toEqual({ ok: true, data: { v: 1 } });
    } finally {
      stop();
    }
  });
});
