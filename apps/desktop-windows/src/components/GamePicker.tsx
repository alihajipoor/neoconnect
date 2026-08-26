import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { GameProfileSummary } from "../lib/customer";
import { GAME_PAGE_SIZE, rankGames } from "../lib/game-apps";
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
 * only way somebody can tell what they bought -- and what that is
 * differs by where the picker is used, which is why `subtitle` is a
 * prop. Gaming mode redirects hostnames; Custom mode routes programs.
 * A row that said "launcher, login and updates" in both places would be
 * false in one of them.
 */
export function GamePicker({
  games,
  chosen,
  onPick,
  onClose,
  subtitle,
  emptyLabel,
}: {
  games: GameProfileSummary[];
  /** Slugs already on the customer's list. */
  chosen: string[];
  onPick: (slug: string) => void;
  onClose: () => void;
  /** What choosing this row buys, per row. Defaults to gaming mode's
   * answer, which is what every existing caller means. */
  subtitle?: (game: GameProfileSummary) => string;
  /** Shown when the catalogue itself is empty for this caller, which
   * is a different fact from a search matching nothing. */
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const already = new Set(chosen);

  // Matched on the two things a person actually reads. Searching the
  // hostname list as well would make "www" match everything.
  //
  // Ranked rather than merely filtered, which a list of three did not need
  // and a list of a thousand does: a plain `includes` puts every game whose
  // name happens to contain "cs" above Counter-Strike, and the customer
  // concludes their game is missing. Cheap enough to run on every keystroke
  // -- it is a few thousand string comparisons -- so there is no debounce to
  // make the field feel laggy.
  const matches = useMemo(() => rankGames(games, query), [games, query]);

  // Only the first page is rendered. The catalogue runs to well over a
  // thousand rows, and mounting all of them inside a backdrop-blurred card
  // is the kind of thing that makes a picker feel broken on the low-end
  // machines a lot of these customers have. The count below says how many
  // matched, so a truncated list never reads as "my game is not there".
  const shown = matches.slice(0, GAME_PAGE_SIZE);
  const hidden = matches.length - shown.length;

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
            {query.trim() ? t("gaming.searchEmpty") : (emptyLabel ?? t("gaming.listEmpty"))}
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
                        {subtitle ? subtitle(game) : t("gaming.redirects")}
                        {game.publisher ? ` · ${game.publisher}` : ""}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
            {hidden > 0 ? (
              // Stated rather than left to be inferred. A list that just stops
              // reads as "my game is not supported", which is the one
              // conclusion this picker must not accidentally produce.
              <li
                aria-live="polite"
                className="px-2.5 py-2 text-center text-[10px] text-muted-foreground"
              >
                {t("gaming.searchMore", { count: hidden })}
              </li>
            ) : null}
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
