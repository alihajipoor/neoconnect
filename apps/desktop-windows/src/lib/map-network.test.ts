import { describe, expect, it } from "vitest";
import { NO_ROAM, idleWayOut, mapNetwork, tagsCurrent, tunnelWayOut, withoutTags } from "./map-network";

/** After a roam the map does without evidence about the network the device
 * left: this device's history until the network id is read again, the
 * list's per-network tags until a list asked with a newer reading arrives.
 * Until then every light is a steady "not proven" dot. */

const works = { code: "worksOnYourIsp" as const, customers: 12, outOf: 14, windowHours: 24 };

describe("mapNetwork and tagsCurrent", () => {
  it("use what was read while nothing has roamed", () => {
    expect(mapNetwork("gw:aa", NO_ROAM)).toBe("gw:aa");
    expect(tagsCurrent(NO_ROAM)).toBe(true);
  });

  it("drop this device's history and the tags from a roam until each is read again", () => {
    const roamed = { roamedAt: 2_000, idReadAt: 1_000, tagsReadAt: 1_000 };
    expect(mapNetwork("gw:aa", roamed)).toBeNull();
    expect(tagsCurrent(roamed)).toBe(false);
    // The id asked again: the history under it is this network's.
    expect(mapNetwork("gw:bb", { ...roamed, idReadAt: 2_500 })).toBe("gw:bb");
    // A list asked with a reading from before the roam is still the old network's.
    expect(tagsCurrent({ ...roamed, tagsReadAt: 1_900 })).toBe(false);
    expect(tagsCurrent({ ...roamed, tagsReadAt: 2_100 })).toBe(true);
  });

  it("strip the tags without touching anything else", () => {
    const routes = [{ id: "a", ispTag: works }, { id: "b", ispTag: null }, { id: "c" }];
    expect(withoutTags(routes)).toEqual([{ id: "a", ispTag: null }, { id: "b", ispTag: null }, { id: "c" }]);
    expect(withoutTags(routes)[1]).toBe(routes[1]);
  });
});

describe("idleWayOut", () => {
  it("takes the first look as where this stretch began", () => {
    expect(idleWayOut(null, "wifi")).toEqual({ next: "wifi", roamed: false });
  });

  it("is a roam only for another way out", () => {
    expect(idleWayOut("wifi", "wifi")).toEqual({ next: "wifi", roamed: false });
    expect(idleWayOut("wifi", "mobile")).toEqual({ next: "mobile", roamed: true });
  });

  it("learns nothing from no answer or no way out, and compares what comes back with before", () => {
    expect(idleWayOut("wifi", null)).toEqual({ next: "wifi", roamed: false });
    expect(idleWayOut("wifi", "")).toEqual({ next: "wifi", roamed: false });
    expect(idleWayOut("wifi", "wifi").roamed).toBe(false);
    expect(idleWayOut("wifi", "mobile").roamed).toBe(true);
  });
});

describe("tunnelWayOut", () => {
  it("is a move for a recheck onto another way out", () => {
    expect(tunnelWayOut("wifi", "recheck", "mobile")).toBe("moved");
  });

  it("is nothing for the same way out back after a blip, or for no change", () => {
    expect(tunnelWayOut("wifi", "recheck", "wifi")).toBeNull();
    expect(tunnelWayOut("wifi", "same", "wifi")).toBeNull();
    expect(tunnelWayOut(null, "same", "wifi")).toBeNull();
  });

  it("is lost when the way out has gone: the network that comes back is not known to be this one", () => {
    expect(tunnelWayOut("wifi", "lost", "")).toBe("lost");
  });
});
