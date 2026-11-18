import type { ClientAttemptKind, ClientAttemptOutcome } from "./types";

// In a plain module rather than the Client Attempts view, so a Server
// Component can read them: a constant imported from a "use client" file
// arrives on the server as a client reference, not as the object.

/** How each outcome reads to an operator, and how loudly.
 *
 * The wording matters more than usual here. The enum names are precise
 * and unreadable at a glance, and the whole value of this page is
 * telling two failures apart quickly: a filtered address and a wrong
 * password are both "could not sign in" to the customer and mean
 * completely different things to us.
 */
export const OUTCOMES: Record<
  ClientAttemptOutcome,
  { label: string; hint: string; variant: "success" | "destructive" | "highlight" | "secondary" }
> = {
  SUCCESS: { label: "Worked", hint: "Nothing to do.", variant: "success" },
  CONTROL_PLANE_UNREACHABLE: {
    label: "No control plane",
    hint: "Every API address failed or timed out. The signature of a filtered address.",
    variant: "destructive",
  },
  NOT_CARRYING_TRAFFIC: {
    label: "Tunnel carried nothing",
    hint: "The engine came up but no traffic crossed it. Usually a blocked protocol or port.",
    variant: "destructive",
  },
  ENGINE_FAILED: {
    label: "Engine failed",
    hint: "The VPN engine itself refused to start. A client-side fault, not a network one.",
    variant: "destructive",
  },
  REJECTED: {
    label: "Refused",
    hint: "The server answered and said no: wrong password, unverified email, quota gone.",
    variant: "highlight",
  },
  PERMISSION_DENIED: {
    label: "Permission denied",
    hint: "The customer declined the VPN permission prompt.",
    variant: "secondary",
  },
  OTHER: { label: "Other", hint: "See the reason on the row.", variant: "secondary" },
};

export const KINDS: Record<ClientAttemptKind, string> = {
  REGISTER: "Sign-up",
  SIGN_IN: "Sign-in",
  CONNECT: "Connect",
  SESSION: "Stayed up",
  SERVICE_CHECK: "Service check",
};
