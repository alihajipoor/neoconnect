import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { BRAND_LINKS_SLOT, BRAND_LOGO_SLOT } from "./templates";

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

/** Fills the brand slots the templates leave behind: the mark in the
 * header and the community links in the footer.
 *
 * Done here rather than inside the templates because both depend on
 * runtime state -- where this API answers from, and what the operator
 * has configured -- while the templates are pure synchronous functions
 * called from a dozen places.
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

    return html
      .replace(BRAND_LOGO_SLOT, this.logoHtml(publicApiUrl))
      .replace(BRAND_LINKS_SLOT, await this.linksHtml());
  }

  /** Without a public URL there is nowhere to fetch the mark from, so
   * the header falls back to the wordmark alone. A broken-image icon
   * next to the product name looks worse than no image at all. */
  private logoHtml(publicApiUrl: string | undefined): string {
    if (!publicApiUrl) return "";
    return (
      `<img src="${publicApiUrl}/brand/logo-mono.png" width="28" height="28" alt="" ` +
      `style="vertical-align:middle;margin-right:10px;border:0;display:inline-block;">`
    );
  }

  private async linksHtml(): Promise<string> {
    const links = await this.links();
    const entries = [
      { url: links.websiteUrl, label: "Website" },
      { url: links.discordUrl, label: "Discord" },
      { url: links.instagramUrl, label: "Instagram" },
      { url: links.telegramUrl, label: "Telegram" },
    ].filter((entry): entry is { url: string; label: string } => Boolean(entry.url));

    // Nothing set, nothing rendered -- not an empty row of separators.
    // Same rule the app's header follows: never show a way to reach us
    // that goes nowhere.
    if (entries.length === 0) return "";

    const rendered = entries
      .map(
        (entry) =>
          `<a href="${escapeAttribute(entry.url)}" style="color:#7c3aed;text-decoration:none;font-weight:600;">${entry.label}</a>`,
      )
      // A middle dot rather than a table of buttons: this is a footer,
      // and it should not compete with the message above it.
      .join('<span style="color:#c9c4de;"> &middot; </span>');

    return `<p style="margin:0 0 10px 0;font-size:12px;">${rendered}</p>`;
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

/** These are operator-entered URLs going into an href. A quote in one
 * would otherwise close the attribute and let the rest be read as
 * markup. */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
