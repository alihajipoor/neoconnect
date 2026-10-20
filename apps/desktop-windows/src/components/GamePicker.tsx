import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { GameProfileSummary } from "../lib/customer";
import { GAME_PAGE_SIZE, rankGames } from "../lib/game-apps";
import { PickerDialog } from "./overlay";
import { Message, PillButton } from "./ui";

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
 *
 * A proper dialog (`PickerDialog`): labelled, modal, focus in the search
 * and kept inside, Escape to close, drawn in the app's own glass in both
 * themes. It is rendered at the document root, never inside the glass card
 * that opens it -- `position: fixed` is measured against an ancestor with
 * a backdrop filter, which once clipped a picker's header and Cancel off
 * the top of the screen.
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
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");

  // Grouped digits in the reader's own numerals. Four figures is where a
  // bare String(n) starts to read as a serial number rather than a count.
  const format = useMemo(() => {
    const nf = new Intl.NumberFormat(language === "fa" ? "fa-IR" : "en-US");
    return (n: number) => nf.format(n);
  }, [language]);

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
  // thousand rows, and mounting all of them inside a blurred dialog is the
  // kind of thing that makes a picker feel broken on the low-end machines
  // a lot of these customers have. The count below says how many matched,
  // so a truncated list never reads as "my game is not there".
  const shown = matches.slice(0, GAME_PAGE_SIZE);
  const hidden = matches.length - shown.length;

  return (
    <PickerDialog
      open
      title={t("gaming.pickerTitle")}
      onClose={onClose}
      closeLabel={t("gaming.cancel")}
      search={{ value: query, onChange: setQuery, placeholder: t("gaming.search") }}
      // What a row in this list is, and is not. A catalogue of 1,480
      // entries reads as a compatibility list -- as though each one had
      // been tried -- and none of them has. Said here, once, at the moment
      // somebody is choosing, rather than buried in a settings screen they
      // will never open.
      note={t("gaming.pickerMeaning")}
      foot={
        <PillButton variant="ghost" size="sm" onClick={onClose}>
          {t("gaming.cancel")}
        </PillButton>
      }
    >
      {shown.length === 0 ? (
        <Message tone="neutral">{query.trim() ? t("gaming.searchEmpty") : (emptyLabel ?? t("gaming.listEmpty"))}</Message>
      ) : (
        <ul className="nx-pick-list">
          {shown.map((game) => {
            const picked = already.has(game.slug);
            return (
              <li key={game.slug}>
                <button type="button" className="nx-pick-row" disabled={picked} onClick={() => onPick(game.slug)}>
                  <GameTile game={game} />
                  <span className="t">
                    <span className="n">{game.displayName}</span>
                    {/* What choosing this row actually buys, spelled out on
                        the row. In this mode it is exactly the launcher,
                        login and updates -- the game's own connection is
                        left on the direct path by construction, and a row
                        that implied otherwise would be selling something we
                        do not do. */}
                    <span className="s">
                      {subtitle ? subtitle(game) : t("gaming.redirects")}
                      {game.publisher ? ` · ${game.publisher}` : ""}
                    </span>
                  </span>
                  {picked ? (
                    <span className="tag">
                      <Check aria-hidden />
                      {t("pick.added")}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
          {hidden > 0 ? (
            // Stated rather than left to be inferred. A list that just stops
            // reads as "my game is not supported", which is the one
            // conclusion this picker must not accidentally produce.
            //
            // Two strings, because one could not be true in both states. On
            // first open nothing has been typed and nothing has "matched" --
            // the other 1,420 rows are simply the rest of the catalogue -- so
            // telling somebody to "keep typing to narrow it down" is wrong
            // twice over. Numbers are localised here rather than
            // interpolated raw: `t()` substitutes with String(), which would
            // put Latin digits inside a right-to-left sentence and no
            // thousands separator in either language.
            <li aria-live="polite" className="nx-pick-more">
              {query.trim()
                ? t("gaming.searchMore", { count: format(hidden) })
                : t("gaming.listMore", { shown: format(shown.length), count: format(matches.length) })}
            </li>
          ) : null}
        </ul>
      )}
    </PickerDialog>
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
    <span className="nx-pick-tile" aria-hidden>
      {game.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
}
