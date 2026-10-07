import { apiRequest, publicRequest } from "./api";
import { outcomeFromApiError, reportAttempt } from "./attempts";
import { probeAddendum } from "./control-plane-probe";
import { newTrace, renderTrace, type EndpointTrace } from "./endpoint-trace";
import { setTokens } from "./session";
import { endCustomerSession, type SessionEnd } from "./session-end";
import { clearGamingProfileCache } from "./customer";
import { solveChallengeFor } from "./pow";
import { currentLanguage } from "./i18n";
import { deviceHeaders } from "./device-identity";
import { startSocialSignIn } from "./social-auth";
import type { SocialOutcome, SocialProvider } from "./social-auth";
import type { ApiResult } from "./api";
import type { AttemptKind } from "./attempts";
import type { LoginResult, RequiresVerification, TokenPair, VerifyResult } from "./types";

/** Reports how a sign-up or sign-in went.
 *
 * Here rather than in the screens so there is exactly one place it can
 * be forgotten, and because the interesting distinction -- refused
 * versus never arrived -- is visible in the result rather than in the
 * component.
 *
 * Deliberately does not send the address. The endpoint accepts anonymous
 * reports, so an email in the body would be an unverified claim about a
 * real person, and these rows already hold an IP from somewhere it is
 * dangerous to hold one. A verified session attaches the customer
 * server-side; a failed sign-in has no session, and that is the honest
 * answer.
 *
 * An unreachable control plane carries the trace of what the request
 * tried -- each address, and whether it timed out, failed or was never
 * allowed -- as the pre-connect refresh's report does. Sign-in on a
 * filtered network is exactly when it is needed. `trace` is absent for a
 * failure that never reached `publicRequest` (a social provider that
 * refused), and then nothing is claimed about addresses at all.
 */
function reportAuth(kind: AttemptKind, result: ApiResult<unknown>, trace?: EndpointTrace): void {
  if (result.ok) {
    void reportAttempt({ kind, outcome: "SUCCESS" });
    return;
  }
  const outcome = outcomeFromApiError(result.error);
  if (outcome !== "CONTROL_PLANE_UNREACHABLE" || !trace) {
    void reportAttempt({ kind, outcome, reason: result.error });
    return;
  }
  // Made now, with the trace; the probe's answer follows it rather than
  // holding it back -- see `reportAttempt`. Nothing follows a failed
  // sign-in, so the path the probe sees is the one the request saw. See
  // control-plane-probe.ts.
  void reportAttempt(
    { kind, outcome, reason: result.error, apiEndpoint: renderTrace(trace) || "none dialled" },
    probeAddendum(trace.entries),
  );
}

/** Never returns a usable session -- see RequiresVerification's doc
 * comment. The app must always follow this up by showing the verify
 * screen, never a dashboard. */
export async function register(email: string, password: string, referralCode?: string) {
  // Solved before the attempt, not in response to being refused: the
  // server raises the required difficulty as failures accumulate, so
  // carrying a solution is what keeps signup usable once an address or
  // an account has drawn attention. Undefined when the challenge
  // endpoint could not be reached, which the server tolerates.
  const challenge = await solveChallengeFor("customer");
  const trace = newTrace();
  const result = await publicRequest<RequiresVerification>(
    "/customer-auth/register",
    {
      method: "POST",
      // Omitted entirely when blank rather than sent as "": the backend
      // treats a supplied-but-wrong code as an error, and an empty string
      // is not a code somebody typed.
      body: JSON.stringify({
        email,
        password,
        // Read here rather than passed in by the screen, so the one call
        // site that creates an account cannot be the one that forgets.
        // The very first email this account receives is the verification
        // code, and it is sent before the customer has anywhere to tell
        // us anything -- so the language has to travel with the signup or
        // that email is in the wrong one no matter what happens later.
        locale: currentLanguage(),
        ...(referralCode ? { referralCode } : {}),
        ...(challenge ? { challenge } : {}),
      }),
    },
    trace,
  );
  reportAuth("REGISTER", result, trace);
  return result;
}

/** Only stores a session when the account is actually verified --
 * `requiresVerification` results are never persisted, so an unverified
 * account can't end up with stray tokens sitting in the store. */
