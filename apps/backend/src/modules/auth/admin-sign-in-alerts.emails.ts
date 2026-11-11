import { operationsEmail, opsTime } from "../email/templates";

/** What the sign-in alerts say: the subject, the text, its html and the
 * webhook's one line. Pure, so the wording can be read and rendered
 * without a database. English: they go to the owner. */

export interface SignInAlert {
  subject: string;
  text: string;
  html: string;
  webhook: string;
}

interface Admin {
  email: string;
  role: string;
}

/** Where two-factor is turned on, and the password changed. */
const PANEL = { path: "/settings/account", label: "Open account security" };

/** An admin finished signing in. `where` is the address and, when known,
 * its network: "203.0.113.10 (Example ISP, DE)". */
export function signInAlert(admin: Admin, where: string, withMfa: boolean, now: Date): SignInAlert {
  const factor = withMfa ? "with two-factor" : "with a password only -- this account has no two-factor";
  const text =
    `${admin.email} (${admin.role}) signed in to the Neoxify admin panel ${factor}, ` +
    `at ${now.toISOString()} from ${where}.\n\n` +
    "If this was not you: change the password now, then sign out of the panel, " +
    "which ends every session of this account. Turning on two-factor stops a stolen password on its own.";
  return {
    subject: `Neoxify panel: sign-in to ${admin.email}`,
    text,
    webhook: `[admin] Sign-in: ${admin.email} from ${where}`,
    html: operationsEmail({
      // A sign-in is routine. One on a password alone is the kind a
      // stolen password produces, so it is the one worth a second look.
      severity: withMfa ? "info" : "warning",
      title: `Admin sign-in: ${admin.email}`,
      facts: [
        { label: "What", value: "A completed sign-in to the admin panel" },
        { label: "Account", value: `${admin.email} (${admin.role})` },
        { label: "When", value: opsTime(now) },
        { label: "From", value: where },
        {
          label: "Second step",
          value: withMfa ? "A two-factor code" : "None: password only. This account has no two-factor.",
        },
        {
          label: "What to do",
          value:
            "If this was you, nothing. If it was not: change the password now, then sign out of the panel, " +
            "which ends every session of this account.",
        },
      ],
      panel: PANEL,
      // Advice for the account that has not done it yet.
      note: withMfa ? undefined : "Turning on two-factor stops a stolen password on its own.",
    }),
  };
}

/** A run of wrong passwords against an admin account. */
export function wrongPasswordsAlert(admin: Admin, failures: number, where: string): SignInAlert {
  const text =
    `${failures} wrong passwords for ${admin.email} (${admin.role}) on the Neoxify admin panel ` +
    `in the last few minutes, the latest from ${where}. Nobody has signed in with them. ` +
    "Each attempt costs the guesser more, but only two-factor makes a guessed password useless.";
  return {
    subject: `Neoxify panel: ${failures} wrong passwords for ${admin.email}`,
    text,
    webhook: `[admin] ${failures} wrong passwords for ${admin.email}, latest from ${where}`,
    html: operationsEmail({
      severity: "warning",
      title: `${failures} wrong passwords for ${admin.email}`,
      facts: [
        { label: "What", value: `${failures} wrong passwords in the last few minutes` },
        { label: "Account", value: `${admin.email} (${admin.role})` },
        { label: "Latest from", value: where },
        { label: "How sure", value: "Counted by the sign-in guard. Nobody has signed in with them." },
        {
          label: "What to do",
          value:
            "Nothing has to be done now: each attempt costs the guesser more. Only two-factor makes a guessed " +
            "password useless.",
        },
      ],
      panel: PANEL,
    }),
  };
}
