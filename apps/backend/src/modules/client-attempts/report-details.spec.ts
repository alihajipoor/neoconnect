import { DETAILS_MAX_BYTES, keepServiceResults } from "./report-details";
import type { ReportDetailsDto } from "./dto/report-details.dto";
import {
  isServiceCheckHost,
  PREVIOUS_SERVICE_CHECK_TARGETS,
  SERVICE_CHECK_TARGETS,
  serviceCheckTargets,
} from "./service-check-targets";

const result = (host: string, key = "k") => ({ key, host, ok: true, stage: "ok" as const });

describe("keepServiceResults", () => {
  it("stores what was sent, without undefined keys", () => {
    const verdict = keepServiceResults({ device: { model: "Pixel 7", os: undefined }, errorKind: undefined } as ReportDetailsDto);
    expect(verdict.details).toEqual({ device: { model: "Pixel 7" } });
    expect(Object.keys(verdict.details!.device as object)).toEqual(["model"]);
  });

  /** THE BOUNDARY: a modified client cannot make the server keep a result
   * for a site the server did not choose. */
  it("drops a service result whose host is not on the server's list", () => {
    const verdict = keepServiceResults({
      via: "tunnel",
      services: [result("www.google.com", "google"), result("private-site.example.com"), result("WWW.INSTAGRAM.COM.", "instagram")],
    } as ReportDetailsDto);
    expect(verdict.servicesDropped).toBe(1);
    expect((verdict.details!.services as { host: string }[]).map((s) => s.host)).toEqual(["www.google.com", "WWW.INSTAGRAM.COM."]);
  });

  it("removes the key when no result is left, and stores nothing when nothing is left", () => {
    expect(keepServiceResults({ via: "direct", services: [result("example.com")] } as ReportDetailsDto)).toMatchObject({
      details: { via: "direct" },
      servicesDropped: 1,
    });
    expect(keepServiceResults({ services: [result("example.net")] } as ReportDetailsDto)).toEqual({
      details: null,
      dropped: "empty",
      servicesDropped: 1,
    });
    expect(keepServiceResults(undefined).details).toBeNull();
  });

  it(`drops the whole object over ${DETAILS_MAX_BYTES} bytes, and keeps one at the limit`, () => {
    const at = (length: number) => ({ errorKind: "x".repeat(length) }) as ReportDetailsDto;
    const overhead = JSON.stringify({ errorKind: "" }).length;
    expect(keepServiceResults(at(DETAILS_MAX_BYTES - overhead)).details).not.toBeNull();
    expect(keepServiceResults(at(DETAILS_MAX_BYTES - overhead + 1))).toMatchObject({ details: null, dropped: "too-large" });
  });
});

describe("service check targets", () => {
  it("serves the fixed list, version 1, every 24 hours", () => {
    const answer = serviceCheckTargets(undefined);
    expect(answer).toMatchObject({ enabled: true, version: 1, everyHours: 24 });
    expect(answer.targets.map((t) => `${t.key} ${t.host}${t.path}`)).toEqual([
      "instagram www.instagram.com/",
      "instagram_app i.instagram.com/",
      "whatsapp web.whatsapp.com/",
      "whatsapp_media mmg.whatsapp.net/",
      "telegram web.telegram.org/",
      "google www.google.com/generate_204",
      "youtube www.youtube.com/generate_204",
      "x x.com/",
      "control www.cloudflare.com/cdn-cgi/trace",
    ]);
    expect(answer.targets.every((t) => t.label.length > 0)).toBe(true);
  });

  it.each([["off", false], [" OFF ", false], ["", true], ["on", true], ["of", true]])("SERVICE_CHECKS=%j -> enabled %s", (value, enabled) => {
    expect(serviceCheckTargets(value).enabled).toBe(enabled);
  });

  it("allows exactly the hosts on the current and previous lists", () => {
    for (const t of [...SERVICE_CHECK_TARGETS, ...PREVIOUS_SERVICE_CHECK_TARGETS]) expect(isServiceCheckHost(t.host)).toBe(true);
    expect(isServiceCheckHost("example.com")).toBe(false);
    expect(isServiceCheckHost("instagram.com")).toBe(false);
  });
});
