import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MutationResult } from "./api";
import { redactResult, withoutConfigSecrets, withoutRouteSecrets } from "./redact";

const openvpn = {
  id: "cfg-1",
  publicParamsJson: {
    endpoint: "203.0.113.5:1194",
    caCertPem: "CA-CERT",
    caKeyPem: "CA-KEY",
    serverCertPem: "SERVER-CERT",
    serverKeyPem: "SERVER-KEY",
    tlsCryptKey: "TLS-CRYPT",
  },
};

describe("withoutConfigSecrets", () => {
  it("drops OpenVPN's private keys and keeps everything an edit sends back", () => {
    expect(withoutConfigSecrets(openvpn)).toEqual({
      id: "cfg-1",
      publicParamsJson: {
        endpoint: "203.0.113.5:1194",
        caCertPem: "CA-CERT",
        serverCertPem: "SERVER-CERT",
        tlsCryptKey: "TLS-CRYPT",
      },
    });
    // The row it was given is untouched.
    expect(openvpn.publicParamsJson.caKeyPem).toBe("CA-KEY");
  });

  it("leaves other configs alone", () => {
    const reality = { id: "cfg-2", publicParamsJson: { realityPublicKey: "pub" } };
    expect(withoutConfigSecrets(reality)).toEqual(reality);
  });
});

describe("withoutRouteSecrets", () => {
  it("drops the relay's uplink credential", () => {
    expect(withoutRouteSecrets({ id: "r", name: "Iran relay", uplinkCredentialsJson: '{"uuid":"x"}' })).toEqual({
      id: "r",
      name: "Iran relay",
    });
  });
});

describe("redactResult", () => {
  it("redacts a success and passes a failure through", () => {
    expect(redactResult({ ok: true, data: openvpn }, withoutConfigSecrets)).toEqual({
      ok: true,
      data: withoutConfigSecrets(openvpn),
    });
    const failed = { ok: false, error: "no" } as MutationResult<typeof openvpn>;
    expect(redactResult(failed, withoutConfigSecrets)).toEqual({ ok: false, error: "no" });
  });
});

/** Next serialises a client component's props and a server action's
 * return value into what the browser receives. These hold the panel's
 * code to the helpers that take the secrets out. */
describe("what the panel's pages and actions send to the browser", () => {
  const app = fileURLToPath(new URL("../app", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : [];
    });
  const sources = files(app).map((file) => ({ file: path.relative(app, file), text: readFileSync(file, "utf8") }));

  it("reads routes and protocol configs only through fetchRoutes and fetchProtocolConfigs", () => {
    const direct = sources.filter(({ text }) => /apiFetch(List)?<[^>]*>\(\s*["'`]\/(routes|protocol-configs)["'`?]/.test(text));
    expect(direct.map(({ file }) => file)).toEqual([]);
    // And the pages that show them do use the helpers.
    const users = sources.filter(({ text }) => /fetch(Routes|ProtocolConfigs)\(/.test(text)).map(({ file }) => file);
    expect(users.length).toBeGreaterThanOrEqual(5);
  });

  it("redacts every route or protocol config a server action returns", () => {
    const returning = sources.filter(({ text }) => /apiMutate<(ProtocolConfig|Route)>/.test(text));
    expect(returning.length).toBeGreaterThan(0);
    for (const { file, text } of returning) {
      const mutations = text.match(/apiMutate<(ProtocolConfig|Route)>/g) ?? [];
      const redactions = text.match(/redactResult\(/g) ?? [];
      expect({ file, redactions: redactions.length }).toEqual({ file, redactions: mutations.length });
    }
  });
});
