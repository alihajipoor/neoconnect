import { useState } from "react";
import { ArrowLeft, Check, KeyRound, Languages, Loader2 } from "lucide-react";
import { changePassword } from "../lib/auth";
import { LANGUAGES, useI18n, type Language } from "../lib/i18n";
import { Button, Card, Input, Label } from "../components/ui";

/** The app's settings surface.
 *
 * Currently just the password form, but deliberately a screen rather
 * than a dialog hung off the Dashboard: split-tunnel ("Custom" mode) and
 * update preferences both land here next, and the Dashboard is meant to
 * stay a single Connect button rather than accumulating controls. */
export function Settings({ onBack }: { onBack: () => void }) {
  const { t, language, setLanguage } = useI18n();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = next.length > 0 && next.length < 8;
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 8 && next === confirm && !busy;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    setBusy(true);

    const result = await changePassword(current, next);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    // Cleared rather than left filled: this screen stays open afterwards,
    // and leaving a password sitting in an input is the kind of thing
    // someone walks away from.
    setCurrent("");
    setNext("");
    setConfirm("");
    setDone(true);
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-xl flex-col gap-4 p-5">
      <div>
        <h1 className="text-base font-semibold">{t("settings.title")}</h1>
        <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
              <Languages className="size-4" />
            </div>
            <div>
              <p className="text-sm font-semibold">{t("settings.language")}</p>
              <p className="text-xs text-muted-foreground">{t("settings.languageHint")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            {(Object.keys(LANGUAGES) as Language[]).map((code) => (
              <Button
                key={code}
                variant={code === language ? "default" : "ghost"}
                onClick={() => setLanguage(code)}
                className={code === language ? "flex-1 justify-center" : "flex-1 justify-center border border-white/10"}
              >
                {LANGUAGES[code].nativeLabel}
              </Button>
            ))}
          </div>
        </Card>

        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <KeyRound className="size-4" />
            </div>
            <div>
              <p className="text-sm font-semibold">{t("settings.changePassword")}</p>
              <p className="text-xs text-muted-foreground">{t("settings.changePasswordHint")}</p>
            </div>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="current">{t("settings.currentPassword")}</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="next">{t("settings.newPassword")}</Label>
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              {tooShort ? (
                <p className="text-xs text-muted-foreground">{t("settings.tooShort")}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm">{t("settings.confirmPassword")}</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch ? (
                <p className="text-xs text-destructive">{t("settings.mismatch")}</p>
              ) : null}
            </div>

            {error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}

            {done ? (
              <p className="flex items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success">
                <Check className="size-3.5" />
                {t("settings.passwordChanged")}
              </p>
            ) : null}

            <Button type="submit" disabled={!canSubmit} className="justify-center gap-2">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? t("settings.changing") : t("settings.changePassword")}
            </Button>
          </form>
        </Card>
      </div>

      <Button variant="ghost" onClick={onBack} className="w-full justify-center gap-2 border border-white/10">
        <ArrowLeft className="size-4" />
        {t("nav.back")}
      </Button>
    </div>
  );
}
