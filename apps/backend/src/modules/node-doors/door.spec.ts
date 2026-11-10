import { X509Certificate } from "node:crypto";
import { leaf } from "../../../test/door-certs";
import {
  candidatePorts,
  certificateIsOurs,
  DOOR_FRESH_MS,
  doorDomains,
  doorOf,
  doorPorts,
  doorSni,
  knownNames,
  MAX_CANDIDATE_PORTS,
  nodeDoorsEnabled,
  PREVIOUS_PIN_MS,
  recordSighting,
  sightingChange,
  spkiPin,
} from "./door";

const PIN_A = "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PIN_B = "sha256/BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=";
const PIN_C = "sha256/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA=";
const NOW = Date.parse("2026-11-10T12:00:00Z");

const KNOBS = ["NODE_DOORS", "NODE_DOOR_PORTS", "NODE_DOOR_SNI", "NODE_DOOR_DOMAINS"] as const;
const saved = Object.fromEntries(KNOBS.map((name) => [name, process.env[name]]));
beforeEach(() => {
  for (const name of KNOBS) delete process.env[name];
});
afterAll(() => {
  for (const name of KNOBS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("the pin of a certificate's key", () => {
  // The vector the apps' own pin check is tested against
  // (relay_http.rs, OPENSSL_CERT): a throwaway certificate and the pin
  // openssl prints for it. The same answer here is what lets a client
  // match a pin this backend computed.
  const OPENSSL_CERT =
    "MIIBjjCCATOgAwIBAgIUNtXwxljPP3nsRc8oxNkEqJFjzzAwCgYIKoZIzj0EAwIwHDEaMBgGA1UEAwwRcmVsYXktdGVzdC12ZWN0b3IwHhcNMjYxMDEwMTU0NzI4WhcNMjYxMDExMTU0NzI4WjAcMRowGAYDVQQDDBFyZWxheS10ZXN0LXZlY3RvcjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAtnsaWQkpCObRByRPiHFESBJTs0QkBQHZSyLK6u6Jfl7TRE5c9WzoqcrSQ7Kp5QNNtfBKga2TXpX1PuC3VXXDCjUzBRMB0GA1UdDgQWBBRMIlrvJsovTwBx3kNJdaQ1CwwxWTAfBgNVHSMEGDAWgBRMIlrvJsovTwBx3kNJdaQ1CwwxWTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQCUQsxs+2gDtCzA6pOQoRbm2oHOTUefKZ/h1khgqdxYjgIhAK4Usi8ZjYGdrru602L8VHzg+3t8ZpWjQLa2dB3+XgLs";

  it("is the one the apps compute for the same certificate", () => {
    const cert = new X509Certificate(Buffer.from(OPENSSL_CERT, "base64"));
    expect(spkiPin(cert)).toBe("sha256/3rjtrrC7NzphMMzn3VhX0dR33yywpjyXxQ+bHhx4FFo=");
  });

  it("is of the key, so two certificates for one name differ and a pin is 32 bytes", () => {
    const one = spkiPin(new X509Certificate(leaf({ names: ["fi1.example.test"] }).certPem));
    const other = spkiPin(new X509Certificate(leaf({ names: ["fi1.example.test"] }).certPem));
    expect(one).not.toBe(other);
    expect(one).toMatch(/^sha256\/[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(one.slice("sha256/".length), "base64")).toHaveLength(32);
  });
});

describe("which certificates name a host of ours", () => {
  const cert = (names: string[], commonName?: string) => new X509Certificate(leaf({ names, commonName }).certPem);

  it("takes a name the database records for the node", () => {
    expect(certificateIsOurs(cert(["fi1.example.test"]), ["fi1.example.test"], [])).toBe(true);
  });

  it("takes a wildcard that covers such a name, as a client verifying by name would", () => {
    expect(certificateIsOurs(cert(["*.n.example.test"]), ["fi1.n.example.test"], [])).toBe(true);
    // One label only: a wildcard does not reach a name two levels down.
    expect(certificateIsOurs(cert(["*.example.test"]), ["fi1.n.example.test"], [])).toBe(false);
  });

  it("takes any host under a configured domain, a wildcard included", () => {
    expect(certificateIsOurs(cert(["d7.direct.example.org"]), [], ["example.org"])).toBe(true);
    expect(certificateIsOurs(cert(["*.direct.example.org"]), [], ["example.org"])).toBe(true);
    expect(certificateIsOurs(cert(["example.org"]), [], ["example.org"])).toBe(true);
  });

  it("refuses a name that is somebody else's", () => {
    expect(certificateIsOurs(cert(["www.example.com"]), ["fi1.example.test"], ["example.org"])).toBe(false);
  });

  it("refuses a name that only ends like one of our domains", () => {
    expect(certificateIsOurs(cert(["notexample.org"]), [], ["example.org"])).toBe(false);
    expect(certificateIsOurs(cert(["example.org.attacker.test"]), [], ["example.org"])).toBe(false);
  });

  it("refuses a name that is only in the subject", () => {
    expect(certificateIsOurs(cert([], "fi1.example.test"), ["fi1.example.test"], ["example.test"])).toBe(false);
    expect(certificateIsOurs(cert(["www.example.com"], "fi1.example.test"), ["fi1.example.test"], [])).toBe(false);
  });

  it("reads no name out of one written to look like a list", () => {
    // One name, whose text holds what would be a second entry.
    const forged = cert(["x.example.com, DNS:door.example.org"]);
    expect(certificateIsOurs(forged, ["door.example.org"], ["example.org"])).toBe(false);
  });

  it("refuses everything when nothing is known to be ours", () => {
    expect(certificateIsOurs(cert(["fi1.example.test"]), [], [])).toBe(false);
  });
});

describe("the settings", () => {
  it("is on unless NODE_DOORS says off", () => {
    expect(nodeDoorsEnabled()).toBe(true);
    for (const value of ["", "  ", "on", "true", "of"]) {
      process.env.NODE_DOORS = value;
      expect(nodeDoorsEnabled()).toBe(true);
    }
    for (const value of ["off", " OFF "]) {
      process.env.NODE_DOORS = value;
      expect(nodeDoorsEnabled()).toBe(false);
    }
  });

  it("reads the extra ports, and falls back to the installer's two", () => {
    expect(doorPorts(undefined)).toEqual([2053, 2096]);
    // What Compose passes for an unset value.
    expect(doorPorts("")).toEqual([2053, 2096]);
    expect(doorPorts("8443, 2096,8443")).toEqual([8443, 2096]);
    expect(doorPorts("0,70000,abc,-1,1e3")).toEqual([2053, 2096]);
    process.env.NODE_DOOR_PORTS = "443";
    expect(doorPorts()).toEqual([443]);
  });

  it("reads the server name to send: a host name, none, or the default", () => {
    const fallback = doorSni(undefined);
    expect(fallback).toEqual(expect.any(String));
    expect(doorSni("")).toBe(fallback);
    expect(doorSni(" Static.Example.COM ")).toBe("static.example.com");
    expect(doorSni("none")).toBeNull();
    expect(doorSni("NONE")).toBeNull();
    // Not host names: an address, a URL, a name with a space.
    for (const bad of ["203.0.113.9", "https://example.com", "exa mple.com", "-a.example.com"]) {
      expect(doorSni(bad)).toBe(fallback);
    }
  });

  it("reads our domains, and never a bare top-level one", () => {
    expect(doorDomains(undefined)).toEqual([]);
    expect(doorDomains("")).toEqual([]);
    expect(doorDomains(" Example.ORG, *.n.example.test ,.example.net,example.org")).toEqual([
      "example.org",
      "n.example.test",
      "example.net",
    ]);
    expect(doorDomains("com, org,203.0.113.9, bad domain")).toEqual([]);
  });
});

describe("what a node is asked", () => {
  const tls = (listenPort: number, serverName: string, protocol = "XRAY_VLESS_TLS") => ({
    protocol,
    listenPort,
    security: "TLS",
    publicParamsJson: { serverName },
  });
  const reality = {
    protocol: "XRAY_VLESS_REALITY",
    listenPort: 443,
    security: "REALITY",
    publicParamsJson: { serverName: "www.example.com" },
  };
  const wireguard = { protocol: "WIREGUARD", listenPort: 51820, security: "NONE", publicParamsJson: {} };

  it("tries the node's own TLS inbounds first, lowest first, then the configured ports", () => {
    const configs = [tls(8443, "a.example.test"), wireguard, tls(2083, "a.example.test", "XRAY_TROJAN"), reality];
    expect(candidatePorts({}, configs, [2053, 2096])).toEqual([2083, 8443, 2053, 2096]);
  });

  it("tries the port the door was last verified on before any other", () => {
    expect(candidatePorts({ doorPort: 2096 }, [tls(2053, "a.example.test")], [2053, 2096])).toEqual([2096, 2053]);
  });

  it("never tries a REALITY port for being the node's, and tries only so many", () => {
    expect(candidatePorts({}, [reality], [])).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => tls(3000 + i, "a.example.test"));
    expect(candidatePorts({}, many, [2053])).toHaveLength(MAX_CANDIDATE_PORTS);
  });

  it("knows the node's mirror name, its TLS inbounds' names and its IKEv2 name", () => {
    const configs = [
      tls(2053, "FI1.example.test"),
      tls(2083, "fi1.example.test", "XRAY_TROJAN"),
      { protocol: "IKEV2", listenPort: 500, security: "NONE", publicParamsJson: { endpointHost: "ike.example.test" } },
      wireguard,
    ];
    expect(knownNames({ mirrorHost: "m1.example.org" }, configs)).toEqual([
      "m1.example.org",
      "fi1.example.test",
      "ike.example.test",
    ]);
  });

  it("never counts the site a REALITY inbound imitates as a name of ours", () => {
    expect(knownNames({ mirrorHost: null }, [reality])).toEqual([]);
  });

  it("drops what is not a host name", () => {
    const configs = [
      tls(2053, "203.0.113.9"),
      tls(2054, ""),
      { ...tls(2055, "unused"), publicParamsJson: { serverName: 7 } },
      { ...tls(2056, "unused"), publicParamsJson: null },
      tls(2057, "ok.example.test"),
    ];
    expect(knownNames({ mirrorHost: "  " }, configs)).toEqual(["ok.example.test"]);
  });
});

describe("recording a passing check", () => {
  const now = new Date(NOW);

  it("records a first door with no previous pin", () => {
    const stored = { publicIp: "203.0.113.9" };
    const seen = { port: 2053, sni: "static.example.com", pin: PIN_A };
    expect(recordSighting(stored, seen, now)).toEqual({
      doorPort: 2053,
      doorSni: "static.example.com",
      doorPin: PIN_A,
      doorVerifiedAt: now,
    });
    expect(sightingChange(stored, seen)).toBe("door learned on port 2053");
  });

  it("keeps the previous pin when the key changes", () => {
    const stored = {
      publicIp: "203.0.113.9",
      doorPort: 2053,
      doorSni: null,
      doorPin: PIN_A,
      doorVerifiedAt: new Date(NOW - 900_000),
    };
    const seen = { port: 2053, sni: null, pin: PIN_B };
    expect(recordSighting(stored, seen, now)).toEqual({
      doorPort: 2053,
      doorSni: null,
      doorPin: PIN_B,
      doorVerifiedAt: now,
      doorPreviousPin: PIN_A,
      doorPinChangedAt: now,
    });
    expect(sightingChange(stored, seen)).toBe("door changed: certificate key changed");
  });

  it("leaves the previous pin and its date alone while the key is the same", () => {
    const changedAt = new Date(NOW - 3 * 86_400_000);
    const stored = {
      publicIp: "203.0.113.9",
      doorPort: 2053,
      doorSni: null,
      doorPin: PIN_B,
      doorPreviousPin: PIN_A,
      doorPinChangedAt: changedAt,
    };
    const seen = { port: 2053, sni: null, pin: PIN_B };
    const data = recordSighting(stored, seen, now);
    expect(data).not.toHaveProperty("doorPreviousPin");
    expect(data).not.toHaveProperty("doorPinChangedAt");
    expect(sightingChange(stored, seen)).toBeNull();
  });

  it("swaps the two when the node presents the old key again", () => {
    const stored = { publicIp: "203.0.113.9", doorPort: 2053, doorPin: PIN_B, doorPreviousPin: PIN_A };
    expect(recordSighting(stored, { port: 2053, sni: null, pin: PIN_A }, now)).toMatchObject({
      doorPin: PIN_A,
      doorPreviousPin: PIN_B,
      doorPinChangedAt: now,
    });
  });

  it("says a move to another port", () => {
    const stored = { publicIp: "203.0.113.9", doorPort: 2053, doorSni: null, doorPin: PIN_A };
    expect(sightingChange(stored, { port: 2096, sni: null, pin: PIN_C })).toBe(
      "door changed: port 2053 -> 2096, certificate key changed",
    );
  });
});

describe("the door a client is handed", () => {
  const node = (over: Record<string, unknown> = {}) => ({
    publicIp: "203.0.113.9",
    status: "ONLINE",
    doorPort: 2053,
    doorSni: "static.example.com",
    doorPin: PIN_B,
    doorPreviousPin: null,
    doorPinChangedAt: null,
    doorVerifiedAt: new Date(NOW - 5 * 60_000),
    ...over,
  });

  it("is the address, the port, the pin and the name to send", () => {
    expect(doorOf(node(), NOW)).toEqual({ host: "203.0.113.9", port: 2053, pins: [PIN_B], sni: "static.example.com" });
  });

  it("says null for a door that is reached with no server name", () => {
    expect(doorOf(node({ doorSni: null }), NOW)).toEqual({ host: "203.0.113.9", port: 2053, pins: [PIN_B], sni: null });
  });

  it("carries the previous pin second, for a while after a change of key", () => {
    const changed = { doorPreviousPin: PIN_A, doorPinChangedAt: new Date(NOW - PREVIOUS_PIN_MS + 60_000) };
    expect(doorOf(node(changed), NOW)?.pins).toEqual([PIN_B, PIN_A]);
    const longAgo = { doorPreviousPin: PIN_A, doorPinChangedAt: new Date(NOW - PREVIOUS_PIN_MS - 60_000) };
    expect(doorOf(node(longAgo), NOW)?.pins).toEqual([PIN_B]);
    // A previous pin with no date is not vouched for.
    expect(doorOf(node({ doorPreviousPin: PIN_A }), NOW)?.pins).toEqual([PIN_B]);
  });

  it("is not handed out once its last passing check is too old", () => {
    expect(doorOf(node({ doorVerifiedAt: new Date(NOW - DOOR_FRESH_MS) }), NOW)).toBeDefined();
    expect(doorOf(node({ doorVerifiedAt: new Date(NOW - DOOR_FRESH_MS - 1) }), NOW)).toBeUndefined();
  });

  it("is not handed out for a node with no door, or none verified", () => {
    expect(doorOf({ publicIp: "203.0.113.9", status: "ONLINE" }, NOW)).toBeUndefined();
    expect(doorOf(node({ doorPin: null }), NOW)).toBeUndefined();
    expect(doorOf(node({ doorPort: null }), NOW)).toBeUndefined();
    expect(doorOf(node({ doorVerifiedAt: null }), NOW)).toBeUndefined();
  });

  it("is not handed out for a node that is retired or was never set up", () => {
    expect(doorOf(node({ status: "DISABLED" }), NOW)).toBeUndefined();
    expect(doorOf(node({ status: "PENDING" }), NOW)).toBeUndefined();
    // Its agent being quiet does not close its door.
    expect(doorOf(node({ status: "OFFLINE" }), NOW)).toBeDefined();
  });

  it("is not handed out while doors are switched off", () => {
    process.env.NODE_DOORS = "off";
    expect(doorOf(node(), NOW)).toBeUndefined();
  });
});
