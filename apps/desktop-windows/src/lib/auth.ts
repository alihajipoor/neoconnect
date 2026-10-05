import { apiRequest, publicRequest } from "./api";
import { attemptedEndpoints } from "./api-endpoints";
import { outcomeFromApiError, reportAttempt } from "./attempts";
import { setTokens } from "./session";
import { endCustomerSession } from "./session-end";
import { clearGamingProfileCache } from "./customer";
import { solveChallengeFor } from "./pow";
import { currentLanguage } from "./i18n";
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
 * An unreachable control plane carries the addresses that were tried,
 * as the pre-connect refresh's report already does. Sign-in was the
 * other source of CONTROL_PLANE_UNREACHABLE and sent none, so those
 * rows read "could not reach Neoxify" with no hint of *what* could not
 * be reached -- a blocked domain and a client carrying a stale mirror
 * list look identical without it, and sign-in on a filtered network is
 * exactly when it is needed. Still fire-and-forget: the lookup reads
 * the endpoint list the request itself just used, and it is only made
 * when there is something to say.
 */
function reportAuth(kind: AttemptKind, result: ApiResult<unknown>): void {
  void (async () => {
    if (result.ok) {
      await reportAttempt({ kind, outcome: "SUCCESS" });
      return;
    }
    const outcome = outcomeFromApiError(result.error);
    await reportAttempt({
      kind,
      outcome,
      reason: result.error,
      apiEndpoint: outcome === "CONTROL_PLANE_UNREACHABLE" ? await attemptedEndpoints() : undefined,
    });
  })();
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
  const result = await publicRequest<RequiresVerification>("/customer-auth/register", {
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
  });
  reportAuth("REGISTER", result);
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
  const result = await publicRequest<LoginResult>("/customer-auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, ...(challenge ? { challenge } : {}) }),
  });
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
  reportAuth("SIGN_IN", result);
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

  const result =
    outcome.kind === "apple-token"
      ? await publicRequest<TokenPair>("/customer-auth/social", {
          method: "POST",
          body: JSON.stringify({ provider, token: outcome.token, locale }),
        })
      : // Google and Facebook finished on the server; this only collects
        // the session it is already holding.
        await publicRequest<TokenPair>("/customer-auth/social/exchange", {
          method: "POST",
          body: JSON.stringify({ code: outcome.code }),
        });

  if (result.ok) {
    // Same reasoning as login(): before the tokens, so a stale
    // entitlement from the previous customer is never read as this
    // one's.
    clearGamingProfileCache();
    await setTokens(result.data);
  }
  reportAuth("SIGN_IN", result);
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

export async function logout(): Promise<void> {
  await apiRequest<void>("/customer-auth/logout", { method: "POST" });
  // The server call goes first and this runs regardless of what it said:
  // a sign-out the network refused is still a sign-out on this machine,
  // and leaving the previous customer's credentials and entitlement
  // behind because a request failed is the wrong way to fail.
  await endCustomerSession();
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
