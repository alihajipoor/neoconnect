import { deviceInfoFrom, hasDeviceInfo } from "./device-info";

/** A device's name for itself is shown to the customer's other devices
 * ("Neoxify is in use on Windows PC"), so it is untrusted display text --
 * and it must never be a hostname, which is personal and often the
 * owner's own name. */
describe("deviceInfoFrom", () => {
  const from = (label?: string, platform?: string) =>
    deviceInfoFrom({
      ...(label !== undefined ? { "x-neoxify-device-label": label } : {}),
      ...(platform !== undefined ? { "x-neoxify-device-platform": platform } : {}),
    });

  it("takes a model or the user's own name, and a known platform, as sent", () => {
    expect(from("Pixel 7", "android")).toEqual({ label: "Pixel 7", platform: "android" });
    expect(from("iPad", "ios")).toEqual({ label: "iPad", platform: "ios" });
  });

  /** The device's kind is named by whoever reads it, from `platform`, in
   * their own language: "Windows PC" in the middle of a Persian sentence
   * is what this prevents. */
  it("gives a device that sends only its platform, or a generic English kind, no label", () => {
    expect(from(undefined, "Windows")).toEqual({ label: null, platform: "windows" });
    expect(from("Windows PC", "windows")).toEqual({ label: null, platform: "windows" });
    expect(from("android phone", "android")).toEqual({ label: null, platform: "android" });
    expect(from("iPhone", "ios")).toEqual({ label: null, platform: "ios" });
  });

  // What the apps were first built to send.
  it("keeps the model out of a generic kind with a model in brackets", () => {
    expect(from("Android phone (Pixel 7)", "android").label).toBe("Pixel 7");
    expect(from("Android phone ()", "android").label).toBe("Android phone ()");
  });

  it("still records the platform of a device with no label, so it has something to say", () => {
    expect(hasDeviceInfo(from(undefined, "android"))).toBe(true);
  });

  it("knows nothing about a device that sent nothing, and says so", () => {
    const info = deviceInfoFrom({});
    expect(info).toEqual({ label: null, platform: null });
    expect(hasDeviceInfo(info)).toBe(false);
  });

  it("ignores a platform it does not know", () => {
    expect(from("My thing", "toaster")).toEqual({ label: "My thing", platform: null });
  });

  // Headers are Latin-1; a Persian name arrives percent-encoded.
  it("decodes a percent-encoded UTF-8 label", () => {
    expect(from(encodeURIComponent("گوشی علی"), "android").label).toBe("گوشی علی");
  });

  it("strips control and bidi-override characters and collapses whitespace", () => {
    expect(from("Ali's\u0000  laptop‮\t", "windows").label).toBe("Ali's laptop");
  });

  it("caps a label at 48 characters", () => {
    expect(from("x".repeat(200), "linux").label).toHaveLength(48);
  });

  it.each(["ali-laptop.local", "host.example.com", "DESKTOP-7H3K2L9", "LAPTOP-AB12CD3"])(
    "drops %j, which looks like a hostname, leaving the platform to name the device",
    (hostname) => {
      expect(from(hostname, "windows")).toEqual({ label: null, platform: "windows" });
    },
  );

  it("takes the first value of a repeated header", () => {
    expect(deviceInfoFrom({ "x-neoxify-device-platform": ["macos", "linux"] }).platform).toBe("macos");
  });
});
