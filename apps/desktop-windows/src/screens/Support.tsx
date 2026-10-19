import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, ClipboardList, Copy, LifeBuoy, MessagesSquare, Plus, Send } from "lucide-react";
import {
  getSupportOverview,
  getSupportThread,
  openSupportTicket,
  replyToSupportTicket,
} from "../lib/customer";
import { collectDiagnostics, diagnosticsToText } from "../lib/repair";
import { useI18n } from "../lib/i18n";
import { failureText } from "../lib/failure-text";
import { formatDate, formatDateTime } from "../lib/locale-format";
import { Card, CardHead, Message, PillButton, Tag } from "../components/ui";
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
  const [view, setView] = useState<View>({ kind: "list" });

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

      <DiagnosticsCard />
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
      // The app's version comes from here rather than from the service:
      // the two are replaced by different mechanisms -- the installer
      // and the updater -- so they can genuinely differ, and a mismatch
      // between them has explained more than one report.
      const [snapshot, appVersion] = await Promise.all([
        collectDiagnostics(),
        getVersion().catch(() => "unknown"),
      ]);
      setText(diagnosticsToText(snapshot, appVersion));
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
      <CardHead icon={<ClipboardList />} title={t("diag.title")} hint={t("diag.subtitle")} />

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
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? t("diag.copied") : t("diag.copy")}
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
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
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
            <div key={message.id} className={cn("nx-bubble", message.fromAdmin ? "them" : "me")}>
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

