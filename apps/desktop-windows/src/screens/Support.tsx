import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Activity, Check, ClipboardList, Copy, LifeBuoy, MessagesSquare, Plus, Send } from "lucide-react";
import {
  getSupportOverview,
  getSupportThread,
  openSupportTicket,
  replyToSupportTicket,
} from "../lib/customer";
import {
  collectDiagnostics,
  collectLinuxDiagnostics,
  diagnosticsToText,
  linuxDiagnosticsToText,
  withoutVpnNames,
  type Diagnostics,
  type LinuxDiagnostics,
} from "../lib/repair";
import { loadFlagSet } from "../lib/flag-art";
import { reportedPlatform } from "../lib/attempts";
import { getTokens } from "../lib/session";
import { diagnosticsAllowed } from "../lib/diagnostics-consent";
import { bundleDetails, runServiceCheckNow, type ServiceCheckAnswer } from "../lib/service-check";
import { bundleBody, NOTE_MAX, sendDiagnostics, type BundleParts } from "../lib/diagnostics-bundle";
import { chromiumFromUserAgent, engineLine, webkitGtkVersion, webkitLine, webviewVersion } from "../lib/webview-engine";
import { isLinux, supportsRepair } from "../lib/desktop-platform";
import { supportWords, useI18n } from "../lib/i18n";
import { isMobile } from "../lib/social-auth";
import { failureText } from "../lib/failure-text";
import { swapView } from "../lib/view-transition";
import { motionReduced } from "../lib/motion";
import { formatDate, formatDateTime } from "../lib/locale-format";
import { Card, CardHead, Message, PillButton, Skeleton, Tag } from "../components/ui";
import { Page } from "../components/shell/Page";
import { StillTrying } from "../components/StillTrying";
import { cn } from "../lib/utils";
import type { SupportOverview, SupportThread, SupportTicketSummary } from "../lib/types";

/** How often an open thread re-fetches.
 *
 * Polling, not a socket. There is no realtime infrastructure here and
 * building some for a one-person support desk would be dishonest
 * engineering -- the operator is not sitting there. Ten seconds is
 * responsive enough that a reply arriving while the customer watches
 * feels immediate, and cheap enough that it does not matter. It only
 * runs while a thread is actually open. */
const POLL_MS = 10_000;

type View = { kind: "list" } | { kind: "new" } | { kind: "thread"; id: string };

export function Support({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<SupportOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setShown] = useState<View>({ kind: "list" });
  /** A conversation or a new message slides in; the list slides back. */
  const setView = (next: View) => swapView(() => setShown(next), next.kind === "list" ? "back" : "forward");

  const load = useCallback(async () => {
    const result = await getSupportOverview();
    if (result.ok) {
      setOverview(result.data);
      setError(null);
    } else {
      setError(failureText(result, t));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page
      title={t("support.title")}
      lede={t("support.subtitle")}
      back={() => (view.kind === "list" ? onBack() : setView({ kind: "list" }))}
      backAlways
      data-support
    >
      {error ? <Message tone="danger">{error}</Message> : null}

      {!overview ? (
        <div className="flex flex-col items-center gap-3 py-10">
          <span className="nx-spin" aria-hidden />
          <StillTrying waiting={!error} />
          {error ? null : <Skeleton card rows={2} className="w-full max-w-md" />}
        </div>
      ) : view.kind === "thread" ? (
        <ThreadView id={view.id} onChanged={load} />
      ) : view.kind === "new" ? (
        <NewTicket
          replyWithinHours={overview.replyWithinHours}
          onOpened={async (thread) => {
            await load();
            setView({ kind: "thread", id: thread.id });
          }}
        />
      ) : (
        <TicketList
          overview={overview}
          onOpen={(id) => setView({ kind: "thread", id })}
          onNew={() => setView({ kind: "new" })}
        />
      )}
    </Page>
  );
}

function TicketList({
  overview,
  onOpen,
  onNew,
}: {
  overview: SupportOverview;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="nx-cols">
      <Card className="flex flex-col gap-3">
        <CardHead icon={<MessagesSquare />} title={t("support.conversations")} />
        {overview.tickets.length === 0 ? (
          <div className="flex flex-col gap-1 py-2">
            <p className="nx-strong m-0">{t("support.empty")}</p>
            <p className="nx-csub">{t("support.emptyHint")}</p>
          </div>
        ) : (
          <div className="nx-alist">
            {overview.tickets.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} onOpen={() => onOpen(ticket.id)} />
            ))}
          </div>
        )}
        {overview.acceptingTickets ? (
          <PillButton size="sm" onClick={onNew} className="self-start">
            <Plus aria-hidden />
            {t("support.new")}
          </PillButton>
        ) : (
          /* Says why, rather than hiding the button and leaving them
             hunting for it. The away message is the operator's own
             wording when they set one. */
          <Message tone="neutral">
            <p className="nx-strong">{t("support.closedTitle")}</p>
            <p>{overview.awayMessage?.trim() || t("support.closed")}</p>
          </Message>
        )}
      </Card>

      {/* The snapshot is the Windows service's (`vpn_diagnostics`) or the
          Linux helper's (`vpn_linux_diagnostics`); a desktop without a
          helper (the macOS shell) shows none rather than a button that
          can only fail. */}
      {supportsRepair() ? <DiagnosticsCard /> : null}

      {/* On every platform: the fixed-list test, and the bundle the
          customer may choose to send. */}
      <CheckAndSendCard />
    </div>
  );
}

