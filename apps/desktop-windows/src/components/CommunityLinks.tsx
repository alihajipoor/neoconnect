import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Camera, Globe, MessageCircle, Send } from "lucide-react";
import { getAppLinks } from "../lib/customer";
import type { AppLinks } from "../lib/types";

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

  const entries = [
    { url: links.websiteUrl, icon: Globe, label: "Website" },
    { url: links.discordUrl, icon: MessageCircle, label: "Discord" },
    // Camera, not a brand glyph: lucide dropped its brand icons over
    // trademark concerns, and the label carries the meaning anyway.
    { url: links.instagramUrl, icon: Camera, label: "Instagram" },
    { url: links.telegramUrl, icon: Send, label: "Telegram" },
  ].filter((entry): entry is { url: string; icon: typeof Globe; label: string } =>
    Boolean(entry.url),
  );

  if (entries.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5">
      {entries.map(({ url, icon: Icon, label }) => (
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
