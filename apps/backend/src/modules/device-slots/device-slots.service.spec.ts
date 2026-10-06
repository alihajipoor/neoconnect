/* eslint-disable @typescript-eslint/require-await -- the stand-ins below
   match the async signatures of the Prisma client they replace. */
import { ConflictException, HttpException, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { DeviceSlotsService, type ClaimResult } from "./device-slots.service";
import { DeviceStateStore } from "./device-state.store";
import { DevicePresence } from "./device-presence";

/** Device slots: the owner's rule, "if someone uses the VPN on their PC,
 * they shouldn't be able to use the VPN on the phone at the same time if
 * the plan limit is 1", as the apps ask for it before connecting.
 *
 * Pinned here: who is let in, what a refused device is told (and that it
 * is never a 401, which the apps treat as "signed out"), what a device
 * taken over learns, and that a device nobody hears from stops holding a
 * slot. Unit tests over an in-memory store; no app has run against it. */

const CUSTOMER = "customer-1";
const SUB = "11111111-1111-4111-8111-111111111111";
const PC = "session-pc";
const PHONE = "session-phone";
const TABLET = "session-tablet";

function build(opts: { limit?: number | null; status?: string; sessions?: Record<string, { revoked?: boolean; label?: string; platform?: string }> } = {}) {
  const sessions: Record<string, { revokedAt: Date | null; label: string | null; platform: string | null }> = {};
  for (const [id, s] of Object.entries(opts.sessions ?? { [PC]: {}, [PHONE]: {}, [TABLET]: {} })) {
    sessions[id] = { revokedAt: s.revoked ? new Date() : null, label: s.label ?? null, platform: s.platform ?? null };
  }
  const subscription = {
    id: SUB,
    customerId: CUSTOMER,
    status: opts.status ?? "ACTIVE",
    plan: { maxConcurrentConnections: opts.limit === undefined ? 1 : opts.limit },
  };
  const prisma = {
    customerSession: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; customerId: string } }) => {
        const s = sessions[where.id];
        return s && where.customerId === CUSTOMER ? { id: where.id, ...s } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string }; data: { label?: string; platform?: string } }) => {
        Object.assign(sessions[where.id], data);
        return { count: 1 };
      }),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => sessions[id]).map((id) => ({ id, revokedAt: sessions[id].revokedAt })),
      ),
    },
    subscription: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; customerId: string } }) =>
        where.id === subscription.id && where.customerId === subscription.customerId ? subscription : null,
      ),
      findMany: jest.fn(async () => [{ id: SUB }]),
    },
    protocolUser: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === "shared-1" ? { id: "shared-1" } : null)),
      findMany: jest.fn(async () => [
        { id: "shared-1", routeId: "r1", sessionId: null, provisionedAt: null },
        { id: "phone-r2", routeId: "r2", sessionId: PHONE, provisionedAt: new Date() },
      ]),
    },
  };
  const store = DeviceStateStore.inMemory();
  const presence = new DevicePresence(store);
  const service = new DeviceSlotsService(prisma as never, store, presence);
  const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  return { service, prisma, presence, sessions, store, subscription, warn };
}

const as = (sessionId?: string) => ({ customerId: CUSTOMER, sessionId });
const windows = { label: null, platform: "windows" as const };
const android = { label: "Pixel 7", platform: "android" as const };

/** The 409 a refused claim throws, as the app receives it. */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ConflictException);
    return (err as ConflictException).getResponse() as {
      statusCode: number;
      code: string;
      message: string;
      limit: number;
      holders: { handle: string; label: string; platform: string; since: string; lastSeen: string }[];
    };
  }
  throw new Error("expected the claim to be refused");
}

