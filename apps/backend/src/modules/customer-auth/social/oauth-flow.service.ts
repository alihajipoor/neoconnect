import { randomBytes } from "node:crypto";

import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/** The browser half of social sign-in, for Google and Facebook.
 *
 * Apple is not here. iOS hands us an identity token from the native
 * sheet, which needs no browser, no client secret and no round trip --
 * it goes straight to POST /customer-auth/social.
 *
 * Google and Facebook cannot work that way from our clients. Neither
 * ships an SDK we use, and both need a client secret to turn an
 * authorization code into a token. That secret has to stay on the
 * server: shipping it in a desktop binary or an APK publishes it, and
 * for Facebook in particular the app secret is the credential that
 * signs app-level API calls, not merely a login detail.
 *
 * So the code never reaches the client at all. The app opens a browser
 * at `/social/:provider/start`, the provider redirects back to
 * `/social/:provider/callback` here, this service does the exchange,
 * and the app collects the finished session with a one-time handoff
 * code. Three short-lived secrets, none of which is useful alone.
 */

export type BrowserProvider = "google" | "facebook";

interface ProviderEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  clientIdKey: string;
  clientSecretKey: string;
  /** Which field of the token response is the thing we can verify.
   * Google signs an OIDC id_token; Facebook issues no signed token at
   * all, so its access token is checked by asking Facebook. */
  tokenField: "id_token" | "access_token";
}

const PROVIDERS: Record<BrowserProvider, ProviderEndpoints> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "openid email profile",
    clientIdKey: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretKey: "GOOGLE_OAUTH_CLIENT_SECRET",
    tokenField: "id_token",
  },
  facebook: {
    authorizeUrl: "https://www.facebook.com/v21.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
    scope: "email",
    clientIdKey: "FACEBOOK_APP_ID",
    clientSecretKey: "FACEBOOK_APP_SECRET",
    tokenField: "access_token",
  },
};

/** How long a half-finished sign-in stays valid.
 *
 * Long enough to create an account and answer a two-factor prompt on
 * the provider's side, short enough that an abandoned flow is not a
 * credential lying around. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** How long the finished session waits to be collected.
 *
 * The app is already in the foreground with the callback in hand, so
 * this is a network round trip, not a human. Two minutes is generous
 * and still means a handoff code scraped from a log is almost always
 * already dead. */
const HANDOFF_TTL_MS = 2 * 60 * 1000;

/** Where the browser is sent once the exchange is done.
 *
 * A constant, not something the caller passes. Every client this API
 * has uses the same scheme: Windows already registers `neoconnect://`
 * and forwards it through the single-instance handler, iOS catches it
 * inside ASWebAuthenticationSession without registering anything, and
 * Android claims it with an intent filter. Since there is only ever one
 * destination, taking one as a parameter would add an open-redirect to
 * validate and nothing else.
 */
export const APP_CALLBACK_URL = "neoconnect://social-callback";

interface PendingState {
  provider: BrowserProvider;
  locale: string;
  expiresAt: number;
}

interface PendingHandoff {
  tokens: { accessToken: string; refreshToken: string };
  expiresAt: number;
}

@Injectable()
export class OauthFlowService {
  private readonly logger = new Logger(OauthFlowService.name);

  /** In memory on purpose, matching LoginGuardService: both hold state
   * that is worthless after minutes, and both already assume the single
   * API instance this deployment runs. A restart drops in-flight
   * sign-ins, which costs the customer one more tap. */
  private readonly states = new Map<string, PendingState>();
  private readonly handoffs = new Map<string, PendingHandoff>();

  constructor(private readonly config: ConfigService) {}

