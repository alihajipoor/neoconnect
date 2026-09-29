import { createPublicKey, createVerify } from "node:crypto";

/** Verifying what a provider says about who just signed in.
 *
 * Every one of these returns a subject and an email, and the only thing
 * that matters is that both came from the provider rather than from the
 * client. The client is the attacker's browser in the threat model: a
 * token it hands us is a claim, not evidence, until the signature is
 * checked against the provider's own keys or the token is exchanged at
 * the provider's own endpoint.
 */
export interface VerifiedIdentity {
  subject: string;
  email: string | null;
  /** Whether the provider states the address is confirmed. Linking to an
   * existing account on an unconfirmed address is account takeover with
   * extra steps, so this gates that decision rather than being
   * decoration. */
  emailVerified: boolean;
}

interface Jwk {
  kid: string;
  n: string;
  e: string;
  alg?: string;
}

/** Apple's and Google's signing keys, fetched and cached.
 *
 * Both rotate them, and both publish the set. Caching for an hour keeps
 * a sign-in from costing a round trip to the provider's key endpoint
 * while still picking up a rotation well inside the window either of
 * them uses. A `kid` we do not hold forces an immediate refetch, so a
 * rotation mid-cache is a single extra request rather than an outage.
 */
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000;

async function jwks(url: string, forceRefresh = false): Promise<Jwk[]> {
  const cached = jwksCache.get(url);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`could not fetch signing keys (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache.set(url, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
}

/** A claim, but only if it really is a string.
 *
 * Every field below is read out of JSON that arrived over the wire, so
 * its type is whatever the token said it was. `String(x)` on an object
 * yields the literal "[object Object]" -- harmless for `iss`, which
 * then simply matches no expected issuer, and not harmless at all for
 * `email`, which would become a customer's address. Narrowing once here
 * means none of the call sites has to remember which is which.
 */
function claimString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The subject, which is the one claim nothing works without.
 *
 * It is the join key for the whole feature: every account is found by
 * (provider, subject). Defaulting a missing or non-string one to "" would
 * make every such token resolve to the same account, so this refuses
 * instead.
 */
function requiredSubject(payload: Record<string, unknown>): string {
  const sub = claimString(payload.sub);
  if (!sub) throw new Error("token carries no subject");
  return sub;
}

function b64urlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/** Checks an RS256 JWT against a published key set.
 *
 * Written out rather than pulled from a library because the checks that
 * matter are the ones a careless integration skips: the signature, the
 * issuer, the audience, and the expiry. A token that is signed but
 * issued for somebody else's app is still a valid token -- it just is
 * not a statement about our user. Skipping the audience check is the
 * classic way this goes wrong.
 */
async function verifyRs256(
  token: string,
  jwksUrl: string,
  expectedIssuers: string[],
  expectedAudiences: string[],
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerB64, payloadB64, signatureB64] = parts;

  const header = JSON.parse(b64urlToBuffer(headerB64).toString("utf8")) as {
    kid?: string;
    alg?: string;
  };
  if (header.alg !== "RS256") throw new Error(`unexpected signing algorithm ${header.alg}`);

  const findKey = async (refresh: boolean) =>
    (await jwks(jwksUrl, refresh)).find((k) => k.kid === header.kid);
  // A miss means a rotation we have not seen, not a forgery -- refetch
  // once before rejecting.
  const key = (await findKey(false)) ?? (await findKey(true));
  if (!key) throw new Error("token signed by an unknown key");

  const publicKey = createPublicKey({
    key: { kty: "RSA", n: key.n, e: key.e },
    format: "jwk",
  });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  if (!verifier.verify(publicKey, b64urlToBuffer(signatureB64))) {
    throw new Error("token signature did not verify");
  }

  const payload = JSON.parse(b64urlToBuffer(payloadB64).toString("utf8")) as Record<string, unknown>;

  const iss = claimString(payload.iss) ?? "";
  if (!expectedIssuers.includes(iss)) throw new Error(`token issued by ${iss || "nobody"}`);

  // `aud` is a string or an array depending on the provider and the
  // flow; both shapes are legal, so both are handled rather than
  // assuming the one seen first in testing.
  const audClaim = payload.aud;
  // Non-string entries are dropped rather than stringified: an audience
  // that is not a string cannot be one of ours, and turning it into
  // "[object Object]" only invents a value to compare.
  const auds = Array.isArray(audClaim)
    ? audClaim.map(claimString).filter((a): a is string => a !== null)
    : [claimString(audClaim) ?? ""];
  if (!auds.some((a) => expectedAudiences.includes(a))) {
    throw new Error("token was issued for a different application");
  }

  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) throw new Error("token has expired");

  return payload;
}

/** Google, from the ID token the OAuth exchange returns. */
export async function verifyGoogle(idToken: string, clientIds: string[]): Promise<VerifiedIdentity> {
  const payload = await verifyRs256(
    idToken,
    "https://www.googleapis.com/oauth2/v3/certs",
    ["https://accounts.google.com", "accounts.google.com"],
    clientIds,
  );
  return {
    subject: requiredSubject(payload),
    email: claimString(payload.email),
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
  };
}

/** Apple, from the identity token the native sheet returns.
 *
 * The audience is the bundle identifier for the native flow -- not a
 * client id, because the native flow has no client secret and issues
 * nothing to keep. That is why Sign in with Apple needed no credential
 * from us to set up on iOS.
 *
 * `email` is absent on every sign-in after the first: Apple sends the
 * address once, at the moment the person first consents, and never
 * again. An integration that expects it every time creates a duplicate
 * account on the second sign-in, which is why the subject is the join
 * key here and the address is only ever supplementary.
 */
export async function verifyApple(identityToken: string, audiences: string[]): Promise<VerifiedIdentity> {
  const payload = await verifyRs256(
    identityToken,
    "https://appleid.apple.com/auth/keys",
    ["https://appleid.apple.com"],
    audiences,
  );
  return {
    subject: requiredSubject(payload),
    email: claimString(payload.email),
    // Apple sends this as the string "true"/"false" as often as a bool.
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
  };
}

/** Facebook, by asking Facebook.
 *
 * Facebook issues no ID token, so there is nothing to verify offline.
 * The access token is inspected at Facebook's debug endpoint, which is
 * the only way to learn which app it was minted for -- a token from
 * another app would otherwise be accepted and identify a stranger. The
 * profile is then read with that same token.
 */
export async function verifyFacebook(
  accessToken: string,
  appId: string,
  appSecret: string,
): Promise<VerifiedIdentity> {
  const appToken = `${appId}|${appSecret}`;
  const debugUrl = new URL("https://graph.facebook.com/debug_token");
  debugUrl.searchParams.set("input_token", accessToken);
  debugUrl.searchParams.set("access_token", appToken);

  const debugRes = await fetch(debugUrl, { signal: AbortSignal.timeout(8000) });
  if (!debugRes.ok) throw new Error(`Facebook rejected the token check (${debugRes.status})`);
  const debug = (await debugRes.json()) as {
    data?: { app_id?: string; is_valid?: boolean; user_id?: string };
  };
  if (!debug.data?.is_valid) throw new Error("Facebook says this token is not valid");
  if (debug.data.app_id !== appId) throw new Error("token was issued for a different application");
  const subject = debug.data.user_id;
  if (!subject) throw new Error("Facebook returned no user for this token");

  const meUrl = new URL("https://graph.facebook.com/v21.0/me");
  meUrl.searchParams.set("fields", "id,email");
  meUrl.searchParams.set("access_token", accessToken);
  const meRes = await fetch(meUrl, { signal: AbortSignal.timeout(8000) });
  if (!meRes.ok) throw new Error(`could not read the Facebook profile (${meRes.status})`);
  const me = (await meRes.json()) as { id?: string; email?: string };
  if (me.id !== subject) throw new Error("Facebook profile did not match the token");

  return {
    subject,
    // Facebook only returns an address it has confirmed, and omits it
    // entirely when the account has none -- a phone-only signup, which
    // is common. There is no separate verified flag to read.
    email: me.email ?? null,
    emailVerified: Boolean(me.email),
  };
}
