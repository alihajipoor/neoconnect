import type {
  InsightApp,
  InsightCredentials,
  InsightFailure,
  InsightFinding,
  InsightNetwork,
  InsightVoucher,
} from "./customer-insight.types";

/** What the insight page says first: observations over the counts below,
 * each with the counts it rests on.
 *
 * The rule for every line here is the product's: say what the data
 * shows and nothing more. "0 of 4 connection attempts succeeded on this
 * network" is an observation; "this network blocks us" is a guess the
 * reports cannot prove -- the apps see a timeout, never its cause. So
 * findings compare counts and name them, and leave the cause to staff. */

/** A share of others at or above this reads as "others get through". */
export const OTHERS_OK_SHARE = 0.6;
/** At or below this, as "others do not either". */
export const OTHERS_FAIL_SHARE = 0.25;
/** Background API reports before it is worth a line. */
export const API_UNREACHABLE_OFTEN = 3;
/** Rungs or reports that came up and carried nothing, before a line. */
export const NOT_CARRYING_OFTEN = 3;
/** HEALTHY needs at least this many attempts, and this share landed. */
export const HEALTHY_MIN_TRIED = 3;
export const HEALTHY_SHARE = 0.9;

export interface FindingsInput {
  now: number;
  windowDays: number;
  emailVerifiedAt: string | null;
  apps: InsightApp[];
  tried: number;
  succeeded: number;
  networks: InsightNetwork[];
  failures: InsightFailure[];
  credentials: InsightCredentials[];
  vouchers: InsightVoucher[];
  /** The newest report of any kind ever kept, for NO_ATTEMPTS. */
  lastReport: { at: string; category: string } | null;
}

const netName = (n: Pick<InsightNetwork, "asn" | "name">) =>
  n.asn === null ? "an unknown network" : n.name ? `${n.name} (AS${n.asn})` : `AS${n.asn}`;

