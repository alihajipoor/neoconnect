import * as grpc from "@grpc/grpc-js";
import type { AgentDuplexCall } from "./agent-messages";

/** Ends an agent's stream so that the agent sees it end.
 *
 * `call.destroy(err)` does not do that. In @grpc/grpc-js (1.14.4 here)
 * the server duplex stream sends its status only from `_final`, which an
 * `'error'` listener reaches through `end()` -- and after `destroy()` the
 * Writable is already errored, so `end()` does nothing. No grpc-status
 * trailers and no RST_STREAM go out, the HTTP/2 stream stays open on a
 * connection that still answers keepalive pings, and the agent waits in
 * `Recv()` forever. That is the 2026-11-14 outage: seven nodes silent for
 * eight minutes after one pool timeout, until the backend was restarted.
 *
 * Emitting `'error'` with a status code is the way grpc-js documents for
 * failing a streaming call: its own listener records the status and calls
 * `end()`, `_final` sends the trailers, and the agent's `Recv()` returns
 * that status at once, so it logs and redials with its backoff.
 *
 * Idempotent. A second call on a stream that has already ended -- or one
 * that something else destroyed, so the documented route cannot run --
 * falls through to `force`. */
export function endAgentCall(call: AgentDuplexCall, code: grpc.status, details: string): void {
  if (!call.destroyed && !call.writableEnded) {
    const err = Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() });
    call.emit("error", err);
    return;
  }
  forceAgentCallStatus(call, code, details);
}

/** The backstop for a call that cannot be ended the documented way: one
 * already destroyed, or one whose `end()` is waiting behind writes the
 * agent never reads. Sends the status on the underlying call directly.
 *
 * This reaches into grpc-js's internals (`ServerDuplexStreamImpl.call`,
 * a `ServerInterceptingCall`), so it is guarded and never throws: if a
 * grpc-js upgrade moves it, this does nothing and the caller's log line
 * still says the stream was given up on. */
export function forceAgentCallStatus(call: AgentDuplexCall, code: grpc.status, details: string): void {
  const inner = (call as unknown as { call?: { sendStatus?: (s: grpc.StatusObject) => void } }).call;
  try {
    inner?.sendStatus?.({ code, details, metadata: new grpc.Metadata() });
  } catch {
    // Already sent, or the transport is already gone. Either way there is
    // nothing more this end can say.
  }
}

/** A database error that says nothing about the node or the stream: the
 * pool was busy, the server was restarting, a connection dropped. Prisma
 * codes P1001 (cannot reach), P1002 (timed out reaching), P1008
 * (operation timed out), P1017 (server closed the connection), P2024
 * (timed out fetching a connection from the pool), P2034 (write conflict
 * or deadlock, retry). */
export function isTransientDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"].includes(code)) return true;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === "string" && /connection pool|Can't reach database|Connection terminated|ECONNRESET/i.test(message);
}
