import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { NormalizedEmail } from "./normalized-email.decorator";

class Probe {
  @NormalizedEmail()
  email!: string;
}

/** Every email lookup in this codebase is an exact match on a unique
 * column, so normalisation is the only thing standing between a
 * capitalised address and "no such account" -- a failure the customer
 * cannot tell apart from a wrong password.
 *
 * Driven through plainToInstance + validate rather than by calling the
 * transform directly, because the thing worth proving is that it runs
 * where Nest's ValidationPipe puts it, in the order it puts it.
 */
describe("NormalizedEmail", () => {
  const normalize = async (value: unknown) => {
    const dto = plainToInstance(Probe, { email: value });
    const errors = await validate(dto);
    return { email: dto.email, valid: errors.length === 0 };
  };

  it("lowercases the address that was typed", async () => {
    expect(await normalize("Ali@Example.COM")).toEqual({ email: "ali@example.com", valid: true });
  });

  /** Phone keyboards add a trailing space readily, and a stored address
   * with one on the end matches nothing forever after. */
  it("trims surrounding whitespace", async () => {
    expect(await normalize("  ali@example.com  ")).toEqual({ email: "ali@example.com", valid: true });
  });

  it("leaves an already-normal address alone", async () => {
    expect(await normalize("ali@example.com")).toEqual({ email: "ali@example.com", valid: true });
  });

  /** The transform runs first, so validation judges the value that will
   * actually be stored. A capitalised address must not merely pass -- it
   * must pass *as its lowercase form*. */
  it("still rejects something that is not an address", async () => {
    expect((await normalize("Not An Email")).valid).toBe(false);
  });

  /** A non-string reaches the transform when a client sends the wrong
   * JSON type. It must fall through to validation rather than throw on
   * .trim(), or a malformed request becomes a 500 instead of a 400. */
  it("does not throw on a non-string, and rejects it", async () => {
    expect((await normalize(12345)).valid).toBe(false);
    expect((await normalize(null)).valid).toBe(false);
  });
});
