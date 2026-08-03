"use client";

import { useState, useTransition } from "react";
import { Check, CornerUpLeft, RotateCcw, Send } from "lucide-react";
import { toast } from "sonner";
import type { SupportTicket } from "@/lib/types";
import { replyToTicket, setTicketStatus } from "./actions";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

/** One conversation, as a chat.
 *
 * Reads as chat because that is what a customer expects support to look
 * like; it is a ticket underneath, which is what lets the operator
 * close the laptop without breaking a promise. */
export function TicketThread({ ticket }: { ticket: SupportTicket }) {
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  function send() {
    const trimmed = body.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const result = await replyToTicket(ticket.id, trimmed);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      // Cleared only after the server took it. Clearing optimistically
      // means a failed send silently eats what was typed.
      setBody("");
      toast.success("Reply sent");
    });
  }

  function changeStatus(status: "RESOLVED" | "OPEN") {
    startTransition(async () => {
      const result = await setTicketStatus(ticket.id, status);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(status === "RESOLVED" ? "Marked resolved" : "Reopened");
    });
  }

  const messages = ticket.messages ?? [];

  return (
    <div className="flex h-full flex-col rounded-lg border border-white/8 bg-card/40">
      <header className="flex flex-wrap items-center gap-3 border-b border-white/8 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{ticket.subject}</h2>
            <Badge variant={ticket.status === "OPEN" ? "default" : "outline"}>
              {ticket.status === "OPEN"
                ? "Needs reply"
                : ticket.status === "ANSWERED"
                  ? "Answered"
                  : "Resolved"}
            </Badge>
          </div>
          {ticket.customer && (
            <p className="truncate text-xs text-muted-foreground">{ticket.customer.email}</p>
          )}
        </div>
        {ticket.status === "RESOLVED" ? (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => changeStatus("OPEN")}>
            <RotateCcw /> Reopen
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => changeStatus("RESOLVED")}
          >
            <Check /> Mark resolved
          </Button>
        )}
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn("flex", message.fromAdmin ? "justify-end" : "justify-start")}
          >
            <div
              className={cn(
                "max-w-[80%] rounded-2xl px-3.5 py-2.5",
                message.fromAdmin
                  ? "rounded-br-md bg-primary/20 text-foreground"
                  : "rounded-bl-md bg-white/6 text-foreground",
              )}
            >
              {/* pre-wrap, not a markdown renderer: whatever the customer
                  typed is shown exactly as typed, and their line breaks
                  survive without letting their text become markup. */}
              <p className="text-sm whitespace-pre-wrap">{message.body}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {message.fromAdmin ? "You" : "Customer"} ·{" "}
                {new Date(message.createdAt).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-white/8 p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line -- the
              // convention every chat client already taught them.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Write a reply — the customer gets it in the app and by email"
            className="min-h-11 resize-none"
          />
          <Button size="icon" disabled={pending || !body.trim()} onClick={send} aria-label="Send">
            <Send />
          </Button>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <CornerUpLeft className="size-3" />
          Enter to send, Shift+Enter for a new line.
        </p>
      </div>
    </div>
  );
}
