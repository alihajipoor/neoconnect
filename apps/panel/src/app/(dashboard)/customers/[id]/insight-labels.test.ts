import { describe, expect, it } from "vitest";
import type { CustomerFailureCode, CustomerHistoryEventType, CustomerReportCategory } from "@/lib/types";
import { CATEGORY_LABELS, FAILURE_LABELS, HISTORY_LABELS, failureLabel } from "./insight-labels";

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
  "other",
] as const satisfies readonly CustomerReportCategory[];

const FAILURES = [
  "API_UNREACHABLE",
  "NOT_CARRYING",
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
  "STAFF_ACTION",
] as const satisfies readonly CustomerHistoryEventType[];

type Exhaustive<Union, Listed> = [Exclude<Union, Listed>] extends [never] ? true : false;
const categoriesListed: Exhaustive<CustomerReportCategory, (typeof CATEGORIES)[number]> = true;
const failuresListed: Exhaustive<CustomerFailureCode, (typeof FAILURES)[number]> = true;
const historyListed: Exhaustive<CustomerHistoryEventType, (typeof HISTORY)[number]> = true;

describe("insight labels", () => {
  it("lists every code of each union", () => {
    expect([categoriesListed, failuresListed, historyListed]).toEqual([true, true, true]);
  });

  it.each([
    ["report category", CATEGORIES, CATEGORY_LABELS],
    ["failure code", FAILURES, FAILURE_LABELS],
    ["history event", HISTORY, HISTORY_LABELS],
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
  });
});
