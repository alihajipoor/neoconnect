import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countryCode, countryName, groupByPlace, placeKey, placeLabel, routePlace } from "./route-place";
import { RouteFlag } from "../components/Flag";
import type { RouteOption } from "./types";

type Placed = Pick<RouteOption, "id" | "isRelay" | "location" | "exitLocation">;

function direct(id: string, region: string, nodeName: string): Placed {
  return { id, isRelay: false, location: { region, nodeName }, exitLocation: null };
}

function relay(id: string, exitRegion: string | undefined, nodeName = "ir2"): Placed {
  return {
    id,
    isRelay: true,
    location: { region: "ir-iran", nodeName },
    // `undefined` is a backend from before the field existed.
    ...(exitRegion === undefined ? {} : { exitLocation: { region: exitRegion } }),
  };
}

describe("where a route goes", () => {
  it("reads a relay as Iran to its exit's country", () => {
    expect(routePlace(relay("r", "de-germany"))).toEqual({ entry: "ir-iran", exit: "de-germany" });
  });

  it("reads a direct route as the one place it is dialled and leaves from", () => {
    expect(routePlace(direct("d", "fi-finland", "finland1"))).toEqual({ entry: "fi-finland", exit: null });
  });

  /** An older backend sends no exit, and the app shows the entry as it
   * always did rather than guessing a country. */
  it("falls back to the entry alone when the backend names no exit", () => {
    expect(routePlace(relay("r", undefined))).toEqual({ entry: "ir-iran", exit: null });
  });

  it("ignores an exit on a route that is not relayed", () => {
    const odd = { ...direct("d", "de-germany", "germany-1"), exitLocation: { region: "fr-france" } };
    expect(routePlace(odd).exit).toBeNull();
  });
});

describe("naming the place", () => {
  it("names a relay as entry to exit, in English", () => {
    expect(placeLabel(relay("r", "de-germany"), "en")).toBe("Iran → Germany");
    expect(placeLabel(relay("r", "tr-turkey"), "en")).toBe("Iran → Turkey");
  });

  /** In a right-to-left line the arrow is not mirrored, so the one that
   * points from Iran towards the exit is the leftward one. */
  it("names a relay in Persian with the arrow pointing the way the line reads", () => {
    expect(placeLabel(relay("r", "fr-france"), "fa")).toBe("ایران ← فرانسه");
    expect(placeLabel(relay("r", "fi-finland"), "fa")).toBe("ایران ← فنلاند");
  });

  it("names a direct route by its country", () => {
    expect(placeLabel(direct("d", "sg-singapore", "singapore-1"), "en")).toBe("Singapore");
    expect(placeLabel(direct("d", "de-germany", "germany-1"), "fa")).toBe("آلمان");
  });

  it("names a relay from an older backend by its entry, as before", () => {
    expect(placeLabel(relay("r", undefined), "en")).toBe("Iran");
  });

  /** A node can be added in any country from the installer. A name the
   * app was never taught must not come out as the wrong country or as
   * nothing. */
  it("falls back to the region as written when it cannot name the country", () => {
    expect(countryName("zz-nowhere", "en")).toBe("zz-nowhere");
    expect(countryName("xx-lab", "fa")).toBe("xx-lab");
    expect(countryName("lab", "en")).toBe("lab");
    expect(countryName("", "en")).toBe("");
  });

  it("names every country the app draws a flag for, in both languages", () => {
    for (const code of ["ir", "de", "fr", "fi", "tr", "nl", "sg", "ae", "us", "gb"]) {
      expect(countryName(`${code}-x`, "en")).not.toBe(`${code}-x`);
      expect(countryName(`${code}-x`, "fa")).toMatch(/[؀-ۿ]/);
    }
  });

  it("reads the ISO code off a region slug", () => {
    expect(countryCode("fi-finland")).toBe("fi");
    expect(countryCode(" DE_germany ")).toBe("de");
    expect(countryCode("germany")).toBeNull();
    expect(countryCode(null)).toBeNull();
  });
});

describe("grouping the list by place", () => {
  /** The order the server sends: by route name. Names are free text, so
   * relays to one country need not arrive together -- the older Iran
   * relay's routes interleave France with its default exit. */
  const SERVER_ORDER: Placed[] = [
    relay("ir1-ss", "de-germany", "ir1"),
    relay("ir1-ss-fr", "fr-france", "ir1"),
    relay("ir1-tls", "de-germany", "ir1"),
    relay("ir2-ss-fi", "fi-finland"),
    relay("ir2-ss-fr", "fr-france"),
    relay("ir2-reality-fi", "fi-finland"),
    direct("fi-wg", "fi-finland", "finland1"),
    direct("fi-ss", "fi-finland", "finland1"),
    direct("de-wg", "de-germany", "germany-1"),
  ];

  it("keeps every route to one place together, in the order each place first appears", () => {
    expect(groupByPlace(SERVER_ORDER).map((r) => r.id)).toEqual([
      "ir1-ss",
      "ir1-tls",
      "ir1-ss-fr",
      "ir2-ss-fr",
      "ir2-ss-fi",
      "ir2-reality-fi",
      "fi-wg",
      "fi-ss",
      "de-wg",
    ]);
  });

  it("does not mix a relay to Finland with a direct route in Finland", () => {
    expect(placeKey(relay("r", "fi-finland"))).not.toBe(placeKey(direct("d", "fi-finland", "finland1")));
  });

  it("leaves a list that is already grouped exactly as it was", () => {
    const grouped = groupByPlace(SERVER_ORDER);
    expect(groupByPlace(grouped)).toEqual(grouped);
  });

  it("does not change the list it was given", () => {
    const copy = [...SERVER_ORDER];
    groupByPlace(SERVER_ORDER);
    expect(SERVER_ORDER).toEqual(copy);
  });
});

describe("the route flag", () => {
  it("draws the exit's flag with the entry's as a badge on a relay", () => {
    const html = renderToStaticMarkup(createElement(RouteFlag, { region: "ir-iran", exitRegion: "de-germany", label: "Iran → Germany" }));
    // Two flags: Germany's black band and Iran's green one.
    expect(html.match(/<svg/g)?.length).toBe(2);
    expect(html).toContain("#dd0000");
    expect(html).toContain("#239f40");
    // Read out once, as the journey, rather than as two unrelated flags.
    expect(html).toContain('aria-label="Iran → Germany"');
  });

  it("draws one flag for a direct route", () => {
    const html = renderToStaticMarkup(createElement(RouteFlag, { region: "fi-finland", exitRegion: null }));
    expect(html.match(/<svg/g)?.length).toBe(1);
    expect(html).toContain("#002f6c");
  });
});
