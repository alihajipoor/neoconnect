/**
 * Persian (U+06F0-06F9) and Arabic-Indic (U+0660-0669) digits as the
 * ASCII digits the server compares codes against.
 *
 * A Persian keyboard -- or a phone's number pad in a Persian locale --
 * types ۱۲۳۴۵۶, and the emailed six-digit codes are ASCII. The apps' code
 * fields keep only ASCII digits, so on such a keyboard the field simply
 * stayed empty however much was typed. Each of these digits' low four bits
 * is its value.
 */
export function toLatinDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (d) => String(d.charCodeAt(0) & 0xf));
}
