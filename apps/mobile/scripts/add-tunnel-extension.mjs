#!/usr/bin/env node
/** Adds the packet-tunnel extension to the generated Xcode project.
 *
 * `tauri ios init` writes gen/apple from its own templates and will
 * happily overwrite it, so the extension cannot simply be added in Xcode
 * and committed -- the next init would erase it. This patches the
 * XcodeGen spec instead and re-runs xcodegen, which makes the extension a
 * property of the build rather than of one developer's checkout.
 *
 * Idempotent: running it twice is a no-op, so it can sit in front of
 * every build without a guard at the call site.
 *
 * A VPN on iOS has to live in an extension. The app process cannot carry
 * packets; it can only ask the system to start a provider, which runs
 * separately with its own entitlement and its own memory budget.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "..");
const apple = join(mobile, "src-tauri", "gen", "apple");
const spec = join(apple, "project.yml");

if (!existsSync(spec)) {
  console.error(`add-tunnel-extension: ${relative(mobile, spec)} not found -- run \`tauri ios init\` first`);
  process.exit(1);
}

const APP_TARGET = "mobile_iOS";
const EXT_TARGET = "NeoxifyTunnel";
const GROUP = "group.com.neoxify.mobile";
const DEPLOYMENT_TARGET = "15.0";

// The extension's own sources and engine. Separate from plugins/vpn/ios,
// which is the Tauri plugin Swift package for the app process -- the two
// are built into different binaries and must not share a directory.
const tunnel = join(mobile, "plugins", "vpn", "tunnel");

// The signing team, for the extension only.
//
// Tauri sets DEVELOPMENT_TEAM on the app target from this variable and
// knows nothing about the extension, so without this the app signs and
// the extension does not -- "Signing for NeoxifyTunnel requires a
// development team", pointing at an editor pane that does not exist for
// a generated project.
//
// Read from the environment rather than written down. It is not a
// secret -- it is in the subject of every certificate the team issues --
// but a generated project is the wrong place to fix an identity, and CI
// signs nothing.
const team = process.env.APPLE_DEVELOPMENT_TEAM
  ? `\n        DEVELOPMENT_TEAM: ${process.env.APPLE_DEVELOPMENT_TEAM}`
  : "";
// One directory per bundle, because the file has to be called
// PrivacyInfo.xcprivacy on disk. XcodeGen's `name:` renames the
// reference in the project navigator, not the file that gets copied,
// so two manifests cannot share a folder.
const privacy = (bundle) => join(mobile, "ios", "privacy", bundle);

// Read from tauri.conf.json rather than written down here. An app
// extension's CFBundleShortVersionString must equal its parent app's --
// Xcode says so as a warning, and App Store Connect rejects the upload
// outright. Tauri sets the app's from this file and sets nothing on the
// extension, so it defaulted to XcodeGen's 1.0 and the mismatch would
// only have surfaced on the first real submission.
const version = JSON.parse(
  readFileSync(join(mobile, "src-tauri", "tauri.conf.json"), "utf8"),
).version;
if (!version) {
  console.error("add-tunnel-extension: no version in tauri.conf.json");
  process.exit(1);
}
const rel = (p) => relative(apple, p);

let text = readFileSync(spec, "utf8");

// Re-applied rather than skipped when the target is already there.
// `tauri ios init` leaves an existing project.yml alone, so a spec
// patched by an older version of this script survives -- and a bare
// "already present" guard then silently keeps it, which is how a
// linker flag added here failed to reach the build that needed it.
// Stripping first means the spec always matches this file.
const existing = new RegExp(`\\n  ${EXT_TARGET}:\\n(?:[ ]{4,}.*\\n|\\n)*`, "g");
text = text.replace(existing, "\n");
// Same for the app-target block this script adds, so it is not stacked
// on top of itself.
text = text.replace(
  new RegExp(`(^  ${APP_TARGET}:\\n)    entitlements:\\n(?:      .*\\n)*`, "m"),
  "$1",
);
// and the two dependency entries this script appends
text = text.replace(new RegExp(`^      - target: ${EXT_TARGET}\\n`, "m"), "");
text = text.replace(
  /^      - framework: .*NeoxifyXray\.xcframework\n        embed: true\n/m,
  "",
);

// Edited as text, not parsed and re-emitted. project.yml is generated,
// and a YAML round-trip would reorder and reformat everything Tauri
// wrote, turning a small addition into an unreviewable diff and hiding
// what actually changed the next time Tauri's template moves.
const extension = `
  ${EXT_TARGET}:
    type: app-extension
    platform: iOS
    sources:
      - path: ${rel(join(tunnel, "Sources", "NeoxifyTunnel"))}
      # The extension's privacy manifest. It reaches a required-reason
      # API the host app does not (mach_absolute_time), so it needs its
      # own rather than relying on the app's.
      - path: ${rel(join(privacy("tunnel"), "PrivacyInfo.xcprivacy"))}
        buildPhase: resources
    dependencies:
      # The engine, built by scripts/build-xray-xcframework.sh. embed:
      # false because an app extension must not carry its own copy -- the
      # host app embeds it and the extension links against that one.
      # Embedding it twice is rejected at submission.
      - framework: ${rel(join(tunnel, "Frameworks", "NeoxifyXray.xcframework"))}
        embed: false
    # Declared here rather than pointed at a committed file. XcodeGen's
    # \`info.path\` and \`entitlements.path\` mean "generate one here", not
    # "use this one" -- given a path into the repo it overwrites it, which
    # silently stripped NSExtension from a hand-written plist and produced
    # an extension the system would not recognise as a tunnel provider at
    # all. Generating into gen/apple keeps the clobbering where it belongs.
    info:
      path: NeoxifyTunnel-Info.plist
      properties:
        CFBundleDisplayName: Neoxify Tunnel
        CFBundlePackageType: XPC!
        CFBundleShortVersionString: "${version}"
        CFBundleVersion: "${version}"
        NSExtension:
          # Resolved through the Objective-C runtime, which is why the
          # Swift class is @objc(PacketTunnelProvider). A mangled name
          # here fails to start with nothing that says why.
          NSExtensionPointIdentifier: com.apple.networkextension.packet-tunnel
          NSExtensionPrincipalClass: PacketTunnelProvider
    entitlements:
      path: NeoxifyTunnel.entitlements
      properties:
        com.apple.developer.networking.networkextension:
          - packet-tunnel-provider
        com.apple.security.application-groups:
          - ${GROUP}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.neoxify.mobile.tunnel
        PRODUCT_NAME: ${EXT_TARGET}${team}
        # Go's net package calls into the system resolver, so the
        # framework leaves _res_9_nsearch undefined until libresolv is
        # linked. Without it the extension fails at link time with a
        # symbol that names nothing recognisable from this codebase.
        OTHER_LDFLAGS: -lresolv
        # The extension bundle lives inside the app, so its deployment
        # target may not be older than the app's.
        IPHONEOS_DEPLOYMENT_TARGET: "${DEPLOYMENT_TARGET}"
        SWIFT_VERSION: "5.0"
`;

// The whole project's floor, not just the extension's. Tauri writes
// 14.0 and ignores bundle.iOS.minimumSystemVersion, and the iOS 27 SDK
// refuses to build a simulator target that old -- so the app fails
// before the extension is even reached. Raised here because this script
// is the one thing that always runs after Tauri regenerates the spec.
text = text.replace(/^(\s*iOS:\s*)14\.0\s*$/m, `$1${DEPLOYMENT_TARGET}`);

// The extension target itself.
text = text.replace(/^targets:\n/m, `targets:\n${extension}`);

// And the app: it embeds the extension, links the engine, and carries
// the matching entitlement. Without the app-side entitlement the system
// refuses to install the profile at all, with an error naming the app
// rather than the extension.
//
// Appended into Tauri's existing `dependencies:` list, not added as a
// second one. A duplicate key is valid YAML and silently keeps only the
// last -- which dropped Tauri's own libapp.a and Swift packages, and
// surfaced as the app being compiled against the macOS SDK and failing
// on WebKit, a mile from the actual cause.
const appDeps = new RegExp(`(^  ${APP_TARGET}:\\n(?:.*\\n)*?    dependencies:\\n)`, "m");
if (!appDeps.test(text)) {
  console.error(`add-tunnel-extension: no dependencies list found on ${APP_TARGET}`);
  process.exit(1);
}
text = text.replace(
  appDeps,
  `$1      - target: ${EXT_TARGET}\n` +
    `      - framework: ${rel(join(tunnel, "Frameworks", "NeoxifyXray.xcframework"))}\n` +
    `        embed: true\n`,
);

// The app's own additions. Stripped before being re-added, for the
// same reason the extension block is: Tauri regenerates project.yml on
// `ios init`, but this script also gets run against an already-patched
// spec, and without a strip each run appended another copy. Four
// identical PrivacyInfo entries is what that looked like.
const PRIVACY_SOURCE = `      - path: ${rel(join(privacy("app"), "PrivacyInfo.xcprivacy"))}\n        buildPhase: resources\n`;
text = text.split(PRIVACY_SOURCE).join("");
// An earlier version of this script added a second `entitlements:` key
// here. See below for why that was wrong; this removes it from a spec
// that still carries one.
text = text.replace(
  /^    entitlements:\n      path: NeoxifyApp\.entitlements\n(?:[ ]{6,}.*\n)*/m,
  "",
);
// And the properties this script adds to Tauri's own entitlements
// block. Without this a second run appends a second `properties:` --
// harmless only because both copies say the same thing, which is the
// kind of "harmless" that stops being true the moment one changes.
//
// Anchored on the app target, not just on `entitlements:`. The
// extension's block appears first in the file, so an unanchored match
// stripped that one instead -- invisibly, because the extension block
// is rebuilt from scratch on every run, leaving the app's copies to go
// on accumulating.
text = text.replace(
  new RegExp(
    `(^  ${APP_TARGET}:\\n(?:.*\\n)*?    entitlements:\\n      path: .*\\n)` +
      // One or more: a spec that already accumulated several has to
      // come back to exactly one, and a single-block strip would just
      // remove one and re-add one for ever.
      `(?:      properties:\\n(?:[ ]{8,}.*\\n)*)+`,
    "m",
  ),
  "$1",
);

