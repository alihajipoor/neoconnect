import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({ load: () => Promise.reject(new Error("no store")) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: () => Promise.reject(new Error("no network")) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no tauri")) }));

const { CheckAndSendCard, CheckResults, SendDiagnostics, previewText } = await import("../screens/Support");
const { I18nProvider } = await import("./i18n");
const { bundleBody } = await import("./diagnostics-bundle");
import type { ServiceCheckAnswer } from "./service-check";

/** The Support screen's connection test and "Send diagnostics" in each
 * state a customer can see. */

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, null, el));

const done = (over: Partial<Extract<ServiceCheckAnswer, { kind: "done" }>> = {}): ServiceCheckAnswer => ({
  kind: "done",
  via: "tunnel",
  version: 1,
  complete: true,
  listed: 2,
  results: [
    { key: "a", host: "a.example.com", label: "Alpha", ok: true, stage: "ok", tlsMs: 20 },
    { key: "b", host: "b.example.com", label: "Beta", ok: false, stage: "tls", error: "handshake failed" },
  ],
  ...over,
});

describe("the connection test's results", () => {
  it("show nothing before a test", () => {
    expect(html(createElement(CheckResults, { answer: null }))).toBe("");
  });

  it("name each service as reachable or not, with a calm line and no timings", () => {
    const out = html(createElement(CheckResults, { answer: done() }));
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
    expect(out).toContain("Reachable");
    expect(out).toContain("Not reachable");
    expect(out).toContain("1 of 2 services could be reached.");
    expect(out).toContain("Tested through the VPN.");
    expect(out).not.toContain("handshake");
    expect(out).not.toMatch(/\d+ ?ms/);
    expect(out).not.toContain("example.com");
  });

  it("say so when everything was reached, and the way it went", () => {
    const answer = done({
      via: "direct",
      results: [{ key: "a", host: "a.example.com", label: "Alpha", ok: true, stage: "ok" }],
      listed: 1,
    });
    const out = html(createElement(CheckResults, { answer }));
    expect(out).toContain("Every service on the list could be reached.");
    expect(out).toContain("Tested without the VPN.");
  });

  it("never claim all reached when some were not tested", () => {
    const answer = done({
      complete: false,
      listed: 3,
      results: [{ key: "a", host: "a.example.com", label: "Alpha", ok: true, stage: "ok" }],
      via: undefined,
    });
    const out = html(createElement(CheckResults, { answer }));
    expect(out).toContain("1 of 3 services could be reached.");
    expect(out).toContain("2 couldn&#x27;t be tested in time.");
    expect(out).not.toContain("Tested through");
  });

  it("say when the test is off or could not start", () => {
    expect(html(createElement(CheckResults, { answer: { kind: "off" } }))).toContain("isn&#x27;t available right now");
    expect(html(createElement(CheckResults, { answer: { kind: "unavailable" } }))).toContain("couldn&#x27;t start");
  });
});

describe("sending diagnostics", () => {
  it("offers a note, a look at what goes, and Send", () => {
    const out = html(createElement(SendDiagnostics, { check: null }));
    expect(out).toContain("Send diagnostics to support");
    expect(out).toContain('maxLength="500"');
    expect(out).toContain("What will be sent");
    expect(out).toContain("<details");
    expect(out).toContain(">Send<");
  });

  it("shows the reference with a copy button once sent", () => {
    const out = html(createElement(SendDiagnostics, { check: null, initial: { kind: "sent", reference: "a1b2c3d4" } }));
    expect(out).toContain("a1b2c3d4");
    expect(out).toContain("Support can find your report with this code.");
    expect(out).toContain("Copy");
    expect(out).not.toContain("<textarea");
  });

  it("says it was not sent, and keeps the form, on failure", () => {
    const out = html(createElement(SendDiagnostics, { check: null, initial: { kind: "failed" } }));
    expect(out).toContain("It wasn&#x27;t sent.");
    expect(out).toContain("<textarea");
  });

  it("is not offered to somebody not signed in", () => {
    // Nobody is signed in until the session says so.
    const out = html(createElement(CheckAndSendCard));
    expect(out).toContain("Connection test");
    expect(out).not.toContain("Send diagnostics to support");
  });

  it("shows exactly the body that is sent", () => {
    const body = bundleBody(
      {
        platform: "windows",
        appVersion: "1.2.3",
        details: { net: { type: "wifi" } },
        platformDiagnostics: "Service: running",
      },
      "  it stopped  ",
    );
    expect(body).toEqual({
      platform: "windows",
      appVersion: "1.2.3",
      note: "it stopped",
      details: { net: { type: "wifi" } },
      platformDiagnostics: "Service: running",
    });
    const shown = previewText(body);
    const { platformDiagnostics: _text, ...facts } = body;
    expect(shown).toBe(`${JSON.stringify(facts, null, 2)}\n\nService: running`);
  });

  it("caps the note at the server's 500", () => {
    expect(bundleBody({ platform: "ios", appVersion: "0.2.1" }, "x".repeat(900)).note).toHaveLength(500);
    expect(bundleBody({ platform: "ios", appVersion: "0.2.1" }, "   ")).not.toHaveProperty("note");
  });
});
