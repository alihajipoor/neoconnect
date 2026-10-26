import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The Windows ladder's credentials (the VM, round 3): the plan in use's
 * first, and credentials asked for again at once when a rung's tunnel comes
 * up and carries nothing on credentials this pass did not ask for. */

const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const dash = source("../screens/Dashboard.tsx");
const ladder = dash.slice(dash.indexOf("async function runLadder("));

describe("the ladder's credentials", () => {
  it("orders them with the plan in use first", () => {
    const order = ladder.slice(ladder.indexOf("let candidates = orderCandidates(dialable, {"));
    expect(order.slice(0, order.indexOf("});"))).toContain("        subscriptionId,\n");
  });

  it("asks for them again the moment a rung carried nothing on credentials nobody asked about this pass", () => {
    const upBut = ladder.indexOf("attempts.push(`${label}: up but ${reason}`);");
    const after = ladder.slice(upBut, ladder.indexOf("} catch (err) {", upBut));
    expect(after).toContain("carriedNothing.push(candidate);");
    expect(after).toContain('if (freshAsked === null && refreshed.source !== "network") {');
    expect(after).toContain('freshAsked = refreshConnectionConfig({ held: dialable, force: true, trigger: "connect", appState: connectionState })');
    // Not waited for there: the ladder moves on at once.
    expect(after).not.toContain("await freshAsked");
  });

  it("dials the rest of the ladder on the answer, waiting for it only after a last rung", () => {
    const bottom = ladder.indexOf('await invoke(holdThrough ? "vpn_disconnect_for_reconnect" : "vpn_disconnect").catch(() => undefined);');
    const tail = ladder.slice(bottom, ladder.indexOf("// Superseded while it was running", bottom));
    const waited = tail.indexOf("if (isLast && freshAsked !== null) await freshAsked;");
    const taken = tail.indexOf("takeFresh(index + 1);");
    const said = tail.indexOf('if (index < candidates.length - 1) publishObserved(intent, "connecting");');
    expect(waited).toBeGreaterThan(-1);
    expect(taken).toBeGreaterThan(waited);
    expect(said).toBeGreaterThan(taken);
    expect(ladder).toContain(
      "candidates = [...candidates.slice(0, from), ...onFreshCredentials(candidates.slice(from), carriedNothing, freshAnswer)];",
    );
  });
});
