import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PANELS, __testing, normalise } from "./panels.js";
import type { BotConfig } from "./config.js";
import type { PlatformRelease, PublicPlan } from "./api.js";

const { downloadsEmbed, plansEmbed, linksEmbed, planLine, markerFor } = __testing;

const config = {
  websiteUrl: "https://neoxify.net",
  panelUrl: "https://connect.neoxify.com",
} as BotConfig;

const release = (over: Partial<PlatformRelease> = {}): PlatformRelease => ({
  platform: "windows",
  version: "0.8.7",
  url: "https://github.com/x/releases/download/desktop-v0.8.7/Neoxify-Setup.exe",
  publishedAt: "2026-08-04T00:00:00Z",
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

describe("normalise", () => {
  it("strips emoji prefixes so config names match live channels", () => {
    assert.equal(normalise("⬇️・downloads"), "downloads");
    assert.equal(normalise("🎟️・open-a-ticket"), "open-a-ticket");
    assert.equal(normalise("💳・plans"), "plans");
  });
});

describe("downloadsEmbed", () => {
  it("lists a version and a link per platform", () => {
    const json = downloadsEmbed([release(), release({ platform: "android", version: "0.2.1" })], config).toJSON();
    const names = json.fields?.map((f) => f.name) ?? [];
    assert.ok(names.some((n) => n.includes("Windows")));
    assert.ok(names.some((n) => n.includes("Android")));
    assert.match(json.fields?.[0]?.value ?? "", /\*\*v0\.8\.7\*\*/);
    assert.match(json.fields?.[0]?.value ?? "", /\[Download\]\(https:/);
  });

  /** A platform with no release yet is a real answer to "is there an iOS
   *  app". Silence would leave people asking in support. */
  it("names platforms that have no release rather than hiding them", () => {
    const json = downloadsEmbed(
      [release(), release({ platform: "android", version: null, url: null })],
      config,
    ).toJSON();
    const missing = json.fields?.find((f) => f.name === "Not released yet");
    assert.ok(missing, "no 'not released yet' field");
    assert.match(missing.value, /Android/);
  });

  it("falls back to the website when the whole feed is down", () => {
    const json = downloadsEmbed([], config).toJSON();
    assert.match(json.fields?.[0]?.value ?? "", /neoxify\.net/);
  });

  /** The single most important line in the channel. */
  it("always warns against builds from other members", () => {
    for (const releases of [[], [release()]]) {
      assert.match(downloadsEmbed(releases, config).toJSON().description ?? "", /never a build another member/i);
    }
  });
});

describe("planLine", () => {
  it("reads price, duration, data, speed, devices", () => {
    assert.equal(planLine(plan()), "**$9.99** / 30 days · 100 GB · ↓200 ↑50 Mbps · 3 devices");
  });

  it("says unlimited rather than printing null", () => {
    assert.match(planLine(plan({ dataCapGb: null })), /Unlimited data/);
  });

  it("omits the speed segment when uncapped", () => {
    assert.doesNotMatch(planLine(plan({ maxDownloadMbps: null, maxUploadMbps: null })), /Mbps/);
  });
});

describe("plansEmbed", () => {
  it("points at the panel to buy", () => {
    assert.match(plansEmbed([plan()], config).toJSON().description ?? "", /connect\.neoxify\.com/);
  });

  it("says so plainly when nothing is on sale", () => {
    assert.match(plansEmbed([], config).toJSON().description ?? "", /No plans/);
  });

  it("stays within Discord's 25-field limit", () => {
    const many = Array.from({ length: 40 }, (_, i) => plan({ name: `P${i}` }));
    assert.equal(plansEmbed(many, config).toJSON().fields?.length, 25);
  });
});

describe("linksEmbed", () => {
  it("carries both official URLs", () => {
    const json = JSON.stringify(linksEmbed(config).toJSON());
    assert.match(json, /neoxify\.net/);
    assert.match(json, /connect\.neoxify\.com/);
  });

  /** The anti-phishing line is the reason this panel exists at all. */
  it("states that staff never DM first", () => {
    assert.match(JSON.stringify(linksEmbed(config).toJSON()), /never DM you first/i);
  });
});

describe("panel identity", () => {
  /** The bot holds no database. It re-finds its own message by this marker,
   *  so a restart edits the existing panel instead of posting a second one. */
  it("gives every panel a distinct, stable marker", () => {
    const markers = PANELS.map((p) => markerFor(p.id));
    assert.equal(new Set(markers).size, markers.length, "duplicate panel markers");
    for (const m of markers) assert.match(m, /^neoxify-panel:/);
  });

  it("every panel targets a channel name", () => {
    for (const p of PANELS) assert.ok(p.channel.length > 0, `${p.id} has no channel`);
  });
});
