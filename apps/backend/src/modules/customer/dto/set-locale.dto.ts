import { ApiProperty } from "@nestjs/swagger";
import { IsIn } from "class-validator";

/** The language this customer wants to be written to in.
 *
 * Required, not optional: this endpoint exists only to change the value,
 * and an empty body would be a request to set it to nothing. The two
 * accepted values are the two the clients ship -- see `Language` in
 * apps/desktop-windows/src/lib/i18n.tsx.
 */
export class SetLocaleDto {
  @ApiProperty({ enum: ["en", "fa"] })
  @IsIn(["en", "fa"])
  locale!: "en" | "fa";
}