/** The state snapshot a customer can attach to a message.
 *
 * # Why it is here
 *
 * People describe their machine in prose -- "the internet stopped
 * working after I used it" -- and the questions that would settle it are
 * ones they cannot answer: is an NRPT rule still installed, is there a
 * WireGuard tunnel service registered, are there routes on an adapter
 * whose engine died. Every one of those is a yes/no the service can read
 * in a second, and none of them is visible from an unelevated app, so
 * this asks the service for them.
 *
 * # Why it shows the text before sending it
 *
 * It is never sent automatically and never attached behind the
 * customer's back. Somebody in Iran being asked to paste something about
 * their computer into a support conversation is entitled to read it
 * first, so the whole snapshot is on screen, in a box, and the only
 * action is Copy. The service composes it from named fields only -- no
 * credentials, no keys, no subscription identifiers, no protocol config
 * -- and the account name is stripped out of any path the log quoted.
 */
function DiagnosticsCard() {
  const { t } = useI18n();
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function collect() {
    setBusy(true);
    setFailed(false);
    try {
      setText(await collectPlatformText());
    } catch {
      // Nothing partial. A snapshot missing the half the service
      // answers is worse than none: it would read as "everything is
      // fine here" about the things it could not ask.
      setFailed(true);
      setText(null);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!text) return;
    try {
      await writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The text is on screen and selectable; a clipboard that refuses
      // is not worth an error banner.
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <CardHead icon={<ClipboardList />} title={t("diag.title")} hint={t(supportWords("diag.subtitle", isMobile()))} />

      <p className="nx-csub m-0">{t("diag.privacy")}</p>

      {text ? (
        <>
          {/* Forced left-to-right: it is machine text with Windows paths
              in it, and a right-to-left paragraph reorders those into
              something that no longer matches the customer's machine. */}
          <pre className="nx-diagtext" data-ltr dir="ltr">
            {text}
          </pre>
          <div className="nx-row2">
            <PillButton size="sm" onClick={() => void copy()}>
              {copied ? <Check className="nx-done-in" aria-hidden /> : <Copy aria-hidden />}
              <span key={copied ? "done" : "copy"} className="nx-swap">
                {copied ? t("diag.copied") : t("diag.copy")}
              </span>
            </PillButton>
            <PillButton variant="ghost" size="sm" onClick={() => void collect()} disabled={busy} aria-busy={busy || undefined}>
              {t("diag.collect")}
            </PillButton>
          </div>
        </>
      ) : (
        <PillButton variant="ghost" size="sm" onClick={() => void collect()} disabled={busy} aria-busy={busy || undefined} className="self-start">
          {busy ? <span className="nx-spin" aria-hidden /> : <ClipboardList aria-hidden />}
          {busy ? t("diag.collecting") : t("diag.collect")}
        </PillButton>
      )}

      {failed ? <Message tone="neutral">{t("diag.failed")}</Message> : null}
    </Card>
  );
}

/** The text the Copy button gives, on Windows and Linux: the service's
 * (or the Linux helper's) snapshot, with the app's own version, the flag
 * count and the web engine. Rejects when the service does not answer. */
async function collectPlatformText(forBundle = false): Promise<string> {
  // The app's version comes from here rather than from the service:
  // the two are replaced by different mechanisms -- the installer
  // and the updater -- so they can genuinely differ, and a mismatch
  // between them has explained more than one report.
  // And the flag set is read here, on demand like any row that needs
  // it: the count in the text is the proof that this installed app
  // can read it (see diagnosticsToText).
  // And the Windows web component's version: an old one draws the
  // app from fallbacks, and nothing else in the text would say so.
  // On Linux the helper answers with its own fields, and the text is
  // made from those (`linuxDiagnosticsToText`).
  const linux = isLinux();
  const [snapshot, appVersion, flags, engine] = await Promise.all([
    linux ? collectLinuxDiagnostics() : collectDiagnostics(),
    getVersion().catch(() => "unknown"),
    loadFlagSet(),
    reportedPlatform().then(
      async (platform) =>
        platform === "windows"
          ? engineLine(await webviewVersion(), chromiumFromUserAgent())
          : platform === "linux"
            ? webkitLine(await webkitGtkVersion())
            : undefined,
      () => undefined,
    ),
  ]);
  const flagCount = flags ? Object.keys(flags).length : null;
  const read = forBundle ? withoutVpnNames(snapshot) : snapshot;
  return linux
    ? linuxDiagnosticsToText(read as LinuxDiagnostics, appVersion, flagCount, engine)
    : diagnosticsToText(read as Diagnostics, appVersion, flagCount, engine);
}

/** The connection test and "Send diagnostics to support", on every
 * platform (docs/client-diagnostics.md).
 *
 * The test tries the server's fixed list of well-known services and shows
 * each one as reachable or not, by its label -- no timings, which say
 * nothing to a customer. The send shows exactly what will go before it
 * goes: the facts, the test's results if one was run, and on Windows and
 * Linux the same text the Copy button gives. Never the sites the customer
 * visits, never the local connection log, never engine logs. */
export function CheckAndSendCard() {
  const { t } = useI18n();
  const [check, setCheck] = useState<ServiceCheckAnswer | null>(null);
  const [checking, setChecking] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  // Whether a test's result is reported (diagnostics-consent.ts): said on
  // the card only when it is.
  const [shared, setShared] = useState(false);

  useEffect(() => {
    let live = true;
    void getTokens().then(
      (tokens) => {
        if (live) setSignedIn(Boolean(tokens));
      },
      () => undefined,
    );
    void diagnosticsAllowed().then((allowed) => {
      if (live) setShared(allowed);
    });
    return () => {
      live = false;
    };
  }, []);

  async function test() {
    setChecking(true);
    try {
      setCheck(await runServiceCheckNow());
    } finally {
      setChecking(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3" data-check-send>
      <CardHead icon={<Activity />} title={t("check.title")} hint={t("check.subtitle")} />
      {shared ? <p className="nx-csub">{t("check.shared")}</p> : null}
      <CheckResults answer={check} />
      <PillButton
        variant="ghost"
        size="sm"
        onClick={() => void test()}
        disabled={checking}
        aria-busy={checking || undefined}
        className="self-start"
      >
        {checking ? <span className="nx-spin" aria-hidden /> : <Activity aria-hidden />}
        {checking ? t("check.running") : check?.kind === "done" ? t("check.again") : t("check.run")}
      </PillButton>
      {signedIn ? <SendDiagnostics check={check} /> : null}
    </Card>
  );
}

/** A finished test, said plainly: a calm line, then each service. */
export function CheckResults({ answer }: { answer: ServiceCheckAnswer | null }) {
  const { t } = useI18n();
  if (answer === null) return null;
  if (answer.kind === "off") return <Message tone="neutral">{t("check.off")}</Message>;
  if (answer.kind === "unavailable") return <Message tone="neutral">{t("check.unavailable")}</Message>;
  const ok = answer.results.filter((r) => r.ok).length;
  const total = answer.results.length;
  const untested = answer.listed - total;
  return (
    <div className="flex flex-col gap-2" data-check-results>
      <p className="nx-csub m-0">
        {ok === total && untested === 0 ? t("check.allOk") : t("check.someOk", { ok, total: answer.listed })}
        {answer.via === "tunnel" ? ` ${t("check.viaTunnel")}` : answer.via === "direct" ? ` ${t("check.viaDirect")}` : ""}
      </p>
      <ul className="nx-alist m-0 p-0" style={{ listStyle: "none" }}>
        {answer.results.map((r) => (
          <li key={r.key} className="nx-li" data-reachable={r.ok ? "yes" : "no"}>
            <span className="t">
              <span className="n">{r.label}</span>
            </span>
            {r.ok ? <Tag>{t("check.reachable")}</Tag> : <span className="nx-csub">{t("check.unreachable")}</span>}
          </li>
        ))}
      </ul>
      {untested > 0 ? <p className="nx-csub m-0">{t("check.untested", { count: untested })}</p> : null}
    </div>
  );
}

type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; reference: string } | { kind: "failed" };

/** What goes, built once a send or a look at it needs it, and shown as it
 * is: the body sent is this one with the note in it. */
export function SendDiagnostics({ check, initial }: { check: ServiceCheckAnswer | null; initial?: SendState }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [parts, setParts] = useState<BundleParts | null>(null);
  const [state, setState] = useState<SendState>(initial ?? { kind: "idle" });
  const [copied, setCopied] = useState(false);
  const building = useRef<Promise<BundleParts> | null>(null);

  // A new test result is part of what goes: built again with it.
  useEffect(() => {
    building.current = null;
    setParts(null);
  }, [check]);

  function partsNow(): Promise<BundleParts> {
    building.current ??= gatherBundle(check).then((built) => {
      setParts(built);
      return built;
    });
    return building.current;
  }

  async function send() {
    setState({ kind: "sending" });
    try {
      const result = await sendDiagnostics(bundleBody(await partsNow(), note));
      // Kept on failure: the note is the customer's own words.
      setState(result.ok ? { kind: "sent", reference: result.data.reference } : { kind: "failed" });
    } catch {
      setState({ kind: "failed" });
    }
  }

  async function copy(reference: string) {
    try {
      await writeText(reference);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The code is on screen.
    }
  }

  if (state.kind === "sent") {
    return (
      <Message tone="neutral">
        <p className="nx-strong">{t("send.sentTitle")}</p>
        <p>
          {t("send.reference")}:{" "}
          <span className="nx-strong" data-ltr dir="ltr" data-reference>
            {state.reference}
          </span>
        </p>
        <p>{t("send.referenceHint")}</p>
        <PillButton size="sm" variant="ghost" onClick={() => void copy(state.reference)} className="self-start">
          {copied ? <Check className="nx-done-in" aria-hidden /> : <Copy aria-hidden />}
          {copied ? t("diag.copied") : t("diag.copy")}
        </PillButton>
      </Message>
    );
  }

  const sending = state.kind === "sending";
  return (
    <div className="nx-form" data-send-diagnostics>
      <h3 className="nx-strong m-0">{t("send.title")}</h3>
      <p className="nx-csub m-0">{t("send.subtitle")}</p>
      <div className="nx-field">
        <label htmlFor="diag-note" className="nx-label">
          {t("send.note")}
        </label>
        <textarea
          id="diag-note"
          rows={3}
          value={note}
          maxLength={NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("send.notePlaceholder")}
          className="nx-textarea"
        />
      </div>
      <details
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) void partsNow().catch(() => undefined);
        }}
      >
        <summary className="nx-label">{t("send.preview")}</summary>
        <p className="nx-csub">{t("send.previewHint")}</p>
        {check?.kind !== "done" ? <p className="nx-csub">{t("send.previewCheck")}</p> : null}
        {parts ? (
          <pre className="nx-diagtext" data-ltr dir="ltr" data-preview>
            {previewText(bundleBody(parts, note))}
          </pre>
        ) : (
          <p className="nx-csub">{t("send.previewLoading")}</p>
        )}
      </details>
      {state.kind === "failed" ? <Message tone="danger">{t("send.failed")}</Message> : null}
      <PillButton size="sm" onClick={() => void send()} disabled={sending} aria-busy={sending || undefined} className="self-start">
        <Send className="nx-mir" aria-hidden />
        {sending ? t("send.sending") : t("send.send")}
      </PillButton>
    </div>
  );
}