export async function login(email: string, password: string) {
  // The email is sent with the challenge request so the server can
  // price this attempt against that account's own recent failures --
  // the case per-address rate limiting cannot see.
  const challenge = await solveChallengeFor("customer", email);
  const trace = newTrace();
  const result = await publicRequest<LoginResult>(
    "/customer-auth/login",
    {
      method: "POST",
      body: JSON.stringify({ email, password, ...(challenge ? { challenge } : {}) }),
      // Names this device to the customer's others ("Neoxify is in use on
      // a Windows PC"). See device-identity.ts.
      headers: deviceHeaders(),
    },
    trace,
  );
  if (result.ok && !("requiresVerification" in result.data)) {
    // Before the tokens, not after. From here on any fetch is this
    // customer's, and a cache entry still holding the previous one's
    // entitlement would be read as belonging to the session that just
    // started. Sign-out clears this too; doing it here as well covers
    // the sign-ins that never pass through a sign-out at all -- the
    // auto-sign-in after email verification is three separate call
    // sites, none of which ends a prior session.
    clearGamingProfileCache();
    await setTokens(result.data);
  }
  // After the tokens are stored, so a successful sign-in is attributed
  // to the customer it belongs to rather than arriving anonymous.
  reportAuth("SIGN_IN", result, trace);
  return result;
}

/** Signing in with Google, Apple or Facebook.
 *
 * Deliberately the same shape as `login()` above, including the cache
 * clear and the attempt report, because everything downstream of a
 * session must not be able to tell how it was obtained. The difference
 * is only in how the credential is obtained, which is social-auth.ts's
 * problem, and which endpoint finishes it.
 *
 * Returns `null` when the customer cancelled -- distinct from a failed
 * result, because a cancellation has nothing to report and nothing to
 * show.
 */
export async function socialSignIn(
  provider: SocialProvider,
): Promise<ApiResult<TokenPair> | null> {
  const locale = currentLanguage();

  let outcome: SocialOutcome | null;
  try {
    outcome = await startSocialSignIn(provider, locale);
  } catch (err) {
    // A provider that refused, a browser that would not open, a message
    // the server wrote for this customer. None of these reached an
    // endpoint, so there is no ApiResult -- but the screen still needs
    // something to show, and reportAuth still wants to know it failed.
    const error = err instanceof Error ? err.message : String(err);
    const result: ApiResult<TokenPair> = { ok: false, error };
    reportAuth("SIGN_IN", result);
    return result;
  }
  if (outcome === null) return null;

  const trace = newTrace();
  const result =
    outcome.kind === "apple-token"
      ? await publicRequest<TokenPair>(
          "/customer-auth/social",
          {
            method: "POST",
            body: JSON.stringify({ provider, token: outcome.token, locale }),
            headers: deviceHeaders(),
          },
          trace,
        )
      : await exchangeHandoff(outcome.code, outcome.verifier, trace);

  if (result.ok) {
    // Same reasoning as login(): before the tokens, so a stale
    // entitlement from the previous customer is never read as this
    // one's.
    clearGamingProfileCache();
    await setTokens(result.data);
  }
  reportAuth("SIGN_IN", result, trace);
  return result;
}

/** What a backend from before the PKCE binding says to an exchange that
 * carries a verifier: its validation forbids any property its DTO does
 * not declare, and that refusal is worded by class-validator, not by us.
 * A backend with the binding declares `verifier` and never says it. */
const VERIFIER_UNKNOWN = /\bproperty verifier should not exist\b/;

/** Google and Facebook finished on the server; this only collects the
 * session it is already holding -- with the verifier for the PKCE
 * challenge the flow started with, without which the server will not
 * hand over a session bound to it (social-auth.ts).
 *
 * Once more without the verifier, but only when the server refused the
 * field itself. That is a backend from before the binding, and without
 * this a client released ahead of that backend's deploy could not finish
 * Google or Facebook sign-in at all -- which also meant main could not
 * cut a client hotfix until the backend had gone out. It reopens
 * nothing:
 *  - that backend's validation ran before its handler, so the code was
 *    never looked at, let alone spent, and that backend binds nothing --
 *    the retry asks for exactly what every released client asks for;
 *  - a backend with the binding never words a refusal this way, and it
 *    spends the code before checking the verifier, so even a retry it
 *    provoked could collect nothing.
 * Any other refusal -- an expired code, a wrong verifier -- is final. */
async function exchangeHandoff(
  code: string,
  verifier: string | undefined,
  trace: EndpointTrace,
): Promise<ApiResult<TokenPair>> {
  const exchange = (body: { code: string; verifier?: string }) =>
    publicRequest<TokenPair>(
      "/customer-auth/social/exchange",
      { method: "POST", body: JSON.stringify(body) },
      trace,
    );
  if (!verifier) return exchange({ code });
  const result = await exchange({ code, verifier });
  if (!result.ok && result.status === 400 && VERIFIER_UNKNOWN.test(result.error)) {
    return exchange({ code });
  }
  return result;
}