// The app's privacy manifest. Required at the bundle root since spring
// 2024 -- an upload without one is rejected before review sees it.
//
// Appended into Tauri's existing `sources:` for the same reason the
// dependencies are: a second `sources:` key is valid YAML and silently
// wins, which would drop Assets.xcassets and the launch screen and
// produce an app with no icon.
const appSources = new RegExp(`(^  ${APP_TARGET}:\\n(?:.*\\n)*?    sources:\\n)`, "m");
if (!appSources.test(text)) {
  console.error(`add-tunnel-extension: no sources list found on ${APP_TARGET}`);
  process.exit(1);
}
text = text.replace(appSources, `$1${PRIVACY_SOURCE}`);

// The app's entitlements, merged into the block Tauri already writes
// rather than added as a second one.
//
// This is the duplicate-key trap again, and it had already bitten: the
// app target arrives with `entitlements: path: mobile_iOS/
// mobile_iOS.entitlements` and no properties, so inserting our own
// `entitlements:` key produced two, YAML kept the last, and the app was
// signed with Tauri's empty <dict/>. Nothing said so. The simulator does
// not enforce entitlements, so the app built, installed and ran -- it
// would have failed on the first real device, or at submission, with an
// error naming the provisioning profile rather than this file.
//
// So: keep Tauri's path, and give that block the properties it lacks.
const appEntitlements = new RegExp(
  `(^  ${APP_TARGET}:\\n(?:.*\\n)*?    entitlements:\\n      path: .*\\n)`,
  "m",
);
if (!appEntitlements.test(text)) {
  console.error(`add-tunnel-extension: no entitlements block found on ${APP_TARGET}`);
  process.exit(1);
}
text = text.replace(
  appEntitlements,
  `$1      properties:\n` +
    `        com.apple.developer.networking.networkextension:\n` +
    `          - packet-tunnel-provider\n` +
    // Personal VPN, a different capability from the packet tunnel and
    // not implied by it. IKEv2 goes through NEVPNManager rather than
    // our extension, and without this the profile save fails with a
    // permission error naming nothing. It also has to be enabled on the
    // App ID in the developer portal -- an entitlement the profile does
    // not grant is a signing failure, not a runtime one.
    `        com.apple.developer.networking.vpn.api:\n` +
    `          - allow-vpn\n` +
    `        com.apple.security.application-groups:\n` +
    `          - ${GROUP}\n`,
);

writeFileSync(spec, text);
console.log(`add-tunnel-extension: added ${EXT_TARGET} (app group ${GROUP})`);

execFileSync("xcodegen", ["generate", "--spec", spec, "--project", apple], { stdio: "inherit" });
console.log("add-tunnel-extension: xcodeproj regenerated");
