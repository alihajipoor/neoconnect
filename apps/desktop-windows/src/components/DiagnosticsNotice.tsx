import { openUrl } from "@tauri-apps/plugin-opener";
import { Info } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { PillButton, TextLink } from "./ui";

const PRIVACY_URL = "https://neoxify.net/privacy";
const PRIVACY_URL_FA = "https://neoxify.net/fa/privacy";

/** The desktop's in-app notice about the fuller diagnostics
 * (docs/client-diagnostics.md, Rollout 2; lib/diagnostics-consent.ts).
 *
 * On the Dashboard, beside the update notice, until it is accepted -- not
 * a gate in front of the app: someone who opened it to connect is not
 * stopped, and nothing it describes is sent until they press OK. The
 * phones say the same in the prominent disclosure every customer accepts
 * before the app opens. */
export function DiagnosticsNotice({ onAccept }: { onAccept: () => void }) {
  const { t, language } = useI18n();
  return (
    <div className="nx-upd nx-dnotice" role="note" data-diagnostics-notice>
      <p className="flex items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0 text-cobalt-ink" aria-hidden />
        <span>
          <strong>{t("notice.diagTitle")}</strong> {t("notice.diagBody")}
        </span>
      </p>
      <span className="flex items-center gap-3">
        <PillButton variant="ghost" size="sm" onClick={onAccept}>
          {t("notice.diagOk")}
        </PillButton>
        <TextLink onClick={() => void openUrl(language === "fa" ? PRIVACY_URL_FA : PRIVACY_URL).catch(() => undefined)}>
          {t("disclosure.privacyLink")}
        </TextLink>
      </span>
    </div>
  );
}
