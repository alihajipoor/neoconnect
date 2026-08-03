import { MessagesSquare } from "lucide-react";

/** The right-hand pane before a conversation is picked. */
export default function SupportIndexPage() {
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center gap-3 rounded-lg border border-white/8 bg-card/40 px-6 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl bg-primary/15">
        <MessagesSquare className="size-5 text-primary" />
      </div>
      <div>
        <p className="text-sm font-medium">Pick a conversation</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Replies reach the customer in the app and by email.
        </p>
      </div>
    </div>
  );
}
