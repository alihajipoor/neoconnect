import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVICE_CHECK_LABELS, serviceCheckLabel } from "./service-check-labels";

/** Every `{ key: "...", label: "..." }` entry of the backend's lists,
 * read from its source so the panel needs no backend import. */
function backendTargets(): Array<{ key: string; label: string }> {
  const file = fileURLToPath(
    new URL("../../../backend/src/modules/client-attempts/service-check-targets.ts", import.meta.url),
  );
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map((m) => ({ key: m[1], label: m[2] }));
}

describe("service check labels", () => {
  it("has a label for every key on the backend's list, the same label", () => {
    const targets = backendTargets();
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(SERVICE_CHECK_LABELS[t.key], `panel label for "${t.key}"`).toBe(t.label);
    }
  });

  it("names a key by its label, and a key on neither list by itself", () => {
    expect(serviceCheckLabel("instagram_app")).toBe("Instagram app API");
    expect(serviceCheckLabel("whatsapp")).toBe("WhatsApp Web");
    expect(serviceCheckLabel("not_on_the_list")).toBe("not_on_the_list");
    expect(serviceCheckLabel("toString")).toBe("toString");
  });
});