/** The body as the customer reads it: the facts as sent, and the Copy
 * text as itself rather than as one long escaped line. */
export function previewText(body: ReturnType<typeof bundleBody>): string {
  const { platformDiagnostics, ...rest } = body;
  const facts = JSON.stringify(rest, null, 2);
  return platformDiagnostics ? `${facts}\n\n${platformDiagnostics}` : facts;
}

/** Everything a bundle carries but the note: the facts (with the test's
 * results, if one was run) and, on Windows and Linux, the Copy text --
 * left out when the service does not answer, rather than holding the send. */
export async function gatherBundle(check: ServiceCheckAnswer | null): Promise<BundleParts> {
  const [platform, appVersion, details, platformDiagnostics] = await Promise.all([
    reportedPlatform(),
    getVersion().catch(() => "unknown"),
    bundleDetails(check),
    supportsRepair() ? collectPlatformText(true).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return {
    platform,
    appVersion,
    ...(details ? { details } : {}),
    ...(platformDiagnostics ? { platformDiagnostics } : {}),
  };
}

function TicketRow({ ticket, onOpen }: { ticket: SupportTicketSummary; onOpen: () => void }) {
  const { t, language } = useI18n();
  const statusLabel =
    ticket.status === "OPEN"
      ? t("support.statusOpen")
      : ticket.status === "ANSWERED"
        ? t("support.statusAnswered")
        : t("support.statusResolved");

  return (
    <button type="button" onClick={onOpen} className="nx-li nx-ticket">
      <span className="t">
        <span className="n">{ticket.subject}</span>
        <span className="s">
          {statusLabel} · {formatDate(ticket.lastMessageAt, language)}
        </span>
      </span>
      {/* Only an unread reply gets a marker. A badge on every row is a
          badge on none. */}
      {ticket.unread && ticket.status === "ANSWERED" ? <Tag>{t("support.unread")}</Tag> : null}
    </button>
  );
}

function NewTicket({
  replyWithinHours,
  onOpened,
}: {
  replyWithinHours: number | null;
  onOpened: (thread: SupportThread) => void;
}) {
  const { t } = useI18n();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    const result = await openSupportTicket(subject.trim(), body.trim());
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result, t));
      return;
    }
    onOpened(result.data);
  }

  return (
    <div className="nx-stack">
      <Card className="flex flex-col gap-4">
        {/* Reads as a day rather than "within 24 hours" at the default,
            because that is how people think about it -- and an exact hour
            count implies a precision nobody measures. */}
        <CardHead
          icon={<LifeBuoy />}
          title={t("support.newTitle")}
          hint={
            !replyWithinHours || replyWithinHours === 24
              ? t("support.replyWithinDay")
              : t("support.replyWithin", { hours: replyWithinHours })
          }
        />

        <form onSubmit={submit} className="nx-form">
          <div className="nx-field">
            <label htmlFor="subject" className="nx-label">
              {t("support.subject")}
            </label>
            <input
              id="subject"
              className="nx-input"
              value={subject}
              maxLength={140}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("support.subjectHint")}
            />
          </div>
          <div className="nx-field">
            <label htmlFor="body" className="nx-label">
              {t("support.message")}
            </label>
            <textarea
              id="body"
              rows={5}
              value={body}
              maxLength={5000}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t("support.messageHint")}
              className="nx-textarea"
            />
          </div>
          {error ? <Message tone="danger">{error}</Message> : null}
          <PillButton type="submit" size="sm" disabled={busy || !subject.trim() || !body.trim()} aria-busy={busy || undefined} className="self-start">
            <Send className="nx-mir" aria-hidden />
            {busy ? t("support.sending") : t("support.send")}
          </PillButton>
          <StillTrying waiting={busy} className="text-left" />
        </form>
      </Card>
    </div>
  );
}

