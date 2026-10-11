import { beforeEach, describe, expect, it, vi } from "vitest";

/** `onBackendAnswer` hears the answers that do not go through api.ts.
 *
 * The test VM, after its control-plane fixes: the updater's check was
 * answered by the API's `/updates` endpoints, and the dashboard went on
 * saying "Can't reach Neoxify right now" for 43 seconds, until its next
 * timed retry; through a tunnel, `/health/ip` was answered by the backend,
 * and the banner said it for a second more, until the claim's answer came
 * through api.ts. Neither request went through api.ts, so neither was
 * heard. Addresses here are documentation stand-ins
 * (docs/node-address-hygiene.md). */

const BASE = "https://a.example.test/api";
const NODE = "203.0.113.20";

vi.mock("./api-endpoints", () => ({
  apiEndpoints: () => Promise.resolve([BASE]),
  rememberEndpoint: () => Promise.resolve(),
  rememberedEndpoint: () => Promise.resolve(undefined),
  forgetEndpoint: () => Promise.resolve(),
}));
vi.mock("./endpoint-bundle-store", () => ({
  maybeRefreshBundle: () => Promise.resolve(),
  isKnownBlockPage: () => false,
}));
vi.mock("./network-identity", () => ({ rememberNetwork: () => undefined }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("not registered")) }));
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: () => Promise.reject(new Error("the installed transport is the one under test")),
}));
const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => check() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => Promise.resolve() }));

const { onBackendAnswer } = await import("./api");
const { captureBaselineIp, setHealthIpTransport, verifyEgress } = await import("./egress");
type BackendAnswer = import("./backend-answer").BackendAnswer;

/** What one `/health/ip` request is answered with, or null for none. */
let reply: { status: number; body: unknown; peer?: string } | null = null;

beforeEach(() => {
  reply = null;
  check.mockReset();
  setHealthIpTransport(() => (reply === null ? Promise.reject(new Error("no answer")) : Promise.resolve(reply)));
});

/** Everything announced while `run` ran, as a listener registered through
 * api.ts -- where both dashboards register -- hears it. */
async function heard(run: () => Promise<unknown>): Promise<BackendAnswer[]> {
  const answers: BackendAnswer[] = [];
  const stop = onBackendAnswer((answer) => answers.push(answer));
  try {
    await run();
  } finally {
    stop();
  }
  return answers;
}

describe("the egress check's /health/ip", () => {
  it("is heard as Neoxify answering, and as a health check", async () => {
    reply = { status: 200, body: { ip: "192.0.2.228" }, peer: "198.51.100.7" };
    expect(await heard(() => captureBaselineIp())).toEqual([{ read: false, healthCheck: true }]);
  });

  /** The tunnel's health check: through a tunnel, the node's address. */
  it("is heard from a reading taken while connected", async () => {
    reply = { status: 200, body: { ip: NODE }, peer: "198.51.100.7" };
    expect(await heard(() => verifyEgress(null))).toEqual([{ read: false, healthCheck: true }]);
  });

  /** Neoxify answered, whatever the walk makes of the reading: here a
   * node's address, which is never a baseline. */
  it("is heard when the walk passes the reading over", async () => {
    reply = { status: 200, body: { ip: NODE }, peer: "198.51.100.7" };
    expect(await heard(() => captureBaselineIp({ nodeAddresses: [NODE] }))).toHaveLength(1);
  });

  it("is heard in the backend's own error JSON", async () => {
    reply = { status: 503, body: { statusCode: 503, message: "database unreachable" } };
    expect(await heard(() => verifyEgress(null))).toHaveLength(1);
  });

  it("is not heard from an error page from in front of the backend, which the transport hands over as no body", async () => {
    reply = { status: 502, body: null };
    expect(await heard(() => verifyEgress(null))).toEqual([]);
  });

  /** As for the API's own requests (`DOUBTFUL_STATUSES`): an address that
   * is not the backend has been seen giving these to everything. */
  it("is not heard in a JSON 401, 403 or 404", async () => {
    for (const status of [401, 403, 404]) {
      reply = { status, body: { message: "no" } };
      expect(await heard(() => verifyEgress(null)), String(status)).toEqual([]);
    }
  });

  it("is not heard in JSON that is not an object", async () => {
    reply = { status: 200, body: "ok" };
    expect(await heard(() => verifyEgress(null))).toEqual([]);
  });

  it("is not heard when nothing answers", async () => {
    reply = null;
    expect(await heard(() => verifyEgress(null))).toEqual([]);
  });
});

describe("the updater's check", () => {
  it("is heard as Neoxify answering when it finds no update", async () => {
    vi.resetModules();
    const { checkAndStage } = await import("./updates");
    const { onBackendAnswer: listen } = await import("./api");
    check.mockResolvedValue(null);
    const answers: BackendAnswer[] = [];
    const stop = listen((answer) => answers.push(answer));
    await checkAndStage(() => undefined);
    stop();
    // Never a load's own: kept as a reason to ask again even while one runs.
    expect(answers).toEqual([{ read: false }]);
  });

  it("is heard as Neoxify answering when it finds one", async () => {
    vi.resetModules();
    const { checkAndStage } = await import("./updates");
    const { onBackendAnswer: listen } = await import("./api");
    check.mockResolvedValue({ version: "9.9.9", download: () => Promise.resolve() });
    const answers: BackendAnswer[] = [];
    const stop = listen((answer) => answers.push(answer));
    await checkAndStage(() => undefined);
    stop();
    expect(answers).toHaveLength(1);
  });

  /** No endpoint answered with a release or a 204: a refusal, a page, or
   * nothing at all, which the plugin does not tell apart. */
  it("is not heard when the check fails", async () => {
    vi.resetModules();
    const { checkAndStage } = await import("./updates");
    const { onBackendAnswer: listen } = await import("./api");
    check.mockRejectedValue(new Error("Could not fetch a valid release JSON from the remote"));
    const answers: BackendAnswer[] = [];
    const stop = listen((answer) => answers.push(answer));
    await checkAndStage(() => undefined);
    stop();
    expect(answers).toEqual([]);
  });
});
