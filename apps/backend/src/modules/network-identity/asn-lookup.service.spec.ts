import { ASN_RETRY_MS, AsnLookupService } from "./asn-lookup.service";

/** A first load that finds no table is tried again soon, not after a day:
 * until a table loads, every customer network reads unknown. */
describe("AsnLookupService retry while empty", () => {
  afterEach(() => jest.useRealTimers());

  function service() {
    const s = new AsnLookupService({ get: (key: string) => key === "asn.enabled" } as never);
    // A load that finds nothing, without touching the disk or the network.
    jest.spyOn(s as unknown as { doRefresh(): Promise<void> }, "doRefresh").mockResolvedValue(undefined);
    jest.spyOn((s as unknown as { logger: { warn(m: string): void } }).logger, "warn").mockImplementation(() => undefined);
    return s;
  }
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it("tries again after ASN_RETRY_MS while no table has loaded, and stops once one has", async () => {
    jest.useFakeTimers();
    const s = service();
    const refresh = jest.spyOn(s, "refresh");
    s.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(ASN_RETRY_MS);
    await flush();
    expect(refresh).toHaveBeenCalledTimes(2);

    // Loaded by some other route: no more early tries.
    s.use({ size: 1 } as never);
    await jest.advanceTimersByTimeAsync(ASN_RETRY_MS);
    await flush();
    const after = refresh.mock.calls.length;
    await jest.advanceTimersByTimeAsync(3 * ASN_RETRY_MS);
    await flush();
    expect(refresh.mock.calls.length).toBe(after);
    s.onModuleDestroy();
  });

  it("schedules nothing when the table is off", () => {
    const s = new AsnLookupService({ get: () => false } as never);
    const refresh = jest.spyOn(s, "refresh");
    s.onModuleInit();
    expect(refresh).not.toHaveBeenCalled();
  });
});
