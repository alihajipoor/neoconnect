import { useState } from "react";
import { ArrowLeft, Check, KeyRound, Loader2 } from "lucide-react";
import { changePassword } from "../lib/auth";
import { Button, Card, Input, Label } from "../components/ui";

/** The app's settings surface.
 *
 * Currently just the password form, but deliberately a screen rather
 * than a dialog hung off the Dashboard: split-tunnel ("Custom" mode) and
 * update preferences both land here next, and the Dashboard is meant to
 * stay a single Connect button rather than accumulating controls. */
export function Settings({ onBack }: { onBack: () => void }) {
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
    <div className="flex h-full flex-col gap-4 p-5">
      <div>
        <h1 className="text-base font-semibold">Settings</h1>
        <p className="text-xs text-muted-foreground">Manage your account.</p>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto">
        <Card className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <KeyRound className="size-4" />
            </div>
            <div>
              <p className="text-sm font-semibold">Change password</p>
              <p className="text-xs text-muted-foreground">You&apos;ll stay signed in on this device.</p>
            </div>
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="current">Current password</Label>
              <Input
                id="current"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="next">New password</Label>
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
              {tooShort ? (
                <p className="text-xs text-muted-foreground">At least 8 characters.</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm">Confirm new password</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch ? (
                <p className="text-xs text-destructive">These don&apos;t match.</p>
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
                Password changed. Any other devices have been signed out.
              </p>
            ) : null}

            <Button type="submit" disabled={!canSubmit} className="justify-center gap-2">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {busy ? "Changing..." : "Change password"}
            </Button>
          </form>
        </Card>
      </div>

      <Button variant="ghost" onClick={onBack} className="w-full justify-center gap-2 border border-white/10">
        <ArrowLeft className="size-4" />
        Back
      </Button>
    </div>
  );
}
