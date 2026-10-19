import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Eye, EyeOff, Info } from "lucide-react";
import { useCopy } from "./copy";

/**
 * The few controls the sign-in screens are built from, in the Pearl Glass
 * look (auth.css). Plain elements with the native semantics left alone:
 * `required`, `type="email"`, `minLength` and `autocomplete` all stay
 * the browser's, exactly as on the apps' screens.
 */

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: string;
  /** A line under the field, tied to it with aria-describedby. */
  hint?: string;
};

export function TextField({ id, label, hint, className, ...input }: InputProps) {
  return (
    <div className="pa-field">
      <label htmlFor={id} className="pa-label">
        {label}
      </label>
      <input
        id={id}
        className={className ? `pa-input ${className}` : "pa-input"}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...input}
      />
      {hint ? (
        <p id={`${id}-hint`} className="pa-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A password field with a Show toggle.
 *
 * The toggle only changes how the field draws what is typed: the value,
 * the autocomplete hint and the form it submits with are the same either
 * way. It is a real button after the input in the tab order, labelled
 * once and marked pressed while the password shows, which is how a
 * screen reader expects a toggle to speak. */
export function PasswordField({ id, label, hint, ...input }: Omit<InputProps, "type">) {
  const copy = useCopy();
  const [shown, setShown] = useState(false);
  return (
    <div className="pa-field">
      <label htmlFor={id} className="pa-label">
        {label}
      </label>
      <div className="pa-pw">
        <input
          id={id}
          type={shown ? "text" : "password"}
          className="pa-input"
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          {...input}
        />
        <button
          type="button"
          className="pa-eye"
          aria-label={copy.showPassword}
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="pa-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** The cobalt pill. `busy` keeps the label the caller chose ("Signing
 * in...") and adds a quiet spinner beside it -- never a different claim. */
export function PrimaryButton({
  busy,
  children,
  className,
  ...button
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return (
    <button className={className ? `pa-btn ${className}` : "pa-btn"} aria-busy={busy || undefined} {...button}>
      {busy ? <span className="pa-spin" aria-hidden="true" /> : null}
      <span>{children}</span>
    </button>
  );
}

export function SecondaryButton({ className, ...button }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={className ? `pa-btn-2 ${className}` : "pa-btn-2"} {...button} />;
}

/** A button that reads as a link: the screens' "Forgot your password?",
 * "Register" and "Back to sign in". Underlined, so it is never told apart
 * from the text around it by colour alone. */
export function TextButton({ className, ...button }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={className ? `pa-link ${className}` : "pa-link"} {...button} />;
}

const ICONS = {
  danger: AlertCircle,
  ok: CheckCircle2,
  neutral: Info,
} as const;

/** A sentence about what happened, with its tone carried by an icon as
 * well as colour. Errors are announced (`role="alert"`); confirmations and
 * notes politely (`role="status"`). Neutral is for what is nobody's fault
 * -- the network, the backup route -- and never wears a warning colour. */
export function Message({
  tone,
  children,
  ...rest
}: {
  tone: keyof typeof ICONS;
  children: ReactNode;
} & Record<`data-${string}`, unknown>) {
  const Icon = ICONS[tone];
  return (
    <div className="pa-msg" data-tone={tone} role={tone === "danger" ? "alert" : "status"} {...rest}>
      <Icon className="pa-msg-icon" aria-hidden="true" />
      <p>{children}</p>
    </div>
  );
}
