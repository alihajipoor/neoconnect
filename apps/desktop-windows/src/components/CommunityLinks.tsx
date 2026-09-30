import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Globe } from "lucide-react";
import { DiscordIcon, InstagramIcon, TelegramIcon } from "./BrandIcons";
import { getAppLinks } from "../lib/customer";
import { IS_STORE_BUILD } from "../lib/distribution";
import type { AppLinks } from "../lib/types";

/** Typed on the icon rather than inferred, because the row now mixes a
 * lucide component with the local brand marks and the inferred union
 * would not survive the filter below. */
type CommunityLink = {
  url: string | null;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
};

/** Website, Discord, Instagram, Telegram — whichever the operator has
 * actually set.
 *
 * Nothing renders until the links arrive and nothing renders for a link
 * that is empty, so this can never show a button that goes nowhere.
 * That is also why the row is not reserved space: an operator with no
 * Discord should see no gap where one would be.
 *
 * Opened in the real browser rather than the app's webview. These are
 * someone else's pages, they need the customer's own logged-in session,
 * and a VPN client should not be in the business of rendering them.
 */
export function CommunityLinks() {
  const [links, setLinks] = useState<AppLinks | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAppLinks().then((result) => {
      // Silent on failure: these are a convenience, and an error here
      // must not push itself in front of someone trying to connect.
      if (!cancelled && result.ok) setLinks(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!links) return null;

  // The three named products get their own marks (see BrandIcons); the
  // website is not a brand, so it keeps the lucide globe rather than
  // being given a logo it does not have.
  //
  // The website is dropped from a store build, and this is the whole
  // reason this component knows what a store build is. Apple rejected
  // 1.0 (0.2.20) under guideline 3.1.1: the site sells subscriptions,
  // so a button in the app that opens it is the app "accessing paid
  // digital content by means other than In-App Purchase" -- the
  // reviewer, on an iPad, only had to tap Website to land on the
  // pricing page.
  //
  // Stripping the checkout from the bundle was not enough, because the
  // guideline is about what the app gives access to, not about which
  // code it ships. Discord, Instagram and Telegram stay: they are
  // community and support, and nothing is sold on them. If any of them
  // ever becomes a sales channel it has to come out of store builds
  // too, for exactly the same reason.
  const entries: CommunityLink[] = [
    ...(IS_STORE_BUILD ? [] : [{ url: links.websiteUrl, icon: Globe, label: "Website" }]),
    { url: links.discordUrl, icon: DiscordIcon, label: "Discord" },
    { url: links.instagramUrl, icon: InstagramIcon, label: "Instagram" },
    { url: links.telegramUrl, icon: TelegramIcon, label: "Telegram" },
  ];

  const shown = entries.filter((entry): entry is CommunityLink & { url: string } =>
    Boolean(entry.url),
  );

  if (shown.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5">
      {shown.map(({ url, icon: Icon, label }) => (
        <button
          key={label}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => void openUrl(url).catch(() => undefined)}
          className="press flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        >
          <Icon className="size-4" />
        </button>
      ))}
    </div>
  );
}
