import { ConfigService } from "@nestjs/config";

import { AlertingService } from "./alerting.service";

/** The Discord webhook contract is the reason this file exists: Discord reads
 * "content" and rejects a body without it (50006, "Cannot send an empty
 * message"), while Slack reads "text". Sending only one of them silently
 * breaks half the possible destinations, and alert delivery failures are
 * swallowed by design -- so nothing would surface the mistake at runtime. */
describe("AlertingService", () => {
  const configWith = (webhookUrl?: string) =>
    ({ get: () => webhookUrl }) as unknown as ConfigService;

  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it("sends nothing when no webhook is configured", async () => {
    await new AlertingService(configWith(undefined)).send("node-fra-1 is down");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a Discord-compatible body", async () => {
    await new AlertingService(configWith("https://discord.com/api/webhooks/1/x")).send("node-fra-1 is down");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf().content).toBe("node-fra-1 is down");
  });

  it("keeps the Slack field too, so one payload serves both", async () => {
    await new AlertingService(configWith("https://hooks.slack.com/services/x")).send("node-fra-1 is down");

    const body = bodyOf();
    expect(body.text).toBe("node-fra-1 is down");
    expect(body.message).toBe("node-fra-1 is down");
  });

  it("passes context through without displacing the message fields", async () => {
    await new AlertingService(configWith("https://example.test/hook")).send("heartbeat missed", {
      nodeId: "n_1",
      missed: 3,
    });

    const body = bodyOf();
    expect(body).toMatchObject({ content: "heartbeat missed", nodeId: "n_1", missed: 3 });
  });

  it("never throws when delivery fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      new AlertingService(configWith("https://example.test/hook")).send("still fine"),
    ).resolves.toBeUndefined();
  });
});
