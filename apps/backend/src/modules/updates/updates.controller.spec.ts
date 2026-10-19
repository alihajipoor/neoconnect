import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AddressInfo, Server } from "node:net";
import { UpdatesController } from "./updates.controller";
import { UpdatesService, type AndroidUpdateCheck } from "./updates.service";

/** The update check as the apps call it, over a real Nest server. The
 * release lookup underneath is a stand-in; updates.service.spec.ts covers
 * it. Pinned here: the Android app's answers (it used to be told "current"
 * for every version, unchecked), and that the other targets answer as
 * before. */
describe("GET /updates/:target/:arch/:currentVersion", () => {
  let app: INestApplication;
  let base: string;
  const updates = {
    checkAndroid: jest.fn<Promise<AndroidUpdateCheck>, [string]>(),
    checkFor: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [UpdatesController],
      providers: [{ provide: UpdatesService, useValue: updates }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    await app.listen(0);
    base = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    updates.checkAndroid.mockReset();
    updates.checkFor.mockReset();
  });

  it("tells an older Android app the newer version and where to download it", async () => {
    updates.checkAndroid.mockResolvedValue({ status: "update", version: "0.2.29" });

    const res = await fetch(`${base}/updates/android/aarch64/0.2.28`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "0.2.29", downloadPath: "/updates/installer/android" });
    expect(updates.checkAndroid).toHaveBeenCalledWith("0.2.28");
  });

  it("answers 204 to an Android app on the newest version", async () => {
    updates.checkAndroid.mockResolvedValue({ status: "current" });
    const res = await fetch(`${base}/updates/android/aarch64/0.2.29`);
    expect(res.status).toBe(204);
  });

  it("answers 503, never 204, when the newest Android version could not be found out", async () => {
    updates.checkAndroid.mockResolvedValue({ status: "unknown" });
    const res = await fetch(`${base}/updates/android/aarch64/0.2.28`);
    expect(res.status).toBe(503);
  });

  it("refuses an Android version that is not x.y.z without asking", async () => {
    const res = await fetch(`${base}/updates/android/aarch64/latest`);
    expect(res.status).toBe(400);
    expect(updates.checkAndroid).not.toHaveBeenCalled();
  });

  it("still tells a target nothing is published for that it is current", async () => {
    const res = await fetch(`${base}/updates/darwin/aarch64/0.1.0`);
    expect(res.status).toBe(204);
    expect(updates.checkAndroid).not.toHaveBeenCalled();
    expect(updates.checkFor).not.toHaveBeenCalled();
  });

  it("still answers Windows with the updater's manifest", async () => {
    updates.checkFor.mockResolvedValue({ status: "update", manifest: { version: "0.9.51" } });
    const res = await fetch(`${base}/updates/windows/x86_64/0.9.50`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: "0.9.51" });
    expect(updates.checkAndroid).not.toHaveBeenCalled();
  });
});
