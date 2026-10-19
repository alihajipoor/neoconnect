import { Fragment, type ReactNode } from "react";

/** What a translation's placeholder is filled with when the value goes in
 * as an element: `t(key, { protocol: SLOT })`, then `<Slotted>`. */
export const SLOT = "\u0001";

/** A translated sentence with an element set where its placeholder was --
 * a protocol name in medium weight, say -- wherever the language puts it.
 * "Now using {protocol}" ends with it in English and has it mid-sentence in
 * Persian, so the element cannot simply follow the words. */
export function Slotted({ text, children }: { text: string; children: ReactNode }) {
  const parts = text.split(SLOT);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? children : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}
