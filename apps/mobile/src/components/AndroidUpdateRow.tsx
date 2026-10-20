import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Download } from "lucide-react";
import { Row } from "@shared/components/ui";
import { useI18n } from "@shared/lib/i18n";
import { checkAndroidUpdate, openAndroidDownload, type AndroidUpdate } from "../lib/android-update";

/** "A newer version is available" in Settings' About, on the direct
 * Android build (lib/android-update.ts). Nothing at all while it is
 * asking, when this is the newest, or when nobody answered: a row that
 * says "up to date" without anything having been compared would be the
 * kind of claim this app does not make. */
export function AndroidUpdateRow() {
  const { t } = useI18n();
  const [update, setUpdate] = useState<AndroidUpdate>({ state: "unknown" });
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((version) => checkAndroidUpdate(version))
      .then(
        (answer) => alive && setUpdate(answer),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, []);

  if (update.state !== "available") return null;

  async function download(path: string) {
    if (opening) return;
    setOpening(true);
    setFailed(false);
    try {
      await openAndroidDownload(path);
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  }

  return (
    <Row
      icon={<Download />}
      label={t("update.androidAvailable", { version: update.version })}
      hint={failed ? <span className="nx-osset">{t("update.androidOpenFailed")}</span> : t("update.androidHint")}
      value={t("update.androidDownload")}
      disabled={opening}
      onClick={() => void download(update.downloadPath)}
    />
  );
}
