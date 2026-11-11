import { Transform } from "class-transformer";
import { IsEnum, IsIP, IsString, MinLength, registerDecorator, type ValidationArguments } from "class-validator";
import { NodeRole } from "@prisma/client";
import { ISO_COUNTRY_CODES } from "../../../common/iso-countries";

/** `<country code>-<name>`, lower case: `fi-finland`, `us-new-york`. */
const REGION_FORMAT = /^[a-z]{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What is wrong with a region label, or null when it can be used.
 *
 * The label is typed once, when a server is added, and the apps read the
 * country off its first two letters: the flag, the name and the light on
 * the map all come from that. It used to be any text at all, and nothing
 * said so when it named no country -- the server simply showed customers a
 * globe, in apps that had shipped weeks before and could not be told
 * otherwise (Sweden, 2026-11-11, for want of a flag; `uk-london` would
 * have done the same for want of a code).
 *
 * So the code has to be one the apps know: the 249 of ISO 3166-1, which
 * they all carry. That makes "a server in a new country needs no app
 * update" true for whatever gets past here. What this cannot tell is a
 * right code from a wrong one that is also a country: `la-los-angeles` is
 * a well-formed label for a server in Laos. The message says what the code
 * is for, which is the only guard there is for that. */
export function regionProblem(region: unknown): string | null {
  if (typeof region !== "string" || !REGION_FORMAT.test(region)) {
    return (
      "region must be the country's two-letter ISO code, a dash and a name, in lower case, " +
      "like fi-finland or us-new-york: the code is what gives the server its flag and country name in the apps"
    );
  }
  const code = region.slice(0, 2);
  if (!ISO_COUNTRY_CODES.has(code)) {
    return `region must start with a country's two-letter ISO code, and "${code}" is not one (the United Kingdom is gb, Greece is gr)`;
  }
  return null;
}

function IsNodeRegion(): PropertyDecorator {
  return (target, propertyName) =>
    registerDecorator({
      name: "isNodeRegion",
      target: target.constructor,
      propertyName: String(propertyName),
      validator: {
        validate: (value: unknown) => regionProblem(value) === null,
        defaultMessage: (args?: ValidationArguments) => regionProblem(args?.value) ?? "region is not usable",
      },
    });
}

export class CreateNodeDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsEnum(NodeRole)
  role!: NodeRole;

  // Trimmed and lowered before it is judged, as the apps read it: a
  // capital or a stray space is not worth refusing a server over, and
  // what is stored is the one form.
  @Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsNodeRegion()
  region!: string;

  @IsIP()
  publicIp!: string;
}
