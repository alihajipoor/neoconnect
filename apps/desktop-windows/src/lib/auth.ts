import { apiRequest, publicRequest } from "./api";
import { clearTokens, setTokens } from "./session";
import type { LoginResult, RequiresVerification, TokenPair, VerifyResult } from "./types";

/** Never returns a usable session -- see RequiresVerification's doc
 * comment. The app must always follow this up by showing the verify
 * screen, never a dashboard. */
export async function register(email: string, password: string, referralCode?: string) {
  return publicRequest<RequiresVerification>("/customer-auth/register", {
    method: "POST",
    // Omitted entirely when blank rather than sent as "": the backend
    // treats a supplied-but-wrong code as an error, and an empty string
    // is not a code somebody typed.
    body: JSON.stringify({ email, password, ...(referralCode ? { referralCode } : {}) }),
  });
}

/** Only stores a session when the account is actually verified --
 * `requiresVerification` results are never persisted, so an unverified
 * account can't end up with stray tokens sitting in the store. */
export async function login(email: string, password: string) {
  const result = await publicRequest<LoginResult>("/customer-auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (result.ok && !("requiresVerification" in result.data)) {
    await setTokens(result.data);
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

export async function logout(): Promise<void> {
  await apiRequest<void>("/customer-auth/logout", { method: "POST" });
  await clearTokens();
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
