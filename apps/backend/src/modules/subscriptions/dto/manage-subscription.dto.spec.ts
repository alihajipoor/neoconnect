import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { SetDataCapDto } from "./manage-subscription.dto";

/** The body is where "unlimited" and "forgot the field" have to stay
 * different: an empty PATCH must not remove someone's cap. */
describe("SetDataCapDto", () => {
  const errorsFor = (body: unknown) => validateSync(plainToInstance(SetDataCapDto, body));

  it("accepts a byte count as a decimal string", () => {
    expect(errorsFor({ dataCapBytes: "23622320128" })).toHaveLength(0);
  });

  it("accepts an explicit null as unlimited", () => {
    expect(errorsFor({ dataCapBytes: null })).toHaveLength(0);
  });

  it.each([
    ["a missing field", {}],
    ["zero", { dataCapBytes: "0" }],
    ["a negative number", { dataCapBytes: "-5" }],
    ["a fraction of a byte", { dataCapBytes: "1.5" }],
    ["a unit instead of bytes", { dataCapBytes: "22GB" }],
    ["a JSON number", { dataCapBytes: 1073741824 }],
    ["seventeen digits", { dataCapBytes: "12345678901234567" }],
  ])("rejects %s", (_label, body) => {
    expect(errorsFor(body)).not.toHaveLength(0);
  });
});
