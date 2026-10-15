import { useEffect, useReducer, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, KeyRound, Route } from "lucide-react";
import {
  checkTunnelForRelayMode,
  onRelayChange,
  onRelayConsentAsked,
  refreshRelayStatus,
  relayModeActive,
  relayStatus,
  TUNNEL_WATCH_MS,
  type RelayStatus,
} from "../lib/last-resort";
import { useI18n } from "../lib/i18n";
import { Button, Card } from "./ui";

/** The relay of last resort's screens (docs/relay-last-resort.md, section
 * 8), shared by both clients: the consent prompt, the backup-route chip,
 * and the recovery code shown once.
 *
 * Calm, as every state on these screens has to be (ui-state-calm): the
 * chip is neutral and steady for the whole of relay mode and never
 * touches the orb or the headline; nothing here uses a warning colour,
 * because nothing here is a fault the customer can act on. */

/** Relay mode and the relay's own status, kept current: re-read whenever
 * last-resort.ts says something changed, and every half minute for the
 * mode's fifteen-minute expiry, which nothing announces. */
export function useRelayMode(): { active: boolean; status: RelayStatus | null } {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = onRelayChange(refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);
  return { active: relayModeActive(), status: relayStatus() };
}

/** What the network is doing, in the only words the evidence allows: the
 * national intranet only when the owner has declared one (I4, F6) --
 * anything else, including our own traffic from Iran dropping, is the
 * usual routes being blocked on this network. */
export function relayDetail(status: RelayStatus | null): "relay.intranet" | "relay.blocked" {
  return status?.intranet === true ? "relay.intranet" : "relay.blocked";
}

/** Asks, once per install, whether the backup server may be used, before
 * any byte is sent to it (R1.4). Mounted once, at the root of each app;
 * last-resort.ts asks through it only for a request the customer just
 * made, never for a background one. Two plain answers and no dismissal:
 * a decline is remembered, so it has to be a decision. */
export function BackupRouteConsent() {
  const { t } = useI18n();
  const [asking, setAsking] = useState<{ resolve: (granted: boolean) => void; reject: () => void } | null>(null);
  const pending = useRef(asking);
  pending.current = asking;

  useEffect(() => {
    const off = onRelayConsentAsked(
      () =>
        new Promise<boolean>((resolve, reject) => {
          setAsking({ resolve, reject: () => reject(new Error("closed")) });
        }),
    );
    return () => {
      off();
      // Gone without an answer: nobody was asked, which is not a decline.
      pending.current?.reject();
    };
  }, []);

  if (asking === null) return null;
  const answer = (granted: boolean) => {
    asking.resolve(granted);
    setAsking(null);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="backup-route-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
    >
      <Card className="flex w-full max-w-sm flex-col gap-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Route className="size-4" />
          </div>
          <h2 id="backup-route-title" className="text-sm font-semibold">
            {t("relay.consentTitle")}
          </h2>
        </div>
        <p className="text-sm text-muted-foreground">{t("relay.consentBody")}</p>
        <p className="text-xs text-muted-foreground">{t("relay.consentLater")}</p>
        <div className="flex gap-2">
          <Button onClick={() => answer(true)} className="flex-1 justify-center">
            {t("relay.consentAccept")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => answer(false)}
            className="flex-1 justify-center border border-white/10"
          >
            {t("relay.consentDecline")}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** "App data: backup route", for as long as relay mode lasts, and nothing
 * otherwise. Above every screen, in the app's root, so neither dashboard's
 * orb, headline or connection state is touched by it: the relay carries
 * the app's own requests, never the customer's traffic. */
export function BackupRouteChip() {
  const { t } = useI18n();
  const { active, status } = useRelayMode();

  // The relay's own word on the intranet, asked once each time relay mode
  // starts. Background: it never prompts, and a failure leaves the plain
  // "blocked" wording.
  useEffect(() => {
    if (active && relayStatus() === null) void refreshRelayStatus();
  }, [active]);

  // Not a word about the backup route over a tunnel (R1.7). A tunnel ends
  // relay mode, and on the phone -- or for one brought up outside the app
  // -- only a look at the tunnel finds it: once as the chip appears, then
  // every few seconds while it shows.
  useEffect(() => {
    if (!active) return;
    void checkTunnelForRelayMode();
    const watch = setInterval(() => void checkTunnelForRelayMode(), TUNNEL_WATCH_MS);
    return () => clearInterval(watch);
  }, [active]);

  if (!active) return null;
  return (
    <div className="pointer-events-none flex shrink-0 justify-center px-4 pt-2">
      <span
        title={t(relayDetail(status))}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-muted-foreground"
      >
        <Route className="size-3.5" />
        {t("relay.chip")}
      </span>
    </div>
  );
}

/** A recovery code, shown once (R3.2, R4.3). The app keeps no copy: the
 * backend stores only its hash, and this screen is the only time the code
 * exists anywhere the customer can read it. So it says so, offers a copy,
 * and moves on only when told the code has been saved. */
export function RecoveryCodeNotice({
  code,
  lead,
  onSaved,
}: {
  code: string;
  /** A sentence above the save prompt -- what just happened. */
  lead?: string;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await writeText(code);
      setCopied(true);
    } catch {
      // A clipboard that refuses costs a copy, not the code: it is on
      // screen to be written down.
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <KeyRound className="size-4" />
        </div>
        <p className="text-sm font-semibold">{t("recovery.title")}</p>
      </div>
      {lead ? <p className="text-sm text-muted-foreground">{lead}</p> : null}
      <p className="text-sm">{t("recovery.save")}</p>
      <p
        dir="ltr"
        className="rounded-lg border border-white/10 bg-black/20 px-3 py-3 text-center font-mono text-base tracking-widest select-all"
        data-recovery-code
      >
        {code}
      </p>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => void copy()} className="gap-2 border border-white/10">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? t("recovery.copied") : t("recovery.copy")}
        </Button>
        <Button onClick={onSaved} className="flex-1 justify-center">
          {t("recovery.saved")}
        </Button>
      </div>
    </div>
  );
}
