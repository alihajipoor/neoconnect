# iOS releases from GitHub Actions

`.github/workflows/release-ios.yml` builds the signed App Store IPA on a
GitHub macOS runner and uploads it to App Store Connect, where it shows
up in TestFlight once Apple has processed it. iPhone releases then no
longer need the Mac.

**Status: never run with real secrets.** Everything below the dry run is
written from Apple's and Tauri's documentation and Tauri's source; the
first real run is the proof. See *What is unproven*.

## One-time setup (the owner)

The workflow does nothing until four repository secrets exist. To create
them:

1. **Make an API key.** In [App Store Connect](https://appstoreconnect.apple.com):
   **Users and Access** → **Integrations** tab → **App Store Connect API**
   → **Team Keys** → the **+** button. Name it `GitHub iOS release`. Under
   **Access** choose **Admin**. Click **Generate**.
   - It must be a *team* key, not an individual one (altool does not
     take individual keys), and it must be **Admin** -- see *Why Admin*.
     A key's access cannot be changed later; a wrong one means revoking
     it and making another.
2. **Download it.** In the row of the new key, click **Download API Key**.
   You get one file, `AuthKey_<something>.p8`. Apple lets you download it
   **once**.
3. **Note two values on the same page:** the **Issuer ID** (above the
   table, with a Copy button) and the new key's **Key ID** (in its row).
4. **Note your Team ID:** [developer.apple.com/account](https://developer.apple.com/account)
   → **Membership details** → **Team ID** (10 letters and digits).
5. **Add four secrets on GitHub:** the repository → **Settings** →
   **Secrets and variables** → **Actions** → **New repository secret**,
   once for each:

   | Name | Value |
   |---|---|
   | `ASC_API_KEY_ID` | the Key ID from step 3 |
   | `ASC_API_ISSUER_ID` | the Issuer ID from step 3 |
   | `ASC_API_KEY_P8` | the whole text of the `.p8` file, from `-----BEGIN PRIVATE KEY-----` to `-----END PRIVATE KEY-----` inclusive (open it in TextEdit, select all, copy) |
   | `APPLE_TEAM_ID` | the Team ID from step 4 |

   From a terminal instead: `gh secret set ASC_API_KEY_P8 < AuthKey_XXXX.p8`,
   and `gh secret set <NAME>` for the other three (it prompts for the
   value).
6. Then delete the downloaded `.p8`, or keep it only in a password
   manager. It never goes in the repository.

An Admin key can do almost anything to the developer account, so treat
it like the Admin password. It lives only in the repository secrets;
GitHub never hands secrets to workflows run from forks, and only people
with write access can start this one. If it ever leaks: **Integrations**
→ **Team Keys** → **Revoke**, then make a new one.

### Why Admin

The runner holds no certificate, and none is copied to it from the Mac.
It signs with the team's **cloud-managed distribution certificate**,
whose private key stays with Apple. Apple's documentation lets the
Account Holder and Admins use those; anyone else needs a separate
"access to cloud-managed certificates" permission, which can be given
to a person in **Users and Access** but cannot be given to an API key.
A Developer or App Manager key authenticates, builds, and then fails at
export with *Cloud signing permission error* or *You haven't been given
access to cloud-managed distribution certificates*. Admin also has full
access to Certificates, Identifiers & Profiles, which the export needs
to create the App Store profiles for the app (`com.neoxify.mobile`) and
its packet-tunnel extension (`com.neoxify.mobile.tunnel`). The
capabilities on those two App IDs (Network Extensions, Personal VPN,
App Groups, Sign in with Apple) are already enabled from the releases
signed on the Mac.

Sources: Apple, [Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates)
and [Program roles](https://developer.apple.com/help/account/access/roles/);
Apple Developer Forums [698117](https://developer.apple.com/forums/thread/698117)
(non-Admin keys refused cloud signing); Tauri, [iOS code signing](https://v2.tauri.app/distribute/sign/ios/)
(asks for an Admin key for the same reason).

## Running it

GitHub → **Actions** → **Release (iOS)** → **Run workflow**, on `main`:

- **marketing_version**: the App Store version record, e.g. `1.0.4`.
  Not the mobile app's 0.2.x. It has to be a version Apple still takes
  builds for: once 1.0.4 is released, its builds are closed and the next
  upload needs 1.0.5.
- **build_number**: above every build already uploaded, e.g. `25`. The
  workflow asks App Store Connect and refuses a number that is not.
- **ref** (optional): a branch, tag or commit to build instead of the
  branch the workflow is run from.

Or: `gh workflow run release-ios.yml --ref main -f marketing_version=1.0.4 -f build_number=25`

The iOS CI job takes about 13 minutes for a debug simulator build; a
release build compiles with optimisation and then exports and uploads,
so expect longer. The first run gives the real figure.

When it is green, the build appears under **TestFlight** in App Store
Connect after Apple's processing (usually minutes, sometimes longer),
and Apple sends the usual "has completed processing" email.

## What it does

A Linux job first, so nothing that can be refused cheaply spends a macOS
runner:

1. If any of the four secrets is missing, it says which, writes that in
   the run summary, and stops. **The run is green and nothing else
   happens** -- the macOS job is skipped.
2. Checks both numbers are 1-3 period-separated integers.
3. Asks App Store Connect (`apps/mobile/scripts/asc-check-build-number.mjs`,
   with the same key) for the highest build number already uploaded and
   refuses one that is not above it. This also proves the key and its
   ids work before the long job starts.

Then the macOS job, on the exact commit the first job checked out:

4. Selects Xcode 26.6 and stops if the runner image no longer has it
   (Tauri does not build with Xcode 27).
5. Same toolchains as `ci-ios.yml`, builds the Xray engine with the
   xray-core patches, generates the Xcode project.
6. Writes the key to the runner's temp directory (directory 700, file
   600), with every line masked in the log.
7. Runs `pnpm ios:build` with `NEOXIFY_IOS_SIGNING=cloud`, which does
   everything a Mac store build does -- regenerates the project with the
   tunnel extension, checks the privacy manifests, applies the icon, sets
   `VITE_DISTRIBUTION=store`, requires the endpoint seed, stamps the App
   Store numbers into both bundles -- and then:
   - archives through Tauri, which archives unsigned when an API key is
     in the environment;
   - signs the extension and then the app with their entitlements under a
     throwaway self-signed certificate (see below);
   - exports with `-allowProvisioningUpdates` and the key, so Xcode
     creates or refreshes the two App Store profiles and signs with the
     cloud-managed certificate;
   - reads back from the IPA: both bundles' version and build numbers,
     a signature that verifies, `packet-tunnel-provider` and the app
     group on both, Personal VPN on the app, and no development
     (`get-task-allow`) signature. Any miss stops the run before upload;
   - checks the web bundle carries no checkout, voucher or website path
     (guideline 3.1.1).
8. Uploads with `xcrun altool --upload-app`, as the Mac upload does, and
   counts it as done only if altool's log says the upload succeeded.
9. Writes the version, build, mobile version and commit to the run
   summary, and deletes the key file whatever happened.

### Why the placeholder signature

Xcode's export keeps only the entitlements it finds in an existing
signature. An unsigned archive therefore exports with the profiles'
defaults and none of ours: an IPA that signs, uploads, installs, and can
never start a tunnel. Tauri handles this by signing the app with a
self-signed certificate before its own export -- but `@tauri-apps/cli`
2.11.4, which this repo uses, does that for the app only and drops the
extension's entitlements. That is tauri-apps/tauri#16312, fixed
upstream on 2026-11-18 and not in any release yet (2.12.6 does not have
it). So `scripts/build-ios.sh` does the same for both bundles and runs
the export itself. The certificate lives only in a temporary keychain on
the runner and is never sent to Apple; the export replaces every
placeholder signature with Apple's.

A side benefit of the unsigned archive: no development certificate is
needed, so runs do not leave an "Apple Development: Created via API"
certificate behind each time, which is the usual way CI fills up a
team's certificate list.

## What it does not do

- **Submit for review.** Upload only. Review, TestFlight groups and
  testers, "What to Test" and the store listing stay in App Store
  Connect.
- **Answer export compliance.** `ITSAppUsesNonExemptEncryption` is
  deliberately unset (see `CLAUDE.md`), so App Store Connect asks for
  each build; answer it there.
- **Publish the IPA anywhere else.** No workflow artifact: the
  repository is public.
- **Bump, tag or journal anything.** Record the upload (store version,
  build, mobile version) in `docs/journal/log.md` as for a Mac upload.
- **Change the Mac path.** `NEOXIFY_IOS_SIGNING=appstore` still signs
  manually with the named profiles; its project and export options are
  byte-for-byte what they were. The one addition both paths share is
  the entitlement check on the IPA.

Side effects in the developer account: the first export creates App
Store profiles for both App IDs, with names Xcode chooses, and refreshes
them later. The Mac's manual profiles are untouched. If the team has no
cloud-managed distribution certificate yet, Apple creates one on first
use; it appears under **Certificates**.

## What is unproven

Nothing here has run with real secrets. Built from documentation and
source, and checked only so far:

- **Checked:** the workflow passes `action-validator` and `actionlint`;
  the shell script passes `bash -n`; the patcher's App Store (manual)
  output is byte-identical to before, and its cloud output is the
  automatic export options Tauri uses; the build-number check signs a
  token that verifies and compares numbers correctly against a stubbed
  App Store Connect; the placeholder certificate's openssl commands work
  with OpenSSL 3 (macOS's own `/usr/bin/openssl` is LibreSSL, not run
  here). A run without the secrets is the dry run: it should end green
  after the first job with the macOS job skipped.
- **The first real run proves or breaks:** the keychain and `codesign`
  steps of the placeholder signature on macOS; that Xcode 26.6's export
  accepts the placeholder-signed archive and keeps the extension's
  entitlements (the IPA check catches it if not); that this team's
  Admin key gets cloud signing and can create the two profiles; and
  altool's upload with the key in the temp directory.
- **Watch after the first run:** the **Certificates** list should not
  gain a certificate per run. If it does, revoke the extras and say so.
- **Not proven by any green run:** that the build works. A CI build
  differs from a Mac build only in how it is signed, but it is still a
  new build: install it from TestFlight on a real iPhone and connect
  before sending it to review, and before a submission make a sandbox
  In-App Purchase on that exact TestFlight build and see the server
  confirm it.

## If it fails

- *Cloud signing permission error* / *haven't been given access to
  cloud-managed distribution certificates*: the key is not Admin. Make an
  Admin team key and replace `ASC_API_KEY_ID` and `ASC_API_KEY_P8`.
- *No profiles for 'com.neoxify.mobile…' were found* or a profile
  missing a capability: check both App IDs under **Identifiers** still
  have Network Extensions, Personal VPN (app), App Groups and Sign in
  with Apple (app).
- *build number … is not above …*: run again with the number it names.
- altool says the version is closed, or the build is a duplicate: the
  version record is already released or the number already used; pick
  the next.
- *… in the IPA is signed without …*: the export dropped entitlements.
  Do not upload that IPA by hand; the placeholder signing step needs
  looking at.
