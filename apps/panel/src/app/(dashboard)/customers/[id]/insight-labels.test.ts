import { describe, expect, it } from "vitest";
import type {
  ClientAttemptKind,
  CustomerFailureCode,
  CustomerHistoryEventType,
  CustomerReportCategory,
  ServiceCheckStage,
} from "@/lib/types";
import { KINDS } from "@/lib/attempt-labels";
import {
  CATEGORY_LABELS,
  FAILURE_LABELS,
  HISTORY_LABELS,
  NET_TYPE_LABELS,
  PRIVATE_DNS_LABELS,
  SESSION_END_LABELS,
  STAGE_LABELS,
  TUNNEL_MODE_LABELS,
  VIA_LABELS,
  failureLabel,
  labelOf,
  serviceOutcome,
  stageLabel,
  type CheckVia,
  type NetType,
  type PrivateDnsMode,
  type SessionEndCause,
  type TunnelMode,
} from "./insight-labels";

// Every code the backend can emit, listed by hand. The `Exhaustive`
// checks below fail the typecheck if the union in lib/types.ts gains a
// code that is missing from these lists, so the run-time test cannot
// pass on a stale list.
const CATEGORIES = [
  "connect",
  "reconnect",
  "api",
  "config",
  "cancelled",
  "session",
  "signin",
  "register",
  "check",
  "other",
] as const satisfies readonly CustomerReportCategory[];

const FAILURES = [
  "API_UNREACHABLE",
  "NOT_CARRYING",
  "NO_HANDSHAKE_OR_TRAFFIC",
  "TOO_SLOW",
  "NO_RESPONSE_UDP_BLOCKED",
  "DID_NOT_COMPLETE",
  "SERVER_NOT_REACHED",
  "NO_NETWORK",
  "SERVICE_NOT_ANSWERING",
  "ADAPTER_MISSING",
  "ENGINE_FAILED",
  "PERMISSION_DENIED",
  "OTHER_VPN_ACTIVE",
  "CANCELLED_BY_CUSTOMER",
  "SUBSCRIPTION_INACTIVE",
  "DATA_CAP_REACHED",
  "DEVICE_LIMIT",
  "WRONG_PASSWORD",
  "EMAIL_EXISTS",
  "BAD_REFERRAL_CODE",
  "CODE_NOT_ACCEPTED",
  "SESSION_REFUSED",
  "CUSTOM_MODE_FAILED",
  "IKEV2_REFUSED",
  "TUNNEL_DROPPED",
  "RECONNECT_GAVE_UP",
  "APPLE_ACCOUNT_NEEDED",
  "OPENVPN_DID_NOT_CONNECT",
  "SERVER_SETTINGS_UNUSABLE",
  "UNKNOWN",
] as const satisfies readonly CustomerFailureCode[];

const HISTORY = [
  "ACCOUNT_CREATED",
  "EMAIL_VERIFIED",
  "IDENTITY_LINKED",
  "DEVICE_SIGNED_IN",
  "DEVICE_SIGNED_OUT",
  "SUBSCRIPTION_STARTED",
  "SUBSCRIPTION_ENDED",
  "CODE_REDEEMED",
  "PAYMENT",
  "SUPPORT_TICKET",
  "FIRST_CONNECT",
  "DIAGNOSTICS_SENT",
  "STAFF_ACTION",
] as const satisfies readonly CustomerHistoryEventType[];

const KIND_CODES = ["REGISTER", "SIGN_IN", "CONNECT", "SESSION", "SERVICE_CHECK"] as const satisfies readonly ClientAttemptKind[];
const STAGES = ["dns", "connect", "tls", "http", "ok"] as const satisfies readonly ServiceCheckStage[];
const NET_TYPES = ["wifi", "cellular", "ethernet", "other", "none", "unknown"] as const satisfies readonly NetType[];
const PRIVATE_DNS = ["off", "auto", "host", "unknown"] as const satisfies readonly PrivateDnsMode[];
const TUNNEL_MODES = ["full", "custom", "gaming"] as const satisfies readonly TunnelMode[];
const SESSION_ENDS = ["disconnected", "lost", "replaced", "app_closed", "unknown"] as const satisfies readonly SessionEndCause[];
const VIAS = ["tunnel", "direct"] as const satisfies readonly CheckVia[];

type Exhaustive<Union, Listed> = [Exclude<Union, Listed>] extends [never] ? true : false;
const categoriesListed: Exhaustive<CustomerReportCategory, (typeof CATEGORIES)[number]> = true;
const failuresListed: Exhaustive<CustomerFailureCode, (typeof FAILURES)[number]> = true;
const historyListed: Exhaustive<CustomerHistoryEventType, (typeof HISTORY)[number]> = true;
const diagnosticsListed: [
  Exhaustive<ClientAttemptKind, (typeof KIND_CODES)[number]>,
  Exhaustive<ServiceCheckStage, (typeof STAGES)[number]>,
  Exhaustive<NetType, (typeof NET_TYPES)[number]>,
  Exhaustive<PrivateDnsMode, (typeof PRIVATE_DNS)[number]>,
  Exhaustive<TunnelMode, (typeof TUNNEL_MODES)[number]>,
  Exhaustive<SessionEndCause, (typeof SESSION_ENDS)[number]>,
  Exhaustive<CheckVia, (typeof VIAS)[number]>,
] = [true, true, true, true, true, true, true];

describe("insight labels", () => {
  it("lists every code of each union", () => {
    expect([categoriesListed, failuresListed, historyListed, ...diagnosticsListed]).toEqual(Array(10).fill(true));
  });

  it.each([
    ["report category", CATEGORIES, CATEGORY_LABELS],
    ["failure code", FAILURES, FAILURE_LABELS],
    ["history event", HISTORY, HISTORY_LABELS],
    ["report kind", KIND_CODES, KINDS],
    ["service-check stage", STAGES, STAGE_LABELS],
    ["network type", NET_TYPES, NET_TYPE_LABELS],
    ["private DNS mode", PRIVATE_DNS, PRIVATE_DNS_LABELS],
    ["tunnel mode", TUNNEL_MODES, TUNNEL_MODE_LABELS],
    ["session end cause", SESSION_ENDS, SESSION_END_LABELS],
    ["service-check route", VIAS, VIA_LABELS],
  ] as const)("has a plain label for every %s", (_name, codes, labels) => {
    for (const code of codes) {
      const label = (labels as Record<string, string>)[code];
      expect(label, code).toBeTruthy();
      expect(label.trim(), code).toBe(label);
      // A label is words, not the code again.
      expect(label, code).not.toBe(code);
    }
    expect(Object.keys(labels).sort()).toEqual([...codes].sort());
  });

  it("shows an unknown code as itself rather than failing", () => {
    expect(failureLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(stageLabel("quic")).toBe("quic");
    expect(labelOf(NET_TYPE_LABELS, "satellite")).toBe("satellite");
    expect(labelOf(NET_TYPE_LABELS, undefined)).toBeNull();
  });

  it("says a service result in plain words", () => {
    expect(serviceOutcome(true, "ok")).toBe("reachable");
    expect(serviceOutcome(false, "dns")).toBe("failed at name lookup");
    expect(serviceOutcome(false, "tls")).toBe("failed at secure handshake");
    expect(serviceOutcome(false, "http")).toBe("failed at the reply");
    // A failure that names no stage, or the success stage, says only that.
    expect(serviceOutcome(false, "")).toBe("failed");
    expect(serviceOutcome(false, "ok")).toBe("failed");
  });
});
