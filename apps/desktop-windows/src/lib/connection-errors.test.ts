import { afterEach, describe, expect, it } from "vitest";
import { classifyConnectionError } from "./connection-errors";
import { setDesktopPlatform } from "./desktop-platform";

/** The Linux app's and helper's own sentences, as they reach this sorter.
 *
 * The helper's wording is a contract (the `Problem` Display text in
 * apps/desktop-linux/tunnel/src/lib.rs, and the refusals in
 * apps/desktop-linux/helper/src/server.rs), and so is the Linux app's
 * sentence for a helper it cannot reach (src-tauri/src/vpn.rs). A kind
 * decides more than the words on screen: "serverUnreachable" is recorded
 * as a failed dial against the server, so a local fault sorted there
 * would be blamed on a server nothing asked. Copied here verbatim, with
 * documentation names where they carry a host. */

afterEach(() => setDesktopPlatform("windows"));

const kindOf = (text: string) => classifyConnectionError(text).kind;

describe("the Linux app's sentences for a helper it cannot reach", () => {
  const unreachable = [
    "Could not reach the Neoxify background service (it is not running). Try restarting the app, or reinstalling if this keeps happening.",
    "Could not reach the Neoxify background service (it stopped answering). Try restarting the app, or reinstalling if this keeps happening.",
    "Could not reach the Neoxify background service (it would not let this app in). Try restarting the app, or reinstalling if this keeps happening.",
    "Could not reach the Neoxify background service (its socket could not be opened). Try restarting the app, or reinstalling if this keeps happening.",
    "Could not reach the Neoxify background service (no answer within 10s). Try restarting the app, or reinstalling if this keeps happening.",
    "The Neoxify background service did not answer within 30s. It may be stuck -- restarting the app usually clears it.",
    "could not read the background service's reply: it closed the connection",
  ];

  it("are the service being unavailable, with Linux's advice", () => {
    setDesktopPlatform("linux");
    for (const text of unreachable) {
      const shown = classifyConnectionError(text);
      expect(shown.kind, text).toBe("serviceUnavailable");
      expect(shown.messageKey, text).toBe("err.serviceUnavailableLinux");
      expect(shown.detail, text).toBe(text);
    }
  });

  it("leave Windows' advice as it was", () => {
    const shown = classifyConnectionError(unreachable[0]);
    expect(shown.kind).toBe("serviceUnavailable");
    expect(shown.messageKey).toBe("err.serviceUnavailable");
  });
});

describe("the Linux helper's sentences", () => {
  it("say no network for the shared no-network sentence, never a server", () => {
    setDesktopPlatform("linux");
    expect(kindOf("no network connection with a gateway was found")).toBe("noNetwork");
  });

  it("say part of the install is missing when an engine is", () => {
    setDesktopPlatform("linux");
    for (const what of ["xray", "openvpn", "wg", "the WireGuard kernel module"]) {
      expect(kindOf(`${what} is missing from the install`), what).toBe("engineMissing");
    }
  });

  it("blame the server when it did not finish connecting in time", () => {
    setDesktopPlatform("linux");
    expect(kindOf("timed out waiting for OpenVPN to finish connecting")).toBe("serverUnreachable");
  });

  it("never blame a server for a local step that ran out of time or a config WireGuard did not take", () => {
    setDesktopPlatform("linux");
    for (const text of [
      "Xray did not start in time",
      "OpenVPN did not start in time",
      "the tunnel interface (neoconnect0) did not appear in time",
      "could not create the WireGuard interface (neoxify-wg) in time",
      "could not configure WireGuard in time",
      "could not ask the kernel for a route in time",
      "WireGuard did not accept its configuration: Unable to modify interface: Invalid argument",
      "OpenVPN stopped before the tunnel came up (exit status: 1)",
      "Xray exited immediately (exit status: 23)",
    ]) {
      expect(kindOf(text), text).toBe("unknown");
    }
  });

  it("give what Linux does not have yet as it is, without advice that would not help", () => {
    setDesktopPlatform("linux");
    for (const text of [
      "IKEv2 is not available on Linux yet",
      "Custom mode is not available on Linux yet",
      "Gaming mode is not available on Linux yet",
      "Repair is not available on Linux yet",
      "Diagnostics are not available on Linux yet",
      "Blocking the internet while reconnecting is not available on Linux yet",
    ]) {
      const shown = classifyConnectionError(text);
      expect(shown.kind, text).toBe("unknown");
      expect(shown.detail, text).toBe(text);
    }
  });

  it("never blame a server for a profile the helper could not read", () => {
    setDesktopPlatform("linux");
    for (const text of [
      "the WireGuard endpoint is not host:port",
      "the WireGuard profile has no IPv4 address for the tunnel",
      "the OpenVPN profile's keys are malformed",
      "example.com has no IPv4 address to route around the tunnel",
    ]) {
      expect(kindOf(text), text).toBe("unknown");
    }
  });
});