function ThreadView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t, language } = useI18n();
  const [thread, setThread] = useState<SupportThread | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  /** The messages the thread opened with. Any after them -- a reply sent,
   * one a poll brought in -- arrives with a rise from its own side. */
  const firstIds = useRef<Set<string> | null>(null);
  if (thread && firstIds.current === null) firstIds.current = new Set(thread.messages.map((message) => message.id));
  const scrolled = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const fetchThread = async () => {
      const result = await getSupportThread(id);
      if (cancelled) return;
      if (result.ok) setThread(result.data);
      else setError(failureText(result, t));
    };
    void fetchThread();
    const timer = setInterval(() => void fetchThread(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [id]);

  // Newest message in view whenever the count changes -- on open, and
  // when a poll brings a reply in.
  // On open at once; a message that arrives after, smoothly.
  useEffect(() => {
    if (!thread) return;
    bottomRef.current?.scrollIntoView({ block: "end", behavior: scrolled.current && !motionReduced() ? "smooth" : "auto" });
    scrolled.current = true;
  }, [thread?.messages.length]);

  async function send() {
    const trimmed = body.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    const result = await replyToSupportTicket(id, trimmed);
    setBusy(false);
    if (!result.ok) {
      setError(failureText(result, t));
      return;
    }
    // Cleared only once the server has it. Clearing first means a
    // failed send silently eats what they wrote.
    setBody("");
    setThread(result.data);
    onChanged();
  }

  if (!thread) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        {error ? (
          <Message tone="danger">{error}</Message>
        ) : (
          <>
            <span className="nx-spin" aria-hidden />
            <StillTrying waiting />
            <Skeleton rows={3} className="w-full max-w-md" />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="nx-stack">
      <Card className="flex flex-col gap-3">
        <div>
          <h2 className="nx-ctitle">{thread.subject}</h2>
          <p className="nx-csub">{t("support.notLive")}</p>
        </div>

        <div className="nx-thread">
          {thread.messages.map((message) => (
            <div
              key={message.id}
              className={cn("nx-bubble", message.fromAdmin ? "them" : "me", firstIds.current && !firstIds.current.has(message.id) && "nx-new")}
            >
              <p dir="auto">{message.body}</p>
              <small>
                {message.fromAdmin ? t("support.team") : t("support.you")} · {formatDateTime(message.createdAt, language)}
              </small>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {error ? <Message tone="danger">{error}</Message> : null}

        {/* Shown even when new conversations are closed: this one is
            already open, and cutting somebody off mid-exchange is worse
            than declining to start. */}
        <div className="nx-compose">
          <textarea
            rows={2}
            value={body}
            maxLength={5000}
            aria-label={t("support.reply")}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t("support.reply")}
            className="nx-textarea"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || !body.trim()}
            className="nx-ibtn"
            aria-label={t("support.send")}
            aria-busy={busy || undefined}
          >
            {busy ? <span className="nx-spin" aria-hidden /> : <Send className="nx-mir" aria-hidden />}
          </button>
        </div>
        <StillTrying waiting={busy} />
      </Card>
    </div>
  );
}

