// Small, dependency-free UI primitives -- deliberately not a full
// shadcn/Radix setup like the panel has.
//
// Two generations live here. `Button`, `Input`, `Label`, `Card` and `Stat`
// are the ones the screens were first written with; the Pearl Glass
// primitives further down are the redesign's (design-system.md, section 4).
// Inside a `PearlScope` -- every redesigned page and sign-in screen -- the
// old four draw in the Pearl look, so the shared cards drawn inside those
// pages (Custom mode, Gaming mode, the recovery code, Repair) match them
// without being rewritten. Outside one -- the phone's own dashboard, which
// keeps its look until its phase of the redesign -- they draw as before.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type Ref,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, Info } from "lucide-react";
import { useI18n } from "../lib/i18n";
import { formatNumber } from "../lib/locale-format";
import { cn } from "../lib/utils";

const PearlContext = createContext(false);

/** Marks a subtree as redesigned: the older primitives inside it draw in
 * the Pearl look. */
export function PearlScope({ children }: { children: ReactNode }) {
  return <PearlContext.Provider value>{children}</PearlContext.Provider>;
}

/** Whether this is drawn inside a redesigned page. */
export function usePearl(): boolean {
  return useContext(PearlContext);
}

/** The old dark theme's white-on-dark borders and fills, and its sizes,
 * which mean nothing on pearl: left out there, where the Pearl classes
 * carry their own. */
const LEGACY_SURFACE =
  /^(?:border|border-(?:white|black|destructive|success|primary|warning|highlight)\/\S+|(?:hover:|focus:)?(?:bg|border)-(?:white|black)\/\S+|rounded-(?:md|lg|xl)|h-9|h-10|px-3|px-4|py-2|text-sm|shadow-\[\S*\])$/;

function pearlClasses(className: string | undefined): string {
  return (className ?? "")
    .split(/\s+/)
    .filter((token) => token && !LEGACY_SURFACE.test(token))
    .join(" ");
}