describe("DeviceSlotsService", () => {
  const savedMode = process.env.DEVICE_SLOTS;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (savedMode === undefined) delete process.env.DEVICE_SLOTS;
    else process.env.DEVICE_SLOTS = savedMode;
  });

  it("lets the first device in and keeps it in while it renews", async () => {
    const { service } = build();

    const granted = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    expect(granted).toEqual({
      granted: true,
      enforced: true,
      subscriptionId: SUB,
      limit: 1,
      handle: expect.any(String),
      renewEverySec: 60,
      staleAfterSec: 90,
    });

    for (let i = 0; i < 5; i++) {
      await jest.advanceTimersByTimeAsync(60_000);
      await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
    }
  });

  // The owner's scenario, exactly.
  it("refuses the phone while the PC is using the VPN on a plan of one, naming the PC -- with a 409, never a 401", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);

    const body = await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android));

    expect(body).toEqual({
      statusCode: 409,
      code: "DEVICE_LIMIT",
      message: "Your plan allows 1 device at a time.",
      limit: 1,
      holders: [
        { handle: expect.any(String), label: null, platform: "windows", since: expect.any(String), lastSeen: expect.any(String) },
      ],
    });
  });

  it("keeps the slot of a device that claims again, under a new handle", async () => {
    const { service } = build();
    const first = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const second = await service.claim(as(PC), { subscriptionId: SUB }, windows);

    expect(second).toMatchObject({ granted: true, enforced: true });
    expect(second.handle).not.toBe(first.handle);
    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held", handle: second.handle });
    expect((await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android))).holders).toHaveLength(1);
  });

  // A card the phone showed just before the PC claimed again still works.
  it("still takes a device over by the handle it had before it claimed again", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const shown = (await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android))).holders[0].handle;
    await service.claim(as(PC), { subscriptionId: SUB }, windows);

    await expect(service.claim(as(PHONE), { subscriptionId: SUB, takeover: [shown] }, android)).resolves.toMatchObject({
      granted: true,
    });
  });

  /** Disconnect, then Connect at once (to change server): the release is
   * fire-and-forget and can arrive after the new claim. Without a handle
   * it freed the slot the PC was now using -- the phone was let in with
   * no card, and the PC, connected first, was told it had been
   * displaced. */
  it("ignores a release that arrives after the same device has claimed again", async () => {
    const { service } = build();
    const before = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const after = await service.claim(as(PC), { subscriptionId: SUB }, windows);

    await service.release(as(PC), { subscriptionId: SUB, handle: before.handle! });
    await service.release(as(PC), { handle: before.handle! });

    await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android));
    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held", handle: after.handle });
  });

  it("releases the slot a release names by its current handle, and any slot when it names none", async () => {
    const named = build();
    const grant = await named.service.claim(as(PC), { subscriptionId: SUB }, windows);
    await named.service.release(as(PC), { subscriptionId: SUB, handle: grant.handle! });
    await expect(named.service.claim(as(PHONE), { subscriptionId: SUB }, android)).resolves.toMatchObject({ granted: true });

    const unnamed = build();
    await unnamed.service.claim(as(PC), { subscriptionId: SUB }, windows);
    await unnamed.service.claim(as(PC), { subscriptionId: SUB }, windows);
    await unnamed.service.release(as(PC), { subscriptionId: SUB });
    await expect(unnamed.service.claim(as(PHONE), { subscriptionId: SUB }, android)).resolves.toMatchObject({ granted: true });
  });

  /** "Use on this device instead": the phone takes the slot, and the PC
   * learns why on its next renewal -- and by whom. */
  it("lets a refused device take the slot over, and tells the device taken over who has it", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const { holders } = await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android));

    const granted = await service.claim(as(PHONE), { subscriptionId: SUB, takeover: [holders[0].handle] }, android);
    expect(granted.granted).toBe(true);

    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toEqual({
      status: "displaced",
      subscriptionId: SUB,
      limit: 1,
      by: { handle: granted.handle, label: "Pixel 7", platform: "android" },
      at: expect.any(String),
    });
  });

  /** A takeover is said only while it is true. The record lasts an hour,
   * and used to be answered for all of it: a renewal disconnected the PC
   * under a card naming the phone after the phone had gone, with the
   * slot free. */
  describe("a device taken over, once the device that took its place has left", () => {
    async function takenOver(limit = 1) {
      const built = build({ limit });
      await built.service.claim(as(PC), { subscriptionId: SUB }, windows);
      const { holders } = await refusal(built.service.claim(as(PHONE), { subscriptionId: SUB }, android));
      await built.service.claim(as(PHONE), { subscriptionId: SUB, takeover: [holders[0].handle] }, android);
      return built;
    }

    type Built = ReturnType<typeof build>;
    const leaving: [string, (built: Built) => Promise<unknown>][] = [
      ["disconnected", ({ service }) => service.release(as(PHONE), { subscriptionId: SUB })],
      [
        "been signed out",
        async ({ sessions }) => {
          sessions[PHONE].revokedAt = new Date();
        },
      ],
      // Neither renewed nor carried traffic for longer than staleAfterSec.
      ["gone quiet", () => jest.advanceTimersByTimeAsync(91_000)],
    ];

    it.each(leaving)("gets its slot back on renewal when that device has %s", async (_how, leave) => {
      const built = await takenOver();
      await leave(built);

      const renewed = await built.service.renew(as(PC), { subscriptionId: SUB });
      expect(renewed).toMatchObject({ status: "held", enforced: true, handle: expect.any(String) });
      // The record is over, for the backstop as well.
      expect((await built.service.state(SUB)).displaced.has(`s:${PC}`)).toBe(false);
      await expect(built.service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
    });

    it("names the device that holds the slot now, not the one that left", async () => {
      const built = await takenOver();
      await built.service.release(as(PHONE), { subscriptionId: SUB });
      const tablet = await built.service.claim(as(TABLET), { subscriptionId: SUB }, { label: "iPad Air", platform: "ios" });

      await expect(built.service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({
        status: "displaced",
        by: { handle: tablet.handle, label: "iPad Air", platform: "ios" },
      });
      // Still taken over, as far as the backstop is concerned.
      expect((await built.service.state(SUB)).displaced.has(`s:${PC}`)).toBe(true);
    });

    /** On a plan of two the device that took over can still be there
     * while a slot frees up beside it: there is room, so nothing is
     * taken from anyone by giving it back. */
    it("gets its slot back when there is room, even with the device that took its place still there", async () => {
      const built = build({ limit: 2 });
      await built.service.claim(as(PC), { subscriptionId: SUB }, windows);
      await built.service.claim(as(PHONE), { subscriptionId: SUB }, android);
      const { holders } = await refusal(built.service.claim(as(TABLET), { subscriptionId: SUB }));
      const pc = holders.find((h) => h.platform === "windows")!;
      await built.service.claim(as(TABLET), { subscriptionId: SUB, takeover: [pc.handle] });
      await expect(built.service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "displaced" });

      await built.service.release(as(PHONE), { subscriptionId: SUB });

      await expect(built.service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
    });

    /** Written before records named the session that took over: matched
     * by the handle they do name. */
    it("still reads a record from before it named the session", async () => {
      const { service, store } = build();
      const phone = await service.claim(as(PHONE), { subscriptionId: SUB }, android);
      await store.hset(
        `slots-displaced:${SUB}`,
        {
          [PC]: JSON.stringify({
            by: { handle: phone.handle, label: "Pixel 7", platform: "android" },
            at: Date.now(),
            noGrace: false,
          }),
        },
        60 * 60_000,
      );

      await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({
        status: "displaced",
        by: { handle: phone.handle, label: "Pixel 7" },
      });
      await service.release(as(PHONE), { subscriptionId: SUB });
      await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
    });
  });

  it("refuses a takeover naming a handle that is no longer there, rather than taking anyone's slot", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);

    const body = await refusal(service.claim(as(PHONE), { subscriptionId: SUB, takeover: ["not-a-holder"] }, android));
    expect(body.code).toBe("DEVICE_LIMIT");
  });

  /** Taking it back is a tap away, and the record of who took over whom
   * is what lets the backstop deny grace to a pair riding grace periods. */
  it("lets the device taken over take the slot back, and marks the phone as having just taken over", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const pcHandle = (await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android))).holders[0].handle;
    const phone = await service.claim(as(PHONE), { subscriptionId: SUB, takeover: [pcHandle] }, android);

    await jest.advanceTimersByTimeAsync(30_000);
    const back = await service.claim(as(PC), { subscriptionId: SUB, takeover: [phone.handle!] }, windows);
    expect(back.granted).toBe(true);

    const state = await service.state(SUB);
    expect([...state.holders]).toEqual([`s:${PC}`]);
    expect(state.displaced.get(`s:${PHONE}`)).toEqual({ at: expect.any(Number), noGrace: true });
  });

  /** A device that stops renewing and stops carrying traffic -- crashed,
   * lost its network, left at home switched off -- must not lock the
   * customer out on another device until someone goes home. */
  it("grants a claim against a holder nobody has heard from for 90 s, without asking", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);

    await jest.advanceTimersByTimeAsync(91_000);
    const granted = await service.claim(as(PHONE), { subscriptionId: SUB }, android);

    expect(granted.granted).toBe(true);
    // The PC comes back to a slot that is taken: it is told by whom.
    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({
      status: "displaced",
      by: { label: "Pixel 7" },
    });
  });

  /** A phone in the background cannot renew, but its tunnel's keepalives
   * show it is in use. That keeps its slot. */
  it("keeps the slot of a holder that has stopped renewing while it carries traffic", async () => {
    const { service, presence } = build();
    await service.claim(as(PHONE), { subscriptionId: SUB }, android);

    await jest.advanceTimersByTimeAsync(80_000);
    await presence.record(SUB, [{ protocolUserId: "phone-r2", deviceKey: `s:${PHONE}`, nodeId: "node-1" }]);
    await jest.advanceTimersByTimeAsync(20_000);

    const body = await refusal(service.claim(as(PC), { subscriptionId: SUB }, windows));
    expect(body.holders[0].label).toBe("Pixel 7");
  });

  // During the transition a device may connect with a shared credential;
  // naming it in the claim makes that credential's traffic the device's.
  it("counts traffic on a shared credential the holder named as the holder's", async () => {
    const { service, presence } = build();
    await service.claim(as(PHONE), { subscriptionId: SUB, protocolUserId: "shared-1" }, android);

    await jest.advanceTimersByTimeAsync(80_000);
    await presence.record(SUB, [{ protocolUserId: "shared-1", deviceKey: "shared", nodeId: "node-1" }]);
    await jest.advanceTimersByTimeAsync(20_000);

    await refusal(service.claim(as(PC), { subscriptionId: SUB }, windows));
    expect((await service.state(SUB)).credit.get("shared-1")).toBe(`s:${PHONE}`);
  });

  it("gives the slot to the next device once the holder releases it", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);

    await service.release(as(PC), { subscriptionId: SUB });

    await expect(service.claim(as(PHONE), { subscriptionId: SUB }, android)).resolves.toMatchObject({ granted: true });
  });

  it.each([
    ["sign-out", (s: DeviceSlotsService) => s.releaseSession(CUSTOMER, PC)],
    ["a password change ending the other sessions", (s: DeviceSlotsService) => s.releaseOtherSessions(CUSTOMER, PHONE)],
    ["a suspension", (s: DeviceSlotsService) => s.releaseSubscription(SUB)],
    ["deleting the account", (s: DeviceSlotsService) => s.releaseCustomer(CUSTOMER)],
  ])("frees the slot on %s", async (_label, release) => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);

    await release(service);

    await expect(service.claim(as(PHONE), { subscriptionId: SUB }, android)).resolves.toMatchObject({ granted: true });
  });

  /** A path that signs devices out without releasing their slots -- an
   * admin setting the password, the hourly sweep, a release that failed
   * -- must not leave the customer refused in favour of a device that
   * can no longer connect at all. */
  it("does not count a holder whose device has been signed out, and does not shield it from the backstop", async () => {
    const { service, sessions } = build();
    await service.claim(as(PC), { subscriptionId: SUB, protocolUserId: "shared-1" }, windows);
    sessions[PC].revokedAt = new Date();

    expect(await service.state(SUB)).toMatchObject({ holders: new Set(), live: new Set(), credit: new Map() });
    await expect(service.claim(as(PHONE), { subscriptionId: SUB }, android)).resolves.toMatchObject({ granted: true });
    expect([...(await service.state(SUB)).holders]).toEqual([`s:${PHONE}`]);
  });

  it("lets as many devices in as the plan allows, and refuses the next", async () => {
    const { service } = build({ limit: 2 });
    await service.claim(as(PC), { subscriptionId: SUB }, windows);
    await service.claim(as(PHONE), { subscriptionId: SUB }, android);

    const body = await refusal(service.claim(as(TABLET), { subscriptionId: SUB }));
    expect(body.message).toBe("Your plan allows 2 devices at a time.");
    expect(body.holders).toHaveLength(2);
  });

  /** On a plan of two the refusal shows two devices; taking over must free
   * one slot, not both. With every handle named, the device least
   * recently seen goes. */
  it("takes over only as many devices as it needs to, the least recently seen first", async () => {
    const { service } = build({ limit: 2 });
    const pc = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    await jest.advanceTimersByTimeAsync(30_000);
    const phone = await service.claim(as(PHONE), { subscriptionId: SUB }, android);
    await jest.advanceTimersByTimeAsync(10_000);
    await service.renew(as(PHONE), { subscriptionId: SUB });

    await service.claim(as(TABLET), { subscriptionId: SUB, takeover: [pc.handle!, phone.handle!] });

    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "displaced" });
    await expect(service.renew(as(PHONE), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
  });

  // Somebody left between the refusal and the tap: there is room now.
  it("displaces nobody when a takeover is no longer needed", async () => {
    const { service } = build({ limit: 2 });
    const pc = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    await service.claim(as(PHONE), { subscriptionId: SUB }, android);
    await service.release(as(PHONE), { subscriptionId: SUB });

    await service.claim(as(TABLET), { subscriptionId: SUB, takeover: [pc.handle!] });

    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held" });
  });

  // Two devices pressing Connect at the same moment.
  it("lets exactly one of two simultaneous claims in on a plan of one", async () => {
    const { service } = build();

    const results = await Promise.allSettled([
      service.claim(as(PC), { subscriptionId: SUB }, windows),
      service.claim(as(PHONE), { subscriptionId: SUB }, android),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it.each([
    ["DEVICE_SLOTS=off", { env: "off", limit: 1 }],
    ["an unlimited plan", { env: undefined, limit: null }],
  ])("grants every claim, recording nothing, for %s", async (_label, { env, limit }) => {
    if (env) process.env.DEVICE_SLOTS = env;
    const { service } = build({ limit });

    const first = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const second = await service.claim(as(PHONE), { subscriptionId: SUB }, android);

    expect([first, second].map((r: ClaimResult) => [r.granted, r.enforced, r.handle])).toEqual([
      [true, false, null],
      [true, false, null],
    ]);
    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held", enforced: false });
  });

  // An access token from before sessions names no device to hold a slot.
  it("grants a token that names no device, without recording it", async () => {
    const { service } = build();

    await expect(service.claim(as(undefined), { subscriptionId: SUB })).resolves.toMatchObject({ granted: true, enforced: false });
  });

  it("says a subscription that is not active is not active, on claim and on renew", async () => {
    const { service } = build({ status: "EXPIRED" });

    await expect(service.claim(as(PC), { subscriptionId: SUB })).rejects.toMatchObject({
      response: { code: "SUBSCRIPTION_INACTIVE", subscriptionStatus: "EXPIRED" },
    });
    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toEqual({
      status: "inactive",
      subscriptionId: SUB,
      subscriptionStatus: "EXPIRED",
    });
  });

  it("refuses a signed-out device with 401 and someone else's subscription with 404", async () => {
    const { service } = build({ sessions: { [PC]: { revoked: true }, [PHONE]: {} } });

    await expect(service.claim(as(PC), { subscriptionId: SUB })).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.claim(as(PHONE), { subscriptionId: "22222222-2222-4222-8222-222222222222" })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  /** A slot that lapsed while its device was quiet, or was forgotten (a
   * Redis outage across a restart), comes back on renewal if there is
   * room -- the device is not told it was displaced by nobody. */
  it("re-grants on renewal a slot that lapsed, when there is room", async () => {
    const { service } = build();
    await service.claim(as(PC), { subscriptionId: SUB }, windows);
    await service.releaseSubscription(SUB);

    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({ status: "held", enforced: true });
  });

  it("names the device from its headers, and keeps the name from sign-in when a claim sends none", async () => {
    const { service, sessions } = build({ sessions: { [PC]: { label: "Ali's laptop", platform: "windows" }, [PHONE]: {} } });

    await service.claim(as(PC), { subscriptionId: SUB });
    const body = await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, android));

    expect(body.holders[0]).toMatchObject({ label: "Ali's laptop", platform: "windows" });
    expect(sessions[PHONE]).toMatchObject({ label: "Pixel 7", platform: "android" });
  });

  /** "Windows PC" is English; the phone reading it may be in Persian. The
   * kind of device is named from `platform` by the device that shows it.
   * A generic name stored before this rule -- or sent by an app built to
   * the old contract -- is not passed on. */
  it("never hands another device a generic English kind as a label", async () => {
    const { service } = build({
      sessions: { [PC]: { label: "Windows PC", platform: "windows" }, [PHONE]: { label: "Android phone", platform: "android" } },
    });

    await service.claim(as(PC), { subscriptionId: SUB }, { label: "Windows PC", platform: "windows" });
    const refused = await refusal(service.claim(as(PHONE), { subscriptionId: SUB }, { label: "Android phone (Pixel 7)", platform: "android" }));
    expect(refused.holders[0]).toMatchObject({ label: null, platform: "windows" });

    await service.claim(as(PHONE), { subscriptionId: SUB, takeover: [refused.holders[0].handle] });
    await expect(service.renew(as(PC), { subscriptionId: SUB })).resolves.toMatchObject({
      status: "displaced",
      by: { label: "Pixel 7", platform: "android" },
    });
  });

  /** Two people sharing one slot by tapping back and forth is within the
   * plan; a script doing it every few seconds is not. Logged past ten an
   * hour, refused past thirty. */
  it("logs heavy takeover traffic and refuses it past the hourly ceiling", async () => {
    const { service, warn } = build();
    let current = await service.claim(as(PC), { subscriptionId: SUB }, windows);
    const devices = [PHONE, PC];

    for (let i = 0; i < 30; i++) {
      const who = devices[i % 2];
      current = await service.claim(as(who), { subscriptionId: SUB, takeover: [current.handle!] });
      await jest.advanceTimersByTimeAsync(10_000);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).includes("device takeovers in the last hour"))).toBe(true);

    const refused = service.claim(as(devices[0]), { subscriptionId: SUB, takeover: [current.handle!] });
    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(refused).rejects.toMatchObject({ status: 429, response: { code: "TAKEOVER_LIMIT" } });
  });
});
