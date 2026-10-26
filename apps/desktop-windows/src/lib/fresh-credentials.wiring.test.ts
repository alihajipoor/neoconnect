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

  // Round 4: asked while the rung's tunnel was still up, the question went
  // into it -- confined to it, the app's only way out -- and a node refusing
  // the credential carries nothing; it was never asked again in that pass.
  it("asks for them once the tunnel of a rung that carried nothing is down, never into it", () => {
    expect(ladder).toContain(
      'const fresh = createFreshAsk(\n        () => refreshConnectionConfig({ held: dialable, force: true, trigger: "connect", appState: connectionState }),',
    );
    const upBut = ladder.indexOf("attempts.push(`${label}: up but ${reason}`);");
    const after = ladder.slice(upBut, ladder.indexOf("} catch (err) {", upBut));
    expect(after).toContain("carriedNothing.push(candidate);");
    expect(after).not.toContain("refreshConnectionConfig(");
    expect(after).not.toContain("fresh.ask()");
    const bottom = ladder.indexOf('await invoke(holdThrough ? "vpn_disconnect_for_reconnect" : "vpn_disconnect").catch(() => undefined);\n        // Dialled beside');
    const asked = ladder.indexOf('if (carriedNothing.length > 0 && refreshed.source !== "network") fresh.ask();');
    expect(bottom).toBeGreaterThan(upBut);
    expect(asked).toBeGreaterThan(bottom);
    expect(ladder.split("fresh.ask()").length - 1).toBe(1);
  });

  it("dials the rest of the ladder on the answer, waiting for it only after a last rung", () => {
    const bottom = ladder.indexOf('await invoke(holdThrough ? "vpn_disconnect_for_reconnect" : "vpn_disconnect").catch(() => undefined);\n        // Dialled beside');
    const tail = ladder.slice(bottom, ladder.indexOf("// Superseded while it was running", bottom));
    const asked = tail.indexOf('if (carriedNothing.length > 0 && refreshed.source !== "network") fresh.ask();');
    const waited = tail.indexOf("if (isLast) await fresh.pending();", asked);
    const taken = tail.indexOf("takeFresh(index + 1);");
    const said = tail.indexOf('if (index < candidates.length - 1) publishObserved(intent, "connecting");');
    // After a last rung an earlier ask is waited for first, and asked again
    // if it was not answered from the server.
    const earlier = tail.indexOf("if (isLast) await fresh.pending();");
    expect(earlier).toBeGreaterThan(-1);
    expect(earlier).toBeLessThan(asked);
    expect(waited).toBeGreaterThan(asked);
    expect(taken).toBeGreaterThan(waited);
    expect(said).toBeGreaterThan(taken);
    expect(ladder).toContain(
      "candidates = [...candidates.slice(0, from), ...onFreshCredentials(candidates.slice(from), carriedNothing, answer)];",
    );
  });
});
