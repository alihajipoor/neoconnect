import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { GameProfileSummary } from "../lib/customer";
import { Button } from "./ui";

/** Pick a game from the operator's curated list.
 *
 * Shaped after `RunningAppPicker`, and deliberately so -- but backed by
 * the server's list rather than by what is running. A game somebody
 * wants to set up is very often not open yet, and the hostnames that
 * belong to it are not something a client can work out by looking at a
 * process anyway.
 *
 * Two things carried over from that picker because both were bought with
 * real support traffic:
 *
 * * Games already chosen stay visible and disabled rather than
 *   disappearing. A list that silently omits things reads as the game
 *   not being supported.
 * * **One row is one game.** The Custom-mode picker makes the customer
 *   find the launcher and the game as two separate products, and nothing
 *   says you need both -- a genuine usability failure on the record. A
 *   game profile carries every hostname it needs, so choosing it once is
 *   the whole of it.
 *
 * Each row states what will actually be redirected, because that is the
 * only way somebody can tell what they bought.
 */
export function GamePicker({
  games,
  chosen,
  onPick,
  onClose,
}: {
  games: GameProfileSummary[];
  /** Slugs already on the customer's list. */
  chosen: string[];
  onPick: (slug: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const already = new Set(chosen);

  // Matched on the two things a person actually reads. Searching the
  // hostname list as well would make "www" match everything.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return games;
    return games.filter(
      (g) =>
        g.displayName.toLowerCase().includes(needle) ||
        (g.publisher ?? "").toLowerCase().includes(needle),
    );
  }, [games, query]);

  // Rendered into the body rather than where it sits in the tree.
  // `position: fixed` is measured against the nearest ancestor with a
  // transform or filter rather than the viewport, and the Card this
  // lives inside has backdrop-blur -- which clipped the sibling picker's
  // header and Cancel button off the top of the screen.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col gap-3 rounded-xl border border-white/10 bg-popover p-4 shadow-xl">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-sm font-semibold">{t("gaming.pickerTitle")}</p>
          <button
            type="button"
            aria-label={t("gaming.cancel")}
            onClick={onClose}
            className="press flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-white/8 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="relative">
          {/* Logical inset, so the glyph sits at the edge the text starts
              from -- a physical `left` put it on top of the first thing
              typed under Persian. */}
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("gaming.search")}
            className="w-full rounded-lg border border-white/8 bg-white/[0.03] py-1.5 pe-2 ps-8 text-xs outline-none placeholder:text-muted-foreground focus:border-white/20"
          />
        </div>

        {shown.length === 0 ? (
          <p className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            {query.trim() ? t("gaming.searchEmpty") : t("gaming.listEmpty")}
          </p>
        ) : (
          <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
            {shown.map((game) => {
              const picked = already.has(game.slug);
              return (
                <li key={game.slug}>
                  <button
                    type="button"
                    disabled={picked}
                    onClick={() => onPick(game.slug)}
                    className={[
                      "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-start",
                      picked
                        ? "cursor-default border-white/5 bg-white/[0.015] opacity-50"
                        : "press border-white/8 bg-white/[0.025] hover:bg-white/[0.05]",
                    ].join(" ")}
                  >
                    <GameTile game={game} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold">{game.displayName}</p>
                      {/* What choosing this row actually buys, spelled
                          out on the row. In this mode it is exactly the
                          launcher, login and updates -- the game's own
                          connection is left on the direct path by
                          construction, and a row that implied otherwise
                          would be selling something we do not do. */}
                      <p className="truncate text-[10px] text-muted-foreground">
                        {t("gaming.redirects")}
                        {game.publisher ? ` · ${game.publisher}` : ""}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <Button variant="outline" onClick={onClose} className="w-full justify-center">
          {t("gaming.cancel")}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

/** The tile that stands in for a game's mark.
 *
 * `iconKey` names an asset the client has no way to fetch yet -- there
 * is no icon pipeline on this side -- so every row draws the lettered
 * fallback rather than a broken image or an empty square. When the
 * assets exist this is the one place that has to change.
 *
 * Exported so the chosen-list rows on the card look like the picker's. */
export function GameTile({ game }: { game: GameProfileSummary }) {
  return (
    <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-[linear-gradient(120deg,color-mix(in_oklab,var(--primary)_35%,transparent),color-mix(in_oklab,var(--highlight)_25%,transparent))] text-[11px] font-bold text-foreground">
      {game.displayName.slice(0, 1).toUpperCase()}
    </div>
  );
}
