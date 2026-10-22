import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { routeDeleteWarning } from "./delete-warning";

const route = { id: "route-1", name: "Iran relay", exitProtocolConfigId: "cfg-exit", protocolUserCount: 37 };

describe("routeDeleteWarning", () => {
  it("says the delete revokes the customers on the route instead of being blocked by them", () => {
    const text = routeDeleteWarning(route);
    expect(text).not.toMatch(/block/i);
    expect(text).toMatch(/do not stop the delete/);
    expect(text).toMatch(/All 37 customer credentials on it are revoked/);
    expect(text).toMatch(/uplink to the exit node is removed/);
  });

  // The revocations are queued commands: a node that is offline gets them
  // when it reconnects, and until then its credentials still work.
  it("does not promise the node acts at once when it may be offline", () => {
    for (const protocolUserCount of [37, 1, undefined]) {
      const text = routeDeleteWarning({ ...route, protocolUserCount });
      expect(text).not.toMatch(/immediately|at once:/);
      expect(text).toMatch(/or when it next connects if it is offline/);
    }
  });

  it("counts one, none, and an unknown number honestly", () => {
    expect(routeDeleteWarning({ ...route, protocolUserCount: 1 })).toMatch(/The 1 customer credential on it is revoked/);
    expect(routeDeleteWarning({ ...route, protocolUserCount: 0 })).toMatch(/No customer credentials are on it/);
    expect(routeDeleteWarning({ ...route, protocolUserCount: undefined })).toMatch(
      /Every customer credential on it is revoked/,
    );
  });

  // There is no trial route any more (2026-10-22): the trial plan's own
  // routes decide, so deleting a route never stops trials.
  it("names the uplink only when there is one, and never a trial route", () => {
    expect(routeDeleteWarning(route)).not.toMatch(/trial/i);
    expect(routeDeleteWarning({ ...route, exitProtocolConfigId: null })).not.toMatch(/uplink/);
  });

  it("is what the routes table shows", () => {
    const table = readFileSync(new URL("./routes-table.tsx", import.meta.url), "utf8");
    expect(table).toContain("description={routeDeleteWarning(route)}");
    expect(table).not.toMatch(/will block deletion/);
  });
});
