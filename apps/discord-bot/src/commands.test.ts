import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __testing, definitions } from "./commands.js";
import { BRAND_COLOUR, BRAND_COLOUR_BAD, BRAND_COLOUR_WARN, type BotConfig } from "./config.js";
import type { PublicPlan, StatusSummary } from "./api.js";

const { statusEmbed, plansEmbed, planLine, statusColour } = __testing;

const status = (over: Partial<StatusSummary> = {}): StatusSummary => ({
  nodes: { total: 2, online: 2, offline: 0, stale: 0 },
  routes: { total: 3, enabled: 3 },
  regions: [{ region: "de", online: 2, total: 2 }],
  checkedAt: "2026-08-03T20:00:00.000Z",
  ...over,
});

const plan = (over: Partial<PublicPlan> = {}): PublicPlan => ({
  name: "Pro",
  priceUsd: "9.99",
  durationDays: 30,
  dataCapGb: 100,
  maxDownloadMbps: 200,
  maxUploadMbps: 50,
  maxConcurrentConnections: 3,
  ...over,
});

const config = { websiteUrl: "https://neoxify.net" } as BotConfig;

describe("statusColour", () => {
  it("is brand violet when everything is up", () => {
    assert.equal(statusColour(status()), BRAND_COLOUR);
  });

  it("warns when a node has gone quiet", () => {
    assert.equal(
      statusColour(status({ nodes: { total: 2, online: 1, offline: 0, stale: 1 } })),
      BRAND_COLOUR_WARN,
    );
  });

  it("goes red when nothing is up", () => {
    assert.equal(
      statusColour(status({ nodes: { total: 2, online: 0, offline: 2, stale: 0 } })),
      BRAND_COLOUR_BAD,
    );
  });

  /** No nodes at all is a fresh deployment, not an outage. */
  it("warns rather than alarms on an empty deployment", () => {
    assert.equal(
      statusColour(status({ nodes: { total: 0, online: 0, offline: 0, stale: 0 }, regions: [] })),
      BRAND_COLOUR_WARN,
    );
  });
});

describe("statusEmbed", () => {
  it("answers in the member's language", () => {
    assert.match(statusEmbed(status(), "en").toJSON().description ?? "", /All nodes/);
    assert.match(statusEmbed(status(), "fa").toJSON().description ?? "", /سرورها/);
  });

  it("omits the node field entirely when there are no nodes", () => {
    const json = statusEmbed(
      status({ nodes: { total: 0, online: 0, offline: 0, stale: 0 }, regions: [] }),
      "en",
    ).toJSON();
    assert.ok(!json.fields?.some((f) => f.name === "Nodes"));
    assert.match(json.description ?? "", /No nodes are configured/);
  });

  it("drops the stale and offline counts when they are zero", () => {
    const json = statusEmbed(status(), "en").toJSON();
    const nodes = json.fields?.find((f) => f.name === "Nodes")?.value ?? "";
    assert.equal(nodes, "**2**/2 online");
  });

  it("marks a partially-down region amber and a dead one red", () => {
    const json = statusEmbed(
      status({
        regions: [
          { region: "de", online: 2, total: 2 },
          { region: "nl", online: 1, total: 2 },
          { region: "fr", online: 0, total: 1 },
        ],
      }),
      "en",
    ).toJSON();
    const regions = json.fields?.find((f) => f.name === "Regions")?.value ?? "";
    assert.match(regions, /🟢 de — 2\/2/);
    assert.match(regions, /🟡 nl — 1\/2/);
    assert.match(regions, /🔴 fr — 0\/1/);
  });

  /** Nothing identifying may reach a public channel. */
  it("never mentions an address", () => {
    const json = JSON.stringify(statusEmbed(status(), "en").toJSON());
    assert.doesNotMatch(json, /\d+\.\d+\.\d+\.\d+/);
  });
});

describe("planLine", () => {
  it("reads as price, duration, data, speed, devices", () => {
    assert.equal(
      planLine(plan(), "en"),
      "$9.99 / 30 days · 100 GB data · ↓200 ↑50 Mbps speed · 3 devices",
    );
  });

  it("says unlimited rather than printing a cap of null", () => {
    assert.match(planLine(plan({ dataCapGb: null }), "en"), /Unlimited data/);
  });

  it("omits the speed segment entirely when uncapped", () => {
    const line = planLine(plan({ maxDownloadMbps: null, maxUploadMbps: null }), "en");
    assert.doesNotMatch(line, /Mbps/);
  });

  it("shows only the direction that is capped", () => {
    assert.match(planLine(plan({ maxUploadMbps: null }), "en"), /↓200 Mbps/);
    assert.doesNotMatch(planLine(plan({ maxUploadMbps: null }), "en"), /↑/);
  });

  it("translates the units", () => {
    assert.match(planLine(plan(), "fa"), /روز/);
  });
});

describe("plansEmbed", () => {
  it("says so plainly when nothing is on sale", () => {
    assert.match(plansEmbed([], "en", config).toJSON().description ?? "", /No plans/);
  });

  it("lists each plan as its own field", () => {
    const json = plansEmbed([plan(), plan({ name: "Lite" })], "en", config).toJSON();
    assert.deepEqual(json.fields?.map((f) => f.name), ["Pro", "Lite"]);
  });

  /** Discord rejects an embed with more than 25 fields outright. */
  it("caps at Discord's 25-field limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => plan({ name: `Plan ${i}` }));
    assert.equal(plansEmbed(many, "en", config).toJSON().fields?.length, 25);
  });

  it("points at the website, never the operator panel", () => {
    assert.match(plansEmbed([plan()], "en", config).toJSON().description ?? "", /neoxify\.net/);
  });
});

describe("definitions", () => {
  it("registers the four commands", () => {
    assert.deepEqual(definitions.map((d) => d.name).sort(), ["download", "help", "plans", "status"]);
  });

  /** Discord rejects a command whose description is empty or over 100 chars. */
  it("keeps every description within Discord's limits", () => {
    for (const def of definitions) {
      assert.ok(def.description.length > 0 && def.description.length <= 100, def.name);
      assert.match(def.name, /^[a-z-]{1,32}$/);
    }
  });
});
