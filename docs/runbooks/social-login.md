# Signing in with Google, Apple and Facebook

Everything the code cannot carry: what is configured in three provider
consoles, which secrets the API needs, and what is still blocked.

The code itself is described where it lives -- `OauthFlowService` for
why the authorization code never reaches the client, `SocialAuthService`
for how an identity becomes a customer, `social-auth.ts` for the three
per-platform ways of getting to a provider and back.

## The shape of it, in one paragraph

Apple on iOS is a native sheet: it returns an identity token, the app
posts it to `POST /customer-auth/social`, and the API verifies it
against Apple's published keys. Google and Facebook cannot work that
way, because turning their authorization code into a token needs a
client secret, and a secret in a desktop binary or an APK is a published
secret. So for those two the app only opens a browser at
`GET /customer-auth/social/:provider/start`; the provider redirects to
`/callback` on the API, the API does the exchange, and the app collects
the finished session with a one-time code at
`POST /customer-auth/social/exchange`.

## Environment

All of `apps/backend/.env`. Each provider is independent: one with no
credentials refuses that single sign-in with "not available right now"
and logs the missing key, leaving the other buttons and password
sign-in working.

| Variable | Where it comes from |
| --- | --- |
| `PUBLIC_API_URL` | Already set. Both redirect URIs are built from it, so changing it means changing both consoles below. |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud console, OAuth client "Neoxify customer login". |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Same client. Shown once at creation; a lost one is replaced, not recovered. |
| `FACEBOOK_APP_ID` | Meta for Developers, app "Neoxify". |
| `FACEBOOK_APP_SECRET` | Same app, App settings > Basic. |
| `APPLE_SIGNIN_AUDIENCES` | `com.neoxify.mobile` -- the bundle identifier, not a client id. A future macOS or web client appends its own, comma separated. |

Apple needs no secret at all. The native flow issues nothing to keep,
which is why iOS was the one provider that needed no credential
configured anywhere.

## Provider consoles

### Google

Project `storm-wall-475421-c1`, client **Neoxify customer login**, type
**Web application** -- not "iOS" or "Android". Those types issue no
secret, and the whole point of the design is that the exchange happens
on the server.

Authorized redirect URI, exactly:

```
https://connect.neoxify.site/api/customer-auth/social/google/callback
```

Google compares this byte for byte. A mismatch is a `redirect_uri_mismatch`
in the API log and a generic failure for the customer, by design -- the
provider's complaint names our misconfiguration and does not belong in
front of a person trying to sign in.

### Facebook

App **Neoxify** (`1629092128798910`).

- App settings > Basic > **App domains**: `neoxify.site`, `connect.neoxify.site`
- Facebook Login > Settings > **Valid OAuth Redirect URIs**:
  `https://connect.neoxify.site/api/customer-auth/social/facebook/callback`
- Permissions: `public_profile` and `email`, both added to the Facebook
  Login use case.

Both settings fields are token inputs: a value typed in but not turned
into a chip is discarded by Save without complaint. Confirm by
reloading the page, not by looking at the field.

### Apple

App Store Connect has two apps on this account and they are easy to
confuse: **Neoxify is `6815764263`** (`com.neoxify.mobile`); `6816536281`
is **Nura Wallet**, a different product. Confirm with
`apps?fields[apps]=name,bundleId` before any API call that names an app —
three in-app purchase products were once created on the wrong one, and
Apple burns a product id permanently on first use, so the identifiers
could not be recovered.

The in-app purchases are `com.neoxify.mobile.{starter,pro,ultimate}.30d`,
non-renewing, mapped to plans through `SubscriptionPlan.appleProductId`.


The `APPLE_ID_AUTH` capability is already enabled on the App ID
`com.neoxify.mobile`, and `com.apple.developer.applesignin` is in
`mobile_iOS.entitlements`. Both are needed: the entitlement without the
capability fails at signing, and the capability without the entitlement
fails when the sheet is opened.

Note that Apple's Guideline 4.8 makes Sign in with Apple **mandatory**
now that the app offers Google and Facebook. Removing it while the
other two remain is a rejection.

## Still blocked

**Facebook login does not work for the public yet.** The app is
Unpublished and the Publish button is disabled pending **Business
verification**, which needs legal business documents and can only be
completed by the business owner. Until then Facebook sign-in works
only for accounts with a role on the app (admin, developer, tester) --
which is enough to test it, and not enough to ship it.

Google and Apple have no equivalent gate.

## Testing it

The one thing worth saying: a cancelled sign-in is not a failure.
Dismissing the sheet, pressing Back out of a Custom Tab, or declining
the consent screen all resolve to "nothing happened" and must show no
error. Somebody who just pressed Cancel being told their sign-in failed
is both wrong and alarming, and it is the case that regresses first
because it is the one nobody thinks to try.

Worth walking per platform:

1. Cancel at the consent screen.
2. Sign in with an address that has no Neoxify account -- a new account,
   already verified, straight to the dashboard.
3. Sign in with an address that has a **verified** password account --
   lands in that same account, not a second one.
4. Sign in with an address that has an **unverified** password account
   -- refused, with a message telling them to finish the password
   signup. This is deliberate: linking on an address nobody has proven
   is account takeover with extra steps.


## Submitting a release that carries new in-app purchases

The final submit must be done in the App Store Connect **web UI**. Apple
refuses a standalone IAP submission —

> The first Non-Renewing Subscription for this app must be submitted for
> review at the same time that you submit an app version.

— and there is no API path to pair them: `appStoreVersions` exposes no
`inAppPurchases` relationship, `reviewSubmissionItems` accepts
`appStoreVersion` but not `inAppPurchaseV2`, and `inAppPurchaseSubmissions`
returns the error above.

Submitting the version alone through `reviewSubmissions` does **not**
carry the purchases: the version reaches WAITING_FOR_REVIEW and the IAPs
stay at READY_TO_SUBMIT, so a reviewer finds an empty purchase screen.
Confirmed on 2026-09-30 and cancelled.

So prepare by API — attach the build, write the review notes, get every
IAP to READY_TO_SUBMIT — then tick the purchases under "In-App Purchases
and Subscriptions" on the version page and press Submit by hand.