  private required(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      this.logger.error(`${key} is not configured; this provider cannot be used`);
      throw new BadRequestException("This sign-in method is not available right now");
    }
    return value;
  }

  /** The address the provider redirects back to.
   *
   * Built from PUBLIC_API_URL rather than from the incoming request,
   * because an attacker controls the Host header and the provider
   * compares this string byte for byte against the one registered in
   * the provider's console. Deriving it from the request would mean a
   * spoofed Host either breaks every sign-in or, worse, sends the
   * authorization code somewhere else.
   */
  redirectUri(provider: BrowserProvider): string {
    const base = this.required("publicApiUrl").replace(/\/$/, "");
    return `${base}/customer-auth/social/${provider}/callback`;
  }

  /** Where the app is sent when the flow finishes, either way.
   *
   * `handoff` on success, `error` on failure -- never both, and never a
   * token. The app reads one parameter and acts on it.
   */
  appCallback(params: Record<string, string>): string {
    const url = new URL(APP_CALLBACK_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, value] of this.states) if (value.expiresAt <= now) this.states.delete(key);
    for (const [key, value] of this.handoffs) if (value.expiresAt <= now) this.handoffs.delete(key);
  }

  /** Step one: where the browser should go. */
  start(provider: BrowserProvider, locale: string): string {
    this.sweep();

    const endpoints = PROVIDERS[provider];
    const state = randomBytes(32).toString("base64url");
    this.states.set(state, { provider, locale, expiresAt: Date.now() + STATE_TTL_MS });

    const url = new URL(endpoints.authorizeUrl);
    url.searchParams.set("client_id", this.required(endpoints.clientIdKey));
    url.searchParams.set("redirect_uri", this.redirectUri(provider));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", endpoints.scope);
    url.searchParams.set("state", state);
    if (provider === "google") {
      // Without this Google silently reuses the previous choice, so a
      // shared device signs the second person in as the first.
      url.searchParams.set("prompt", "select_account");
    }
    return url.toString();
  }

  /** Reads and burns a state value. Single use: a replayed callback
   * must not mint a second session. */
  consumeState(state: string): PendingState {
    this.sweep();
    const pending = this.states.get(state);
    if (!pending) throw new BadRequestException("This sign-in link has expired -- please try again");
    this.states.delete(state);
    return pending;
  }

  /** Step two: the authorization code becomes a provider token.
   *
   * Returns the token in the shape SocialAuthService.verify() expects,
   * so the verification path is exactly the one Apple's native token
   * takes. There is no second, laxer way into an account.
   */
  async exchangeCode(provider: BrowserProvider, code: string): Promise<string> {
    const endpoints = PROVIDERS[provider];
    const body = new URLSearchParams({
      code,
      client_id: this.required(endpoints.clientIdKey),
      client_secret: this.required(endpoints.clientSecretKey),
      redirect_uri: this.redirectUri(provider),
      grant_type: "authorization_code",
    });

    const res = await fetch(endpoints.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // The provider's body often names the misconfiguration exactly
      // ("redirect_uri_mismatch"), and that belongs in our log rather
      // than in a customer's face.
      const detail = await res.text().catch(() => "");
      this.logger.warn(`${provider} code exchange failed (${res.status}): ${detail.slice(0, 500)}`);
      throw new BadRequestException("We could not complete that sign-in");
    }

    const payload = (await res.json()) as Record<string, unknown>;
    const token = payload[endpoints.tokenField];
    if (typeof token !== "string" || token.length === 0) {
      this.logger.warn(`${provider} returned no ${endpoints.tokenField}`);
      throw new BadRequestException("We could not complete that sign-in");
    }
    return token;
  }

  /** Step three: park the finished session behind a one-time code.
   *
   * The session itself never goes in the redirect. A custom-scheme URL
   * is handled by whichever app claims the scheme, lands in browser
   * history, and on desktop crosses a plaintext loopback hop -- none of
   * which should ever carry a refresh token. What crosses instead is
   * this code, which is single-use, expires in minutes, and is worth
   * nothing to anyone who cannot also reach our API.
   */
  storeHandoff(tokens: { accessToken: string; refreshToken: string }): string {
    this.sweep();
    const code = randomBytes(32).toString("base64url");
    this.handoffs.set(code, { tokens, expiresAt: Date.now() + HANDOFF_TTL_MS });
    return code;
  }

  /** Step four: the app trades the code for the session, once. */
  consumeHandoff(code: string): { accessToken: string; refreshToken: string } {
    this.sweep();
    const pending = this.handoffs.get(code);
    if (!pending) throw new BadRequestException("This sign-in has expired -- please try again");
    this.handoffs.delete(code);
    return pending.tokens;
  }
}
