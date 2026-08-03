import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { UpdateAppLinksDto } from "./dto/update-app-links.dto";

@Injectable()
export class AppLinksService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lazily creates the single expected row, same convention as the
   * other settings singletons in this codebase. */
  async get() {
    const existing = await this.prisma.appLinks.findFirst();
    if (existing) return existing;
    return this.prisma.appLinks.create({ data: {} });
  }

  async update(dto: UpdateAppLinksDto) {
    const settings = await this.get();
    return this.prisma.appLinks.update({
      where: { id: settings.id },
      // Empty string means "remove it", which has to reach the database
      // as null -- an empty string would render as a button linking
      // nowhere, which is worse than no button.
      data: {
        websiteUrl: blankToNull(dto.websiteUrl),
        discordUrl: blankToNull(dto.discordUrl),
        instagramUrl: blankToNull(dto.instagramUrl),
        telegramUrl: blankToNull(dto.telegramUrl),
      },
    });
  }
}

function blankToNull(value: string | null | undefined) {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
