import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  ArrowLeft,
  Check,
  ClipboardList,
  Clock,
  Copy,
  Loader2,
  LifeBuoy,
  MessagesSquare,
  Plus,
  Send,
} from "lucide-react";
import {
  getSupportOverview,
  getSupportThread,
  openSupportTicket,
  replyToSupportTicket,
} from "../lib/customer";
import { collectDiagnostics, diagnosticsToText } from "../lib/repair";
import { useI18n } from "../lib/i18n";
import { Button, Card, Input, Label } from "../components/ui";
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
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 p-5">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">{t("support.title")}</h1>
          <p className="text-xs text-muted-foreground">{t("support.subtitle")}</p>
        </div>
        <Button
          variant="ghost"
          onClick={() => (view.kind === "list" ? onBack() : setView({ kind: "list" }))}
          className="shrink-0 gap-2 border border-white/10"
        >
          <ArrowLeft className="size-4" />
          {t("nav.back")}
        </Button>
      </header>

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {!overview ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
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
    </div>
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
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {overview.acceptingTickets ? (
        <Button onClick={onNew} className="gap-2 self-start">
          <Plus className="size-4" />
          {t("support.new")}
        </Button>
      ) : (
        /* Says why, rather than hiding the button and leaving them
           hunting for it. The away message is the operator's own
           wording when they set one. */
        <Card className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/8 text-muted-foreground">
            <Clock className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">{t("support.closedTitle")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {overview.awayMessage?.trim() || t("support.closed")}
            </p>
          </div>
        </Card>
      )}

      <DiagnosticsCard />

      {overview.tickets.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-10 text-center">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <MessagesSquare className="size-5" />
          </div>
          <p className="text-sm font-medium">{t("support.empty")}</p>
          <p className="text-xs text-muted-foreground">{t("support.emptyHint")}</p>
        </Card>
      ) : (
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {overview.tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} onOpen={() => onOpen(ticket.id)} />
          ))}
        </div>
      )}
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
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-highlight/15 text-highlight">
          <ClipboardList className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t("diag.title")}</p>
          <p className="text-xs text-muted-foreground">{t("diag.subtitle")}</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">{t("diag.privacy")}</p>

      {text ? (
        <>
          {/* Forced left-to-right: it is machine text with Windows paths
              in it, and a right-to-left paragraph reorders those into
              something that no longer matches the customer's machine. */}
          <pre
            className="max-h-56 overflow-auto rounded-lg border border-white/8 bg-black/30 p-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-muted-foreground"
            data-ltr
            dir="ltr"
          >
            {text}
          </pre>
          <div className="flex gap-2">
            <Button onClick={() => void copy()} className="gap-2">
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? t("diag.copied") : t("diag.copy")}
            </Button>
            <Button variant="ghost" onClick={() => void collect()} disabled={busy} className="gap-2 border border-white/10">
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("diag.collect")}
            </Button>
          </div>
        </>
      ) : (
        <Button onClick={() => void collect()} disabled={busy} className="gap-2 self-start">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ClipboardList className="size-4" />}
          {busy ? t("diag.collecting") : t("diag.collect")}
        </Button>
      )}

      {failed ? <p className="text-xs text-destructive">{t("diag.failed")}</p> : null}
    </Card>
  );
}

function TicketRow({ ticket, onOpen }: { ticket: SupportTicketSummary; onOpen: () => void }) {
  const { t } = useI18n();
  const statusLabel =
    ticket.status === "OPEN"
      ? t("support.statusOpen")
      : ticket.status === "ANSWERED"
        ? t("support.statusAnswered")
        : t("support.statusResolved");

  return (
    <button
      type="button"
      onClick={onOpen}
      className="press flex items-center gap-3 rounded-xl border border-white/8 bg-white/3 px-3.5 py-3 text-start transition-colors hover:border-white/15 hover:bg-white/6"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{ticket.subject}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {statusLabel} · {new Date(ticket.lastMessageAt).toLocaleDateString()}
        </p>
      </div>
      {/* Only an unread reply gets a marker. A badge on every row is a
          badge on none. */}
      {ticket.unread && ticket.status === "ANSWERED" && (
        <span className="shrink-0 rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
          {t("support.unread")}
        </span>
      )}
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
      setError(result.error);
      return;
    }
    onOpened(result.data);
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <LifeBuoy className="size-4" />
        </div>
        <div>
          <p className="text-sm font-semibold">{t("support.newTitle")}</p>
          {/* Reads as a day rather than "within 24 hours" at the
              default, because that is how people think about it -- and
              an exact hour count implies a precision nobody measures. */}
          <p className="text-xs text-muted-foreground">
            {!replyWithinHours || replyWithinHours === 24
              ? t("support.replyWithinDay")
              : t("support.replyWithin", { hours: replyWithinHours })}
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="subject">{t("support.subject")}</Label>
          <Input
            id="subject"
            value={subject}
            maxLength={140}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t("support.subjectHint")}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="body">{t("support.message")}</Label>
          <textarea
            id="body"
            rows={5}
            value={body}
            maxLength={5000}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("support.messageHint")}
            className="w-full resize-none rounded-lg border border-white/10 bg-white/4 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
          />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy || !subject.trim() || !body.trim()} className="gap-2 self-start">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          {busy ? t("support.sending") : t("support.send")}
        </Button>
      </form>
    </Card>
  );
}

function ThreadView({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { t } = useI18n();
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
      else setError(result.error);
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
      setError(result.error);
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
      <div className="flex flex-1 items-center justify-center">
        {error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div>
        <p className="text-sm font-semibold">{thread.subject}</p>
        <p className="text-xs text-muted-foreground">{t("support.notLive")}</p>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto rounded-xl border border-white/8 bg-white/2 p-3">
        {thread.messages.map((message) => (
          <div
            key={message.id}
            className={cn("flex", message.fromAdmin ? "justify-start" : "justify-end")}
          >
            <div
              className={cn(
                "max-w-[82%] rounded-2xl px-3.5 py-2.5",
                message.fromAdmin
                  ? "rounded-bl-md bg-white/8"
                  : "rounded-br-md bg-primary/20",
              )}
            >
              <p className="text-sm whitespace-pre-wrap">{message.body}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">
                {message.fromAdmin ? t("support.team") : t("support.you")} ·{" "}
                {new Date(message.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Shown even when new conversations are closed: this one is
          already open, and cutting somebody off mid-exchange is worse
          than declining to start. */}
      <div className="flex items-end gap-2">
        <textarea
          rows={2}
          value={body}
          maxLength={5000}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={t("support.reply")}
          className="w-full resize-none rounded-lg border border-white/10 bg-white/4 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
        />
        <Button
          onClick={() => void send()}
          disabled={busy || !body.trim()}
          className="size-10 shrink-0 justify-center p-0"
          aria-label={t("support.send")}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
  );
}
