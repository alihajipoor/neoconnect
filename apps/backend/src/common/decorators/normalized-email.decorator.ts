import { applyDecorators } from "@nestjs/common";
import { Transform } from "class-transformer";
import { IsEmail } from "class-validator";

/** An email address used to identify somebody, trimmed and lowercased
 * before anything looks at it.
 *
 * Reported from real use: signing in with `Ali@example.com` failed for an
 * account registered as `ali@example.com`. Every lookup is an exact match
 * on a unique column, so a single capital letter meant "no such account"
 * -- and the message a customer sees for that is indistinguishable from a
 * wrong password, which is the worst possible way to fail.
 *
 * Lowercasing the local part is technically lossy: RFC 5321 permits
 * `Ali@` and `ali@` to be different mailboxes. No provider anyone uses
 * actually does that, and treating them as distinct means silently
 * creating a second account for somebody who capitalised their own name
 * -- a far more likely event, and a worse one. Every large service makes
 * the same trade.
 *
 * A decorator rather than a line in each service, because there are five
 * separate lookups plus two create paths, and the one that gets forgotten
 * is the bug. Applied at the boundary, so nothing downstream can receive
 * an un-normalised address.
 *
 * Deliberately not used for the SMTP sender address in EmailSettings:
 * that is a value to send *as*, never a key to look anything up by, and
 * an operator who typed a capital there meant it.
 */
export function NormalizedEmail(): PropertyDecorator {
  return applyDecorators(
    // Before IsEmail, so validation judges the value that will be stored
    // rather than the one that was typed.
    Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value)),
    IsEmail(),
  );
}
