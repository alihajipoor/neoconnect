import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The iOS icon set, checked for the two things App Store Connect
 * rejects an upload for.
 *
 * Both failures arrive after the upload rather than at build time, which
 * is the worst moment to learn about them: the build is green, the
 * archive is signed, and the rejection names the asset catalogue rather
 * than the file.
 *
 * This directory is committed and is what `tauri ios init` copies into
 * the generated project, so checking it here covers every build rather
 * than whichever one happens to be in front of someone.
 */
describe("the committed iOS app icons", () => {
  const dir = new URL("../../src-tauri/icons/ios/", import.meta.url);
  const icons = readdirSync(dir).filter((f) => f.endsWith(".png"));

  /** Width, height and colour type out of a PNG's IHDR, which is always
   * the first chunk and always at a fixed offset. */
  function header(name: string) {
    const b = readFileSync(new URL(name, dir));
    return {
      width: b.readUInt32BE(16),
      height: b.readUInt32BE(20),
      // 4 is greyscale+alpha, 6 is RGBA. 0 and 2 carry no alpha channel.
      hasAlpha: b[25] === 4 || b[25] === 6,
    };
  }

  it("has icons at all", () => {
    expect(icons.length).toBeGreaterThan(0);
  });

  /** `tauri icon` writes RGBA whatever it is given, so this regressed the
   * moment the icons were regenerated from a perfectly opaque source. */
  it.each(icons)("%s carries no alpha channel", (name) => {
    expect(header(name).hasAlpha, `${name} has an alpha channel`).toBe(false);
  });

  /** The marketing icon. 1024x1024 exactly, and the one whose alpha
   * channel is rejected most visibly. */
  it("includes a 1024x1024 marketing icon", () => {
    const marketing = icons.filter((n) => {
      const h = header(n);
      return h.width === 1024 && h.height === 1024;
    });
    expect(marketing.length, "no 1024x1024 icon in the set").toBeGreaterThan(0);
  });
});
