import { IsOptional, IsUrl, ValidateIf } from "class-validator";

/** Every field is optional and may be cleared.
 *
 * `ValidateIf` rather than plain `@IsOptional`, because an empty string
 * is how a form says "remove this" -- and `@IsUrl` would reject it,
 * leaving the operator unable to delete a link once set.
 */
export class UpdateAppLinksDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== "" && value !== null)
  @IsUrl({ require_protocol: true })
  websiteUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== "" && value !== null)
  @IsUrl({ require_protocol: true })
  discordUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== "" && value !== null)
  @IsUrl({ require_protocol: true })
  instagramUrl?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== "" && value !== null)
  @IsUrl({ require_protocol: true })
  telegramUrl?: string | null;
}
