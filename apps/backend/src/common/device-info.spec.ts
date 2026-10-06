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

  it("takes a generic label and a known platform as sent", () => {
    expect(from("Android phone (Pixel 7)", "android")).toEqual({ label: "Android phone (Pixel 7)", platform: "android" });
  });

  it("names the device after its platform when it sends no label", () => {
    expect(from(undefined, "Windows")).toEqual({ label: "Windows PC", platform: "windows" });
    expect(from(undefined, "ios")).toEqual({ label: "iPhone", platform: "ios" });
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
    expect(from("Windows\u0000  PC‮\t", "windows").label).toBe("Windows PC");
  });

  it("caps a label at 48 characters", () => {
    expect(from("x".repeat(200), "linux").label).toHaveLength(48);
  });

  it.each(["ali-laptop.local", "host.example.com", "DESKTOP-7H3K2L9", "LAPTOP-AB12CD3"])(
    "drops %j, which looks like a hostname, for the platform's generic label",
    (hostname) => {
      expect(from(hostname, "windows").label).toBe("Windows PC");
    },
  );

  it("takes the first value of a repeated header", () => {
    expect(deviceInfoFrom({ "x-neoxify-device-platform": ["macos", "linux"] }).platform).toBe("macos");
  });
});
