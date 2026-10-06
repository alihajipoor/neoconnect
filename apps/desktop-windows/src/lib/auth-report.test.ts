import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";
import { beginAttempt, settleAttempt, type EndpointTrace } from "./endpoint-trace";

/** What sign-in reports, and in particular which addresses an
 * unreachable control plane names. Everything that would touch the
 * network, the store or the challenge solver is stood in for; the
 * classification (`outcomeFromApiError`) and the trace are the real
 * ones. */

/** Stands in for the request. `tried` is what it records on the trace it
 * is handed -- as the real one does, address by address. */
const publicRequest = vi.fn<(trace?: EndpointTrace) => Promise<ApiResult<unknown>>>();
vi.mock("./api", () => ({
  publicRequest: (_path: string, _init: RequestInit, trace?: EndpointTrace) => publicRequest(trace),
  apiRequest: vi.fn(),
}));

const reportAttempt = vi.fn();
vi.mock("./attempts", async (original) => {
  const real = await original<typeof import("./attempts")>();
  return { ...real, reportAttempt: (r: unknown, addendum?: unknown) => reportAttempt(r, addendum) };
});

/** The socket-level probe, stood in for; its own tests are elsewhere,
 * and how its answer joins the report is attempts.test.ts's. */
type Addendum = { apiEndpoint?: string; reason?: string } | undefined;
const probeAddendum = vi.fn<(entries: unknown[]) => Promise<Addendum>>();
vi.mock("./control-plane-probe", () => ({ probeAddendum: (e: unknown[]) => probeAddendum(e) }));

vi.mock("./pow", () => ({ solveChallengeFor: async () => undefined }));
vi.mock("./session", () => ({ setTokens: vi.fn() }));
vi.mock("./session-end", () => ({ endCustomerSession: vi.fn() }));
vi.mock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
vi.mock("./i18n", () => ({ currentLanguage: () => "en" }));
const startSocialSignIn = vi.fn();
vi.mock("./social-auth", () => ({ startSocialSignIn: () => startSocialSignIn() }));

const { login, register, socialSignIn } = await import("./auth");

/** The report is sent fire-and-forget, so wait for it to land. */
async function reported(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalledTimes(1));
  return reportAttempt.mock.calls[0][0] as Record<string, unknown>;
}

const UNREACHABLE = "Could not reach Neoxify. Check your internet connection.";

/** A request that tried two addresses (RFC 2606 names) and got nothing. */
function failsAfterTrying(trace?: EndpointTrace): Promise<ApiResult<unknown>> {
  settleAttempt(beginAttempt(trace, "https://api.example.net/api", 0), "timeout", 8_000);
  settleAttempt(beginAttempt(trace, "https://mirror.example.org:2053/api", 8_000), "net", 8_150);
  return Promise.resolve({ ok: false, error: UNREACHABLE });
}

beforeEach(() => {
  publicRequest.mockReset();
  reportAttempt.mockReset();
  startSocialSignIn.mockReset();
  probeAddendum.mockReset();
  probeAddendum.mockResolvedValue(undefined);
});

describe("sign-in telemetry", () => {
  /** What was actually tried and how each ended -- not the list the
   * client would have tried, which is what this used to send. */
  it("names each address tried and how it failed when the control plane is unreachable", async () => {
    publicRequest.mockImplementation(failsAfterTrying);
    await login("someone@example.com", "pw");
    const report = await reported();
    expect(report.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    expect(report.apiEndpoint).toBe("req: api.example.net=timeout@8000 mirror.example.org:2053=net@150");
  });

  it("does the same for a sign-up", async () => {
    publicRequest.mockImplementation(failsAfterTrying);
    await register("someone@example.com", "pw");
    const report = await reported();
    expect(report.kind).toBe("REGISTER");
    expect(report.apiEndpoint).toContain("api.example.net=timeout@8000");
  });

  /** Nothing dialled is a fact worth stating, and naming addresses that
   * were never tried would be the opposite of one. */
  it("says nothing was dialled when nothing was", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: UNREACHABLE });
    await login("someone@example.com", "pw");
    expect((await reported()).apiEndpoint).toBe("none dialled");
  });

  /** Nothing follows a failed sign-in, so the probe sees the path the
   * request saw. Its answer follows the report rather than holding it
   * back for up to twenty seconds -- a probe that never answers must
   * not keep the report from being made. */
  it("hands the probe on as an addendum without waiting for it", async () => {
    publicRequest.mockImplementation(failsAfterTrying);
    probeAddendum.mockReturnValue(new Promise<Addendum>(() => undefined));
    await login("someone@example.com", "pw");
    const report = await reported();
    expect(report.apiEndpoint).toBe("req: api.example.net=timeout@8000 mirror.example.org:2053=net@150");
    // Asked about exactly the attempts the request made.
    expect(probeAddendum).toHaveBeenCalledTimes(1);
    expect(probeAddendum.mock.calls[0][0]).toHaveLength(2);
    expect(reportAttempt.mock.calls[0][1]).toBeInstanceOf(Promise);
  });

  it("names no addresses for a refusal, which reached the server", async () => {
    publicRequest.mockImplementation((trace) => {
      settleAttempt(beginAttempt(trace, "https://api.example.net/api", 0), "h401", 300);
      return Promise.resolve({ ok: false, error: "Wrong email or password.", status: 401 });
    });
    await login("someone@example.com", "pw");
    const report = await reported();
    expect(report.outcome).toBe("REJECTED");
    expect(report.apiEndpoint).toBeUndefined();
    expect(probeAddendum).not.toHaveBeenCalled();
    expect(reportAttempt.mock.calls[0][1]).toBeUndefined();
  });

  /** A provider that refused never reached publicRequest; there is no
   * trace, and nothing is claimed about addresses. */
  it("claims no addresses for a social sign-in that failed before any request", async () => {
    startSocialSignIn.mockRejectedValue(new Error(UNREACHABLE));
    await socialSignIn("google");
    const report = await reported();
    expect(report.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    expect(report.apiEndpoint).toBeUndefined();
  });
});
