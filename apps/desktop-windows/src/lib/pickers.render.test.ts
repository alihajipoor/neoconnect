import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GameProfileSummary } from "./customer";
import { GAME_PAGE_SIZE } from "./game-apps";
import { I18nProvider } from "./i18n";

/** The two pickers -- the game catalogue and the running apps -- as the
 * dialogs they now are (components/overlay.tsx `PickerDialog`): labelled
 * and modal, the search taking the first focus, a Cancel at the foot, rows
 * already chosen kept and marked rather than dropped, and nothing drawn in
 * the old dark theme's white-on-dark classes that vanish on Pearl.
 *
 * The server renderer has no portals, so `createPortal` hands its children
 * back where they are, and `document` exists only so the dialog renders. */

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return { ...actual, createPortal: (node: ReactNode) => node };
});
vi.mock("./split-tunnel", () => ({ listRunningApps: () => new Promise(() => undefined) }));

const { GamePicker } = await import("../components/GamePicker");
const { RunningAppPicker } = await import("../components/RunningAppPicker");

beforeAll(() => {
  vi.stubGlobal("document", {});
});
afterAll(() => {
  vi.unstubAllGlobals();
});

function game(slug: string, displayName: string, publisher: string | null = null): GameProfileSummary {
  return {
    slug,
    displayName,
    iconKey: null,
    publisher,
    hostnames: [],
    excludeHostnames: [],
    canaryHostname: null,
  } as GameProfileSummary;
}

const GAMES = [game("cs2", "Counter-Strike 2", "Valve"), game("dota2", "Dota 2", "Valve"), game("val", "Valorant", "Riot")];
const noop = () => undefined;

const wrap = (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(I18nProvider, null, child));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("the game picker, as a dialog", () => {
  it("is a labelled modal dialog with the search first and a Cancel", () => {
    const html = wrap(createElement(GamePicker, { games: GAMES, chosen: [], onPick: noop, onClose: noop }));
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="([^"]+)"/);
    const labelled = html.match(/aria-labelledby="([^"]+)"/)![1];
    expect(html).toContain(`<h2 id="${labelled}">Choose a game</h2>`);
    // The search takes the first focus, not the close button.
    expect(html).toMatch(/<input type="search" data-autofocus="true"/);
    expect(html).toMatch(/aria-label="Cancel"/);
    expect(text(html)).toContain("Cancel");
    for (const g of GAMES) expect(text(html)).toContain(g.displayName);
  });

  it("keeps a game already chosen in the list, disabled and marked Added", () => {
    const html = wrap(createElement(GamePicker, { games: GAMES, chosen: ["dota2"], onPick: noop, onClose: noop }));
    const rows = html.match(/<button type="button" class="nx-pick-row"[^>]*>.*?<\/button>/g) ?? [];
    expect(rows).toHaveLength(3);
    const dota = rows.find((r) => r.includes("Dota 2"))!;
    expect(dota).toMatch(/disabled=""/);
    expect(text(dota)).toContain("Added");
    for (const row of rows.filter((r) => !r.includes("Dota 2"))) {
      expect(row).not.toMatch(/disabled=""/);
      expect(text(row)).not.toContain("Added");
    }
  });

  it("says how many it is not showing, and what an empty catalogue is", () => {
    const many = Array.from({ length: GAME_PAGE_SIZE + 15 }, (_, i) => game(`g${i}`, `Game ${i}`));
    const html = text(wrap(createElement(GamePicker, { games: many, chosen: [], onPick: noop, onClose: noop })));
    expect(html).toContain(`Showing the first ${GAME_PAGE_SIZE} of ${GAME_PAGE_SIZE + 15} games.`);
    const empty = text(wrap(createElement(GamePicker, { games: [], chosen: [], onPick: noop, onClose: noop })));
    expect(empty).toContain("No games are on the list.");
    const own = text(wrap(createElement(GamePicker, { games: [], chosen: [], onPick: noop, onClose: noop, emptyLabel: "Nothing here" })));
    expect(own).toContain("Nothing here");
  });
});

describe("the running-app picker, as a dialog", () => {
  it("is a labelled modal dialog with Refresh, the search first and a Cancel, and says it is loading", () => {
    const html = wrap(createElement(RunningAppPicker, { chosen: [], onPick: noop, onClose: noop }));
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="[^"]+"/);
    expect(text(html)).toContain("Running apps");
    expect(html).toMatch(/<input type="search" data-autofocus="true"/);
    expect(html).toMatch(/aria-label="Refresh[^"]*"/);
    expect(html).toMatch(/role="status"/);
    expect(text(html)).toContain("Loading");
    expect(text(html)).toContain("Cancel");
  });
});

describe("the sub-views read on both themes", () => {
  // The old dark theme's white-on-dark borders and fills, and its warning
  // utilities tuned for a dark ground: on the light Pearl theme they drew
  // nothing at all, or a yellow too pale to read.
  const FILES = [
    "CustomModeCard",
    "RunningAppPicker",
    "GamePicker",
    "GamingModeCard",
    "RepairNetwork",
    "AccountRecovery",
    "BackupRoute",
    "CommunityLinks",
    "LocationPicker",
    "Latency",
    "IspTagLine",
  ];
  const DARK_ONLY = /\b(?:hover:|focus:|disabled:)?(?:bg|border|divide|ring)-(?:white|black)\/[\w.[\]]+|\btext-warning\b|\b(?:bg|border)-warning\/\S+/g;

  it.each(FILES)("%s has no class that only shows on the dark theme", (name) => {
    const source = readFileSync(new URL(`../components/${name}.tsx`, import.meta.url), "utf8")
      // Comments may name the old classes to say why they went.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source.match(DARK_ONLY) ?? []).toEqual([]);
  });
});