export function findingsFor(input: FindingsInput): InsightFinding[] {
  const out: InsightFinding[] = [];
  const days = `the last ${input.windowDays} day${input.windowDays === 1 ? "" : "s"}`;

  // Connecting at all.
  if (input.tried > 0 && input.succeeded === 0) {
    out.push({
      severity: "problem",
      code: "NEVER_CONNECTED",
      title: "No connection attempt succeeded",
      detail: `0 of ${input.tried} connection attempts in ${days} succeeded.`,
    });
  }
  if (input.tried === 0) {
    out.push({
      severity: "info",
      code: "NO_ATTEMPTS",
      title: "No connection attempts reported",
      detail: input.lastReport
        ? `The apps reported no connection attempt in ${days}. The newest report kept of any kind is from ${input.lastReport.at} (${input.lastReport.category}).`
        : `The apps reported no connection attempt in ${days}, and no report from this customer's apps is kept at all.`,
    });
  }

  // Networks.
  const known = input.networks.filter((n) => n.asn !== null);
  const failing = known.filter((n) => n.tried >= 2 && n.succeeded === 0);
  const working = input.networks.filter((n) => n.succeeded > 0);
  for (const bad of failing) {
    const good = working.find((n) => n.asn !== bad.asn);
    if (!good) continue;
    out.push({
      severity: "problem",
      code: "NETWORK_SPECIFIC",
      title: `Fails on ${netName(bad)}, connects elsewhere`,
      detail: `0 of ${bad.tried} connection attempts succeeded on ${netName(bad)}; ${good.succeeded} of ${good.tried} succeeded on ${netName(good)}.`,
    });
  }
  for (const n of known) {
    if (n.tried === 0 || n.succeeded > 0 || !n.others || n.others.customers === 0) continue;
    const share = n.others.connected / n.others.customers;
    const others = `${n.others.connected} of ${n.others.customers} other customers who tried on ${netName(n)} in the last ${n.others.hours} hours connected at least once`;
    if (share >= OTHERS_OK_SHARE) {
      out.push({
        severity: "warning",
        code: "NETWORK_OTHERS_OK",
        title: `Others connect on ${netName(n)}; this customer did not`,
        detail: `${others}; this customer: 0 of ${n.tried} attempts in ${days}.`,
      });
    } else if (share <= OTHERS_FAIL_SHARE) {
      out.push({
        severity: "warning",
        code: "NETWORK_OTHERS_FAIL",
        title: `Most others on ${netName(n)} did not connect either`,
        detail: `${others}; this customer: 0 of ${n.tried} attempts in ${days}.`,
      });
    }
  }

  const apiNets = input.networks.filter((n) => n.apiUnreachable > 0);
  const apiTotal = apiNets.reduce((sum, n) => sum + n.apiUnreachable, 0);
  if (apiTotal >= API_UNREACHABLE_OFTEN) {
    out.push({
      severity: "warning",
      code: "API_UNREACHABLE_OFTEN",
      title: "The app often could not reach the Neoxify API",
      detail: `${apiTotal} background reports in ${days} could not reach the API: ${apiNets
        .map((n) => `${n.apiUnreachable} on ${netName(n)}`)
        .join(", ")}.`,
    });
  }

  // Failure kinds.
  const count = (code: string) => input.failures.find((f) => f.code === code)?.count ?? 0;
  // NO_HANDSHAKE_OR_TRAFFIC is the outcome alone, which also covers a
  // handshake that never completed; with any of those counted the
  // finding cannot claim every tunnel came up.
  const carriedNothing = count("NOT_CARRYING");
  const unsaid = count("NO_HANDSHAKE_OR_TRAFFIC");
  const notCarrying = carriedNothing + unsaid;
  if (notCarrying >= NOT_CARRYING_OFTEN) {
    out.push(
      unsaid === 0
        ? {
            severity: "warning",
            code: "NOT_CARRYING_OFTEN",
            title: "Servers the app tried came up but carried nothing",
            detail: `${notCarrying} times in ${days} a server the app tried came up and the app's check got no traffic through it. This counts every server tried, including ones tried before a connection that then worked.`,
          }
        : {
            severity: "warning",
            code: "NOT_CARRYING_OFTEN",
            title: "Tunnels did not complete a handshake or carried nothing",
            detail: `${notCarrying} times in ${days} a tunnel either did not complete its handshake or carried no traffic (${carriedNothing} known to have come up and carried nothing; for ${unsaid} the app did not say which).`,
          },
    );
  }
  const service = count("SERVICE_NOT_ANSWERING");
  if (service > 0) {
    out.push({
      severity: "problem",
      code: "SERVICE_NOT_ANSWERING",
      title: "The Windows background service did not answer",
      detail: `${service} report${service === 1 ? "" : "s"} in ${days} said the background service did not answer or was not running.`,
    });
  }
  const otherVpn = count("OTHER_VPN_ACTIVE");
  if (otherVpn > 0) {
    out.push({
      severity: "warning",
      code: "OTHER_VPN",
      title: "Another VPN was active",
      detail: `${otherVpn} report${otherVpn === 1 ? "" : "s"} in ${days} said another VPN held the device.`,
    });
  }

  for (const app of input.apps) {
    if (app.behind !== true) continue;
    out.push({
      severity: "warning",
      code: "APP_BEHIND",
      title: `${app.platform} app is not the newest release`,
      detail: `The newest ${app.platform} report (${app.lastSeenAt}) came from ${app.appVersion}; the newest release is ${app.latestVersion}.`,
    });
  }

  if (input.emailVerifiedAt === null) {
    out.push({
      severity: "warning",
      code: "EMAIL_UNVERIFIED",
      title: "Email address not verified",
      detail: "The account's email address has not been verified.",
    });
  }

  // Plans.
  const live = input.credentials.filter((c) => c.status === "ACTIVE" && Date.parse(c.expireAt) > input.now);
  if (live.length === 0) {
    const newest = [...input.credentials].sort((a, b) => Date.parse(b.expireAt) - Date.parse(a.expireAt))[0];
    if (newest && (newest.status === "EXPIRED" || Date.parse(newest.expireAt) <= input.now)) {
      out.push({
        severity: "problem",
        code: "PLAN_EXPIRED",
        title: "The plan has expired",
        detail: `The newest subscription (${newest.planName}) has status ${newest.status} and its expiry date is ${newest.expireAt}.`,
      });
    } else {
      out.push({
        severity: "problem",
        code: "NO_ACTIVE_PLAN",
        title: "No active plan",
        detail:
          input.credentials.length === 0
            ? "The customer has no subscription."
            : `None of the ${input.credentials.length} subscription(s) is active and unexpired (statuses: ${[
                ...new Set(input.credentials.map((c) => c.status)),
              ].join(", ")}).`,
      });
    }
  }
  for (const sub of live) {
    if (sub.dataCapBytes !== null && BigInt(sub.dataUsedBytes) >= BigInt(sub.dataCapBytes)) {
      out.push({
        severity: "problem",
        code: "DATA_CAP_REACHED",
        title: "The plan's data is used up",
        detail: `${sub.planName}: ${sub.dataUsedBytes} of ${sub.dataCapBytes} bytes used.`,
      });
    }
    if (sub.notProvisioned > 0) {
      out.push({
        severity: "warning",
        code: "CREDENTIALS_NOT_PROVISIONED",
        title: "Credentials not acknowledged by their servers",
        detail: `${sub.planName}: for ${sub.notProvisioned} of ${sub.total} credentials no server has acknowledged creating them.`,
      });
    }
  }

  for (const v of input.vouchers) {
    if (!v.issuedToThisEmail) continue;
    const elsewhere = v.redemptions.filter((r) => !r.sameAccount);
    if (elsewhere.length > 0 && !v.redemptions.some((r) => r.sameAccount)) {
      out.push({
        severity: "warning",
        code: "CODE_USED_ELSEWHERE",
        title: "A code issued for this email was redeemed by another account",
        detail: `A ${v.planName} code issued for this address on ${v.issuedAt.slice(0, 10)} was redeemed by ${elsewhere.length} other account(s) and not by this one.`,
      });
    }
  }

  if (
    input.tried >= HEALTHY_MIN_TRIED &&
    input.succeeded / input.tried >= HEALTHY_SHARE &&
    !out.some((f) => f.severity === "problem")
  ) {
    out.push({
      severity: "info",
      code: "HEALTHY",
      title: "Connecting normally",
      detail: `${input.succeeded} of ${input.tried} connection attempts in ${days} succeeded.`,
    });
  }

  const rank = { problem: 0, warning: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