export function Button({
  className,
  variant = "default",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "destructive" | "ghost" | "outline";
}) {
  const pearl = usePearl();
  if (pearl) {
    const look = variant === "default" ? "primary" : variant === "destructive" ? "danger" : "ghost";
    return <button className={cn("nx-btn sm nx-bx", look, pearlClasses(className))} {...props} />;
  }
  // `default` is a gradient from the primary to `--brand-2` rather than a flat
  // fill, and lifts on hover -- a solid rectangle was the single biggest
  // reason the app read as a generic template. The glow uses colour-mix
  // so it stays tied to the token instead of a hardcoded rgba that
  // silently drifts if --primary ever changes.
  const variants = {
    default:
      "bg-[linear-gradient(120deg,var(--primary),color-mix(in_oklab,var(--primary)_55%,var(--brand-2)))] text-primary-foreground shadow-[0_4px_16px_-6px_var(--primary)] hover:shadow-[0_8px_26px_-8px_var(--primary)] hover:brightness-110",
    destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
    ghost: "bg-transparent text-foreground hover:bg-white/8",
    outline:
      "border border-white/12 bg-white/[0.02] text-foreground hover:border-white/20 hover:bg-white/6",
  };
  return (
    <button
      className={cn(
        "press inline-flex h-9 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const pearl = usePearl();
  if (pearl) return <input className={cn("nx-input", pearlClasses(className))} {...props} />;
  return (
    <input
      className={cn(
        "h-10 w-full rounded-lg border border-input bg-white/[0.03] px-3 text-sm outline-none transition-[border-color,box-shadow,background-color] placeholder:text-muted-foreground hover:border-white/16 focus-visible:border-ring focus-visible:bg-white/[0.05] focus-visible:ring-[3px] focus-visible:ring-ring/25",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  const pearl = usePearl();
  if (pearl) return <label className={cn("nx-label", className)} {...props} />;
  return <label className={cn("text-sm font-medium text-foreground", className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const pearl = usePearl();
  if (pearl) return <div className={cn("nx-card nx-pcard", pearlClasses(className))} {...props} />;
  // The top hairline is what separates a "surface" from a "box with a
  // border": it reads as light catching an edge, which is the treatment
  // the website uses on its own cards.
  // shrink-0 matters more than it looks. A flex item shrinks by default,
  // and these sit in scrolling flex columns, so once the content is
  // taller than the window every card gets squeezed -- and because of
  // the overflow-hidden below, whatever ends up past the new shorter
  // edge is simply clipped away rather than scrolled to.
  //
  // That silently ate the Crypto and Card buttons on the plans screen as
  // soon as a second plan existed: the cards rendered 65px shorter than
  // their content and the buttons sat 50px below the visible edge, still
  // in the DOM, invisible and unclickable. It looked like the buttons
  // were missing rather than like a layout problem, and it came and went
  // with the number of plans. A card should be its content's height and
  // let the container scroll.
  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden rounded-xl border border-border bg-card/70 p-4 shadow-[var(--surface-shadow)]",
        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/15 before:to-transparent",
        className,
      )}
      {...props}
    />
  );
}

/** A labelled figure -- the app's unit of "one fact worth glancing at".
 *
 * Exists so the Dashboard's stat row is one component repeated rather
 * than three hand-built divs that drift apart, and so any later screen
 * showing a metric gets the same treatment for free.
 */
/** A labelled fact about the connection, optionally the control that
 * changes it.
 *
 * `onClick` is what fixes a real and repeated support problem: these
 * tiles carry `surface-interactive`, so they highlight under the cursor
 * and read as buttons, while the actual "change server" control sat
 * further down the page showing the very same value. Customers tapped
 * the tile, nothing happened, and they reported the app as broken --
 * reasonably, because a thing that lights up when you point at it has
 * promised something.
 *
 * So a tile that shows a changeable fact now *is* the control, with a
 * chevron and an action word to say so out loud rather than relying on
 * the hover state alone. A tile with no `onClick` stays a plain div and
 * loses the interactive styling, so nothing lights up that cannot be
 * pressed. */
export function Stat({
  icon,
  label,
  value,
  className,
  onClick,
  actionLabel,
  disabledReason,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  className?: string;
  onClick?: () => void;
  /** Shown next to the chevron -- "Change", "Pick". */
  actionLabel?: string;
  /** When set, the tile is inert and this explains why. Saying it beats
   * a dead control: an unexplained disabled button is the same dead end
   * as a fake one. */
  disabledReason?: string;
}) {
  const body = (
    <>
      <span className="flex items-center gap-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="flex items-center justify-between gap-1">
        <span className="truncate text-xs leading-tight font-semibold text-foreground">{value}</span>
        {onClick && !disabledReason ? (
          // Deliberately a size below the caption above it. Three of
          // these fit across a 400px window, and set at the same 10px
          // the action took enough of the row that the value -- the
          // fact the tile exists to show -- was what truncated: a
          // customer on fi-finland read "fi-finl...". Shrinking the
          // word that never changes buys back the room for the one
          // that does, and the tile's violet fill and border were
          // always the louder half of "this is pressable" anyway.
          <span className="flex shrink-0 items-center gap-px text-[9px] font-semibold text-primary">
            {actionLabel}
            {/* Mirrored under Persian: a chevron means "onward", and
                onward is leftward in an RTL layout. */}
            <ChevronRight className="size-2.5 rtl:rotate-180" />
          </span>
        ) : null}
      </span>
    </>
  );

  const shell = "flex min-w-0 flex-col gap-1.5 rounded-lg border px-2.5 py-2 text-start";

  if (!onClick) {
    return (
      <div className={cn(shell, "border-white/8 bg-white/[0.025]", className)}>{body}</div>
    );
  }

  return (
    <button
      type="button"
      onClick={disabledReason ? undefined : onClick}
      disabled={Boolean(disabledReason)}
      title={disabledReason}
      aria-label={disabledReason ? `${label}: ${disabledReason}` : undefined}
      className={cn(
        shell,
        // A brighter border and the primary ring on hover, because this
        // one really is pressable -- the difference from a plain tile has
        // to be visible before the press, not after.
        "surface-interactive border-primary/25 bg-primary/[0.06] transition-colors",
        "hover:border-primary/50 hover:bg-primary/10",
        "focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:border-white/8 disabled:bg-white/[0.025] disabled:opacity-70",
        className,
      )}
    >
      {body}
    </button>
  );
}

// --- Pearl Glass primitives ------------------------------------------------
// Styled by pearl.css. The screens not yet redesigned keep the primitives
// above; everything below is the redesign's (design-system.md, section 4).

/** The floating control layer: frosted where the effects tier allows it,
 * solid otherwise (`data-glass` on <html>). Text-carrying glass is
 * `strong`. Nothing else -- rows, cards, banners -- is glass. */
export function Glass({
  as: Tag = "div",
  strong,
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "div" | "aside" | "section" | "nav"; strong?: boolean }) {
  return <Tag className={cn("nx-glass", strong && "strong", className)} {...props} />;
}

/** A pill button: primary (cobalt), ghost, or busy. The connect control's
 * own pill is ConnectOrb's, which adds the press light, the width morph
 * and the double-press guard; this one is for everything else. */
export function PillButton({
  variant = "primary",
  size,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost"; size?: "sm"; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button type="button" className={cn("nx-btn", variant, size, className)} {...props}>
      <span className="lt" aria-hidden />
      {children}
    </button>
  );
}

/** A segmented control, fully round, with a sliding thumb that travels
 * toward the inline end in either language.
 *
 * `locked` keeps it readable and focusable but inert, with the reason as
 * its tooltip -- no opacity drop, which failed contrast at 70%. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  locked = false,
  lockedReason,
  size,
  className,
}: {
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  locked?: boolean;
  lockedReason?: string;
  size?: "sm";
  className?: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  return (
    <div
      role="group"
      aria-label={label}
      title={locked ? lockedReason : undefined}
      className={cn("nx-seg", size, locked && "locked", className)}
      style={{ "--n": options.length, "--k": index } as React.CSSProperties}
    >
      <span className="thumb" aria-hidden />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          aria-disabled={locked || undefined}
          title={locked ? lockedReason : undefined}
          onClick={() => {
            if (!locked && option.value !== value) onChange(option.value);
          }}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A switch: 51x31, cobalt when on, the thumb stretching while pressed. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** The accessible name, when no visible label names it (`labelledBy`). */
  label?: string;
  labelledBy?: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      className="nx-sw"
      onClick={() => onChange(!checked)}
    />
  );
}

/** A neutral message at the top of a page: an icon, a bold title and the
 * sentence. Neutral on purpose -- the blocked-network banner is not an
 * alarm: the customer can still connect. */
export function Banner({
  title,
  icon,
  children,
  className,
}: {
  title?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("nx-banner", className)}>
      {icon ?? <Info aria-hidden />}
      <div className="t">
        {title ? <b>{title}</b> : null}
        {children}
      </div>
    </div>
  );
}

/** One line under the hero: neutral, or a real problem in caution or
 * danger ink. Red only for real leaks. */
export function Note({
  tone = "plain",
  icon,
  children,
}: {
  tone?: "plain" | "info" | "caution" | "danger";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <p className={cn("nx-note m-0", tone !== "plain" && tone)}>
      {icon}
      <span>{children}</span>
    </p>
  );
}

/** A small neutral label: Beta, Current, Recommended. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="nx-tagn">{children}</span>;
}

/** Collapsed detail behind a counted toggle, opening on the snappy spring. */
export function Disclosure({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { language } = useI18n();
  return (
    <>
      <button type="button" className="nx-dtoggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        {label}
        {count !== undefined ? <span className="cnt nx-num">{formatNumber(count, language)}</span> : null}
        <ChevronDown aria-hidden />
      </button>
      <div id={id} className={cn("nx-dpanel", open && "open")}>
        <div aria-hidden={!open} inert={!open ? true : undefined}>
          {children}
        </div>
      </div>
    </>
  );
}

// --- Forms, messages and lists (Settings, the other tabs, sign-in) ----------

type FieldInputProps = InputHTMLAttributes<HTMLInputElement> & {
  id: string;
  label: ReactNode;
  /** A line under the field, tied to it with aria-describedby. */
  hint?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

/** A labelled text field: the label above, a hint below. Native semantics
 * left alone -- `required`, `type`, `autocomplete` stay the browser's. */
export function TextField({ id, label, hint, className, ...input }: FieldInputProps) {
  return (
    <div className="nx-field">
      <label htmlFor={id} className="nx-label">
        {label}
      </label>
      <input id={id} className={cn("nx-input", className)} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? (
        <p id={`${id}-hint`} className="nx-fhint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A password field with a Show toggle.
 *
 * The toggle changes only how the field draws what is typed. It is a real
 * button after the input, marked pressed while the password shows. Left to
 * right in both languages, like the address and the codes: a password is
 * typed as characters, and a right-to-left field reorders a shown one into
 * something nobody typed. Hidden again the moment its form is submitted,
 * before the request goes out, so it is never remembered as ordinary form
 * history. */
export function PasswordField({ id, label, hint, ...input }: Omit<FieldInputProps, "type">) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const form = field.current?.form;
    if (!form) return;
    const hide = () => flushSync(() => setShown(false));
    form.addEventListener("submit", hide, { capture: true });
    return () => form.removeEventListener("submit", hide, { capture: true });
  }, []);
  return (
    <div className="nx-field">
      <label htmlFor={id} className="nx-label">
        {label}
      </label>
      <div className="nx-pw" dir="ltr">
        <input
          ref={field}
          id={id}
          dir="ltr"
          type={shown ? "text" : "password"}
          className="nx-input"
          aria-describedby={hint ? `${id}-hint` : undefined}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          {...input}
        />
        <button
          type="button"
          className="nx-eye"
          aria-label={t("auth.showPassword")}
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        </button>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="nx-fhint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

const MESSAGE_ICONS = { danger: AlertCircle, ok: CheckCircle2, neutral: Info } as const;

/** A sentence about what happened, its tone carried by an icon as well as
 * colour. Errors are announced (`role="alert"`), the rest politely.
 * Neutral is for what is nobody's fault -- the network, the backup route --
 * and never wears a warning colour. */
export function Message({
  tone,
  children,
  className,
  ...rest
}: {
  tone: keyof typeof MESSAGE_ICONS;
  children: ReactNode;
  className?: string;
} & Record<`data-${string}`, unknown>) {
  const Icon = MESSAGE_ICONS[tone];
  return (
    <div className={cn("nx-msg", className)} data-tone={tone} role={tone === "danger" ? "alert" : "status"} {...rest}>
      <Icon className="nx-msg-i" aria-hidden />
      <div className="t">{children}</div>
    </div>
  );
}

/** A button that reads as a link: underlined, so it is never told apart
 * from the text around it by colour alone. */
export function TextLink({
  strong,
  className,
  ...button
}: ButtonHTMLAttributes<HTMLButtonElement> & { strong?: boolean }) {
  return <button type="button" className={cn("nx-tlnk", strong && "strong", className)} {...button} />;
}

/** "Not built yet": beside a setting the app cannot do, which is drawn
 * disabled -- never as a control that looks like it works. */
export function NotBuiltTag() {
  const { t } = useI18n();
  return <span className="nx-ntag">{t("set.notBuilt")}</span>;
}

/** A settings group: a solid card with its title inside it, never on the
 * scene, and its rows divided by hairlines. */
export function ListGroup({
  title,
  children,
  className,
  ...rest
}: { title: ReactNode; children: ReactNode; className?: string } & Record<`data-${string}`, unknown>) {
  const id = useId();
  return (
    <section className={cn("nx-group", className)} aria-labelledby={id} {...rest}>
      <h2 className="nx-gt" id={id}>
        {title}
      </h2>
      <div className="nx-rows">{children}</div>
    </section>
  );
}

/** One row of a settings group: an optional icon tile, the label and its
 * hint, and on the inline end a value, a control or a chevron. A row with
 * `onClick` is a button and leads somewhere (the chevron mirrors in RTL);
 * one without is information. */
export function Row({
  icon,
  label,
  hint,
  value,
  control,
  onClick,
  danger,
  tag,
  wrap,
  labelId,
  hintId,
  disabled,
  className,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  control?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  tag?: ReactNode;
  /** The control sits under the label rather than beside it. */
  wrap?: boolean;
  labelId?: string;
  hintId?: string;
  disabled?: boolean;
  className?: string;
}) {
  const body = (
    <>
      {icon ? (
        <span className="nx-ic" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="t">
        <span className={cn("n", danger && "danger")} id={labelId}>
          {label}
          {tag ? <> {tag}</> : null}
        </span>
        {hint ? (
          <span className="s" id={hintId}>
            {hint}
          </span>
        ) : null}
      </span>
      {(value !== undefined && value !== null) || onClick || control ? (
        <span className="tail">
          {value !== undefined && value !== null ? <span className="v">{value}</span> : null}
          {control}
          {onClick ? <ChevronRight className="chev nx-mir" aria-hidden /> : null}
        </span>
      ) : null}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cn("nx-li", wrap && "wrap", className)} onClick={onClick} disabled={disabled}>
        {body}
      </button>
    );
  }
  return <div className={cn("nx-li", wrap && "wrap", className)}>{body}</div>;
}

/** A row with a switch, labelled by the row's label and described by its
 * hint. A setting the app cannot do yet passes `notBuilt`: the switch is
 * off and disabled, and the row says so. */
export function SwitchRow({
  icon,
  label,
  hint,
  checked,
  onChange,
  disabled,
  notBuilt,
  tag,
}: {
  icon?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  notBuilt?: boolean;
  tag?: ReactNode;
}) {
  const id = useId();
  return (
    <Row
      icon={icon}
      label={label}
      hint={hint}
      labelId={`${id}-l`}
      hintId={hint ? `${id}-h` : undefined}
      tag={notBuilt ? <NotBuiltTag /> : tag}
      control={
        <Switch
          checked={notBuilt ? false : checked}
          onChange={(next) => onChange?.(next)}
          disabled={disabled || notBuilt}
          labelledBy={`${id}-l`}
          describedBy={hint ? `${id}-h` : undefined}
        />
      }
    />
  );
}

/** A small rounded tile for a heading's icon. */
export function IconTile({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  return (
    <span className={cn("nx-ic", tone)} aria-hidden>
      {children}
    </span>
  );
}

/** A card's heading: an icon tile, the title and a line under it. */
export function CardHead({ icon, title, hint, tone }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode; tone?: "danger" }) {
  return (
    <div className="nx-chead">
      {icon ? <IconTile tone={tone}>{icon}</IconTile> : null}
      <div className="t">
        <h3>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </div>
    </div>
  );
}
