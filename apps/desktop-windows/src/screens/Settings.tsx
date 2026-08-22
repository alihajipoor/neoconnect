import { useState, type ReactNode } from "react";
import {
  AppWindow,
  ArrowLeft,
  Check,
  ChevronRight,
  Gift,
  KeyRound,
  Languages,
  LifeBuoy,
  Loader2,
  Trash2,
} from "lucide-react";
import { changePassword, deleteAccount } from "../lib/auth";
import { LANGUAGES, useI18n, type Language } from "../lib/i18n";
import { Button, Card, Input, Label } from "../components/ui";
import { cn } from "../lib/utils";

/** The app's settings surface.
 *
 * A section rail with one pane, not a scrolling stack of cards. The
 * stack was the original shape and it did not survive contact with a
 * third section: Custom mode's app list is tall, so the password form
 * sat below the fold behind an inner scrollbar, and nothing on screen
 * suggested there was more to find.
 *
 * Same structure the admin panel settled on for its own settings, for
 * the same reason -- and worth keeping the two consistent, since they
 * are the same product.
 */
type SectionId = "custom" | "general" | "account";

export function Settings({
  onBack,
  onOpenReferrals,
  onOpenSupport,
  onLoggedOut,
  customSection,
}: {
  onBack: () => void;
  onOpenReferrals: () => void;
  onOpenSupport: () => void;
  /** Where to send someone whose account no longer exists.
   *
   * The same callback the app already uses for signing out, because the
   * end state is identical -- no session, back at the login screen. The
   * difference is only that there is nothing to sign back into. */
  onLoggedOut: () => void;
  /** Custom mode's pane, supplied by the platform rather than imported.
   *
   * Language and password are the same product on every platform and
   * live here. Custom mode is not: Windows drives WinDivert and a
   * transparent proxy and picks .exe paths from a file dialog, while
   * Android hands package names to VpnService.Builder and picks them
   * from the installed-app list. Same feature, nothing shared but the
   * slot it sits in. */
  customSection: ReactNode;
}) {
  const { t } = useI18n();
  const [section, setSection] = useState<SectionId>("custom");

  const sections: { id: SectionId; label: string; icon: typeof AppWindow }[] = [
    // Custom mode leads: it is the only one that changes how the VPN
    // behaves, and the only one anybody opens this screen twice for.
    { id: "custom", label: t("settings.custom"), icon: AppWindow },
    { id: "general", label: t("settings.general"), icon: Languages },
    { id: "account", label: t("settings.account"), icon: KeyRound },
  ];

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 p-5">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">{t("settings.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("settings.subtitle")}</p>
        </div>
        {/* Up here rather than a full-width button pinned to the bottom.
            The old one cost a whole row of vertical space on every
            section to serve the one moment somebody wants to leave. */}
        <Button variant="ghost" onClick={onBack} className="shrink-0 gap-2 border border-white/10">
          <ArrowLeft className="size-4" />
          {t("nav.back")}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row sm:gap-5">
        {/* A column when there is room, a scrolling row when there is
            not -- the window is resizable and gets narrow. */}
        <nav
          aria-label={t("settings.sections")}
          className="flex shrink-0 gap-1 overflow-x-auto sm:w-44 sm:flex-col sm:overflow-visible"
        >
          {sections.map(({ id, label, icon: Icon }) => {
            const active = id === section;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "press relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                  // A flat tint was the only thing marking the current
                  // pane, and against a dark violet background a tint is
                  // nearly nothing -- the rail read as five identical
                  // rows. The bar is drawn as a pseudo-element pinned to
                  // the inline start so it costs no width and lands on
                  // the correct edge in Persian, where a real border
                  // would have shifted every label by two pixels and sat
                  // on the wrong side.
                  active
                    ? "bg-primary/15 text-foreground before:absolute before:inset-y-1.5 before:start-0 before:w-0.5 before:rounded-full before:bg-primary"
                    : "text-muted-foreground hover:bg-white/6 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4", active && "text-primary")} />
                {label}
              </button>
            );
          })}

          <div className="mx-1 hidden h-px bg-white/8 sm:my-1 sm:block" />

          {/* Below the divider because it leaves this screen rather than
              switching the pane -- a different kind of thing, and the
              chevron says so. */}
          <button
            type="button"
            onClick={onOpenReferrals}
            className="press flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
          >
            <Gift className="size-4" />
            <span className="flex-1 text-start">{t("referrals.title")}</span>
            <ChevronRight className="hidden size-3.5 shrink-0 sm:block rtl:rotate-180" />
          </button>
          <button
            type="button"
            onClick={onOpenSupport}
            className="press flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-white/6 hover:text-foreground"
          >
            <LifeBuoy className="size-4" />
            <span className="flex-1 text-start">{t("support.title")}</span>
            <ChevronRight className="hidden size-3.5 shrink-0 sm:block rtl:rotate-180" />
          </button>
        </nav>

        {/* Only the pane scrolls, and only when its own content is tall
            -- which in practice is Custom mode with a long app list. */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {section === "custom" ? customSection : null}
          {section === "general" ? <LanguageSection /> : null}
          {section === "account" ? (
            <div className="flex flex-col gap-4">
              <PasswordSection />
              <DeleteAccountSection onDeleted={onLoggedOut} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LanguageSection() {
  const { t, language, setLanguage } = useI18n();

  return (
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
            className={
              code === language
                ? "flex-1 justify-center"
                : "flex-1 justify-center border border-white/10"
            }
          >
            {LANGUAGES[code].nativeLabel}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function PasswordSection() {
  const { t } = useI18n();
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
          {mismatch ? <p className="text-xs text-destructive">{t("settings.mismatch")}</p> : null}
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
  );
}

/** Deleting your own account.
 *
 * Present because both stores require it of any app offering account
 * creation -- Apple 5.1.1(v), Play's data deletion policy -- and absent
 * from neither build, since it is not a transaction and no store
 * objects to it.
 *
 * Two-step, and the second step asks for the word rather than another
 * button. A second button is a reflex; typing something is a decision.
 * This is the one action in the app that cannot be undone, and the
 * confirmation names what actually goes rather than asking "are you
 * sure" about an unspecified thing.
 */
function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Matched case-insensitively and trimmed: the point is deliberateness,
  // not typing accuracy, and failing someone on a capital letter after
  // they decided to leave is just rude.
  const phrase = t("settings.deleteConfirmWord");
  const matches = typed.trim().toLowerCase() === phrase.toLowerCase();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const result = await deleteAccount();
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    // No success state on this screen -- there is no account left for it
    // to belong to. Straight back to the login screen.
    onDeleted();
  }

  return (
    <Card className="flex flex-col gap-3 border-destructive/30">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
          <Trash2 className="size-4" />
        </div>
        <div>
          <p className="text-sm font-semibold">{t("settings.deleteAccount")}</p>
          <p className="text-xs text-muted-foreground">{t("settings.deleteAccountHint")}</p>
        </div>
      </div>

      {confirming ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          {/* Named, not vague. Someone deleting an account with paid time
              left should learn that here and not afterwards. */}
          <p className="text-xs text-muted-foreground">{t("settings.deleteWarning")}</p>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delete-confirm">{t("settings.deleteTypeToConfirm", { word: phrase })}</Label>
            <Input
              id="delete-confirm"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoFocus
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              className="flex-1 justify-center border border-white/10"
              onClick={() => {
                setConfirming(false);
                setTyped("");
                setError(null);
              }}
              disabled={busy}
            >
              {t("settings.deleteCancel")}
            </Button>
            <Button
              type="submit"
              variant="destructive"
              className="flex-1 justify-center gap-2"
              disabled={!matches || busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? t("settings.deleting") : t("settings.deleteConfirm")}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="ghost"
          className="justify-center gap-2 border border-destructive/40 text-destructive"
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" />
          {t("settings.deleteAccount")}
        </Button>
      )}
    </Card>
  );
}
