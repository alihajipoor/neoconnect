import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { fillBrandSlots, type BrandLinkKind } from "./templates";

/** Community links change rarely and every send would otherwise hit the
 * database for them. A minute is short enough that fixing a dead Discord
 * invite takes effect while the operator is still watching. */
const CACHE_MS = 60_000;

interface Links {
  websiteUrl: string | null;
  discordUrl: string | null;
  instagramUrl: string | null;
  telegramUrl: string | null;
}

/** Supplies what the templates' slots are filled with: the mark in the
 * header, the community links in the footer and, on staff mail, where
 * the admin panel is.
 *
 * Done here rather than inside the templates because all three depend on
 * runtime state -- where this API answers from, and what the operator
 * has configured -- while the templates are pure synchronous functions
 * called from a dozen places. The drawing itself is `fillBrandSlots`,
 * beside the design it belongs to.
 */
@Injectable()
export class EmailBrandService {
  private cache: { at: number; links: Links } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async apply(html: string): Promise<string> {
    const publicApiUrl = this.config.get<string>("publicApiUrl")?.replace(/\/$/, "");
    const links = await this.links();

    return fillBrandSlots(html, {
      logoBaseUrl: publicApiUrl ? `${publicApiUrl}/brand` : undefined,
      panelUrl: panelUrlFrom(publicApiUrl),
      links: (
        [
          { kind: "website", url: links.websiteUrl },
          { kind: "discord", url: links.discordUrl },
          { kind: "instagram", url: links.instagramUrl },
          { kind: "telegram", url: links.telegramUrl },
        ] as const
      ).filter((entry): entry is { kind: BrandLinkKind; url: string } => Boolean(entry.url)),
    });
  }

  private async links(): Promise<Links> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.links;

    const row = await this.prisma.appLinks.findFirst();
    const links: Links = {
      websiteUrl: row?.websiteUrl ?? null,
      discordUrl: row?.discordUrl ?? null,
      instagramUrl: row?.instagramUrl ?? null,
      telegramUrl: row?.telegramUrl ?? null,
    };
    this.cache = { at: Date.now(), links };
    return links;
  }
}

/** Where the admin panel is, worked out from where the API is.
 *
 * There is no setting for the panel's own address, and there does not
 * need to be: the installer puts the API under the panel's domain
 * (PUBLIC_API_URL is `https://<panel domain>/api`, installer/lib/panel.sh),
 * so the panel is that address without the `/api`.
 *
 * Only that one shape is trusted. An API served from somewhere else says
 * nothing about where the panel is, and a button in an outage alert that
 * opens the wrong site is worse than no button -- so anything else is
 * "not known", and staff mail goes without one. */
export function panelUrlFrom(publicApiUrl: string | undefined): string | undefined {
  if (!publicApiUrl) return undefined;
  const match = /^(https?:\/\/[^/]+)\/api\/?$/.exec(publicApiUrl);
  return match ? match[1] : undefined;
}
