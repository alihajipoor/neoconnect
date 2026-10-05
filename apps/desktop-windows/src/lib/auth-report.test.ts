import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./api";

/** What sign-in reports, and in particular which addresses an
 * unreachable control plane names. Everything that would touch the
 * network, the store or the challenge solver is stood in for; the
 * classification (`outcomeFromApiError`) is the real one. */

const publicRequest = vi.fn<() => Promise<ApiResult<unknown>>>();
vi.mock("./api", () => ({
  publicRequest: () => publicRequest(),
  apiRequest: vi.fn(),
}));

const attemptedEndpoints = vi.fn<() => Promise<string | undefined>>();
vi.mock("./api-endpoints", () => ({ attemptedEndpoints: () => attemptedEndpoints() }));

const reportAttempt = vi.fn();
vi.mock("./attempts", async (original) => {
  const real = await original<typeof import("./attempts")>();
  return { ...real, reportAttempt: (r: unknown) => reportAttempt(r) };
});

vi.mock("./pow", () => ({ solveChallengeFor: async () => undefined }));
vi.mock("./session", () => ({ setTokens: vi.fn() }));
vi.mock("./session-end", () => ({ endCustomerSession: vi.fn() }));
vi.mock("./customer", () => ({ clearGamingProfileCache: vi.fn() }));
vi.mock("./i18n", () => ({ currentLanguage: () => "en" }));
vi.mock("./social-auth", () => ({ startSocialSignIn: vi.fn() }));

const { login } = await import("./auth");

/** The report is sent fire-and-forget, so wait for it to land. */
async function reported(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(reportAttempt).toHaveBeenCalledTimes(1));
  return reportAttempt.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  publicRequest.mockReset();
  attemptedEndpoints.mockReset();
  reportAttempt.mockReset();
  // Hostnames standing in for the real mirror list (RFC 2606).
  attemptedEndpoints.mockResolvedValue("api.example.net,mirror.example.org");
});

describe("sign-in telemetry", () => {
  it("names the addresses that were tried when the control plane is unreachable", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: "Could not reach Neoxify. Check your connection." });
    await login("someone@example.com", "pw");
    const report = await reported();
    expect(report.outcome).toBe("CONTROL_PLANE_UNREACHABLE");
    expect(report.apiEndpoint).toBe("api.example.net,mirror.example.org");
  });

  it("does not look the addresses up for a refusal, which reached the server", async () => {
    publicRequest.mockResolvedValue({ ok: false, error: "Wrong email or password." });
    await login("someone@example.com", "pw");
    const report = await reported();
    expect(report.outcome).toBe("REJECTED");
    expect(report.apiEndpoint).toBeUndefined();
    expect(attemptedEndpoints).not.toHaveBeenCalled();
  });
});