export async function verifyEmailByCode(email: string, code: string) {
  return publicRequest<VerifyResult>("/customer-auth/verify-email-code", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
}

/** The token-based counterpart to verifyEmailByCode -- used when the
 * "Open in Neoxify" link in the verification email actually launches
 * the app (see the deep-link handling in App.tsx). No password is ever
 * available at this point (a cold app launch via a clicked email link,
 * not a live register/login session), so this can't auto-sign-in the way
 * the code flow does -- the caller sends the user to a normal sign-in
 * afterward. */
export async function verifyEmailByToken(token: string) {
  return publicRequest<VerifyResult>("/customer-auth/verify-email", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function resendVerification(email: string) {
  return publicRequest<void>("/customer-auth/resend-verification", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** How long a sign-out waits for the server to hear about it.
 *
 * The request is a POST, so it walks the endpoints one at a time at up
 * to eight seconds each -- on a filtered network, over a minute -- and
 * the tunnel stays up for all of it, because the tunnel comes down after
 * this call and not before. One endpoint's worth is what the customer
 * waits; the request carries on unwatched after that. */
const LOGOUT_SERVER_BUDGET_MS = 8_000;

export async function logout(): Promise<SessionEnd> {
  // The server call goes first, while the tunnel is still up: on a
  // filtered network the tunnel is the likeliest route to the control
  // plane, and this is what revokes the refresh token there.
  const told = apiRequest<void>("/customer-auth/logout", { method: "POST" }).catch(() => undefined);
  await Promise.race([told, new Promise((r) => setTimeout(r, LOGOUT_SERVER_BUDGET_MS))]);
  // And this runs regardless of what it said: a sign-out the network
  // refused is still a sign-out on this machine, and leaving the tunnel
  // up, or the previous customer's credentials and entitlement behind,
  // because a request failed is the wrong way to fail.
  return await endCustomerSession();
}

/** Deletes the signed-in customer's own account, permanently.
 *
 * Required to exist by both app stores for any app that offers account
 * creation -- Apple 5.1.1(v) and Play's data deletion policy -- so this
 * is a condition of being listed, not a courtesy.
 *
 * The server revokes every credential on every node before it returns,
 * and bumps the token version so any other signed-in device stops
 * working too. Local tokens are cleared afterwards regardless of what
 * the server said: if the account really is gone, keeping them would
 * leave the app trying to use credentials that can only fail, and if the
 * call failed the worst outcome is one unnecessary sign-in.
 *
 * Returns how many credentials were revoked, which the caller can show
 * -- the customer deserves to know their access is actually gone rather
 * than being told it is.
 */
export async function deleteAccount() {
  const result = await apiRequest<{ deleted: boolean; credentialsRevoked: number }>("/customer/me", {
    method: "DELETE",
  });
  // The whole teardown, not just the tokens. An account that no longer
  // exists has no business leaving its WireGuard keys and its cached
  // entitlement on the machine -- and this path never went through
  // `Dashboard.handleLogout`, which was the only caller of
  // `clearSnapshot` before.
  await endCustomerSession();
  return result;
}

/** Changes the password of the signed-in customer.
 *
 * The backend revokes every session on success, including this app's own,
 * so it hands back a fresh pair -- storing them immediately is what keeps
 * the user signed in instead of being bounced to the login screen on
 * their next request. */
export async function changePassword(currentPassword: string, newPassword: string) {
  const result = await apiRequest<TokenPair>("/customer-auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (result.ok) {
    await setTokens(result.data);
  }
  return result;
}

/** Asks for a reset code by email.
 *
 * Always succeeds from the caller's point of view, whether or not the
 * address belongs to an account -- the server deliberately answers the
 * same either way so this cannot be used to find out who has one. The UI
 * must therefore say "if that address is registered", never "sent".
 */
export async function forgotPassword(email: string) {
  return publicRequest<void>("/customer-auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

/** Completes the reset with the emailed code.
 *
 * The code rather than the token, for the same reason verifyEmailByCode
 * exists: the token only ever arrives inside a link, and webmail strips
 * the custom URI scheme those links use, so a desktop client cannot rely
 * on receiving one.
 */
export async function resetPasswordByCode(email: string, code: string, newPassword: string) {
  return publicRequest<void>("/customer-auth/reset-password-code", {
    method: "POST",
    body: JSON.stringify({ email, code, newPassword }),
  });
}
