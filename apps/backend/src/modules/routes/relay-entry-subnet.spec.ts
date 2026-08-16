import { entrySubnetCidr } from "./routes.service";

/**
 * A relay entry's client subnet, under either of its two names.
 *
 * WireGuard and OpenVPN configs call it `subnetCidr`. IKEv2 calls it
 * `pool`, because that config was written against strongSwan's own
 * vocabulary rather than its siblings'. Reading only the first name is
 * what kept IKEv2 from ever being a relay entry: route creation threw
 * about a missing `subnetCidr` on a config that was never going to have
 * one, and the message named a field the operator could not find.
 */
describe("a relay entry's subnet, by either name", () => {
  it("reads subnetCidr, as WireGuard and OpenVPN write it", () => {
    expect(entrySubnetCidr({ subnetCidr: "10.66.0.0/24" })).toBe("10.66.0.0/24");
  });

  it("reads pool, as IKEv2 writes it", () => {
    expect(entrySubnetCidr({ pool: "10.68.0.0/24", auth: "eap-mschapv2" })).toBe("10.68.0.0/24");
  });

  it("prefers subnetCidr when a config somehow carries both", () => {
    expect(entrySubnetCidr({ subnetCidr: "10.66.0.0/24", pool: "10.68.0.0/24" })).toBe("10.66.0.0/24");
  });

  it("refuses a config carrying neither rather than returning an empty subnet", () => {
    // An empty subnet reaches the agent as `entrySubnetCidr: ""`, which
    // it rejects -- but only after the Route row exists, leaving a route
    // that looks configured and carries nothing.
    expect(() => entrySubnetCidr({ endpointHost: "ir1.neoxify.site" })).toThrow();
  });
});
