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

const ios = join(mobile, "plugins", "vpn", "ios");
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
      - path: ${rel(join(ios, "Sources", "NeoxifyTunnel"))}
    dependencies:
      # The engine, built by scripts/build-xray-xcframework.sh. embed:
      # false because an app extension must not carry its own copy -- the
      # host app embeds it and the extension links against that one.
      # Embedding it twice is rejected at submission.
      - framework: ${rel(join(ios, "Frameworks", "NeoxifyXray.xcframework"))}
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
        PRODUCT_NAME: ${EXT_TARGET}
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
    `      - framework: ${rel(join(ios, "Frameworks", "NeoxifyXray.xcframework"))}\n` +
    `        embed: true\n`,
);

// Entitlements are a key Tauri does not set, so this one is an insert.
text = text.replace(
  new RegExp(`(^  ${APP_TARGET}:\\n)`, "m"),
  `$1    entitlements:\n` +
    `      path: NeoxifyApp.entitlements\n` +
    `      properties:\n` +
    `        com.apple.developer.networking.networkextension:\n` +
    `          - packet-tunnel-provider\n` +
    `        com.apple.security.application-groups:\n` +
    `          - ${GROUP}\n`,
);

writeFileSync(spec, text);
console.log(`add-tunnel-extension: added ${EXT_TARGET} (app group ${GROUP})`);

execFileSync("xcodegen", ["generate", "--spec", spec, "--project", apple], { stdio: "inherit" });
console.log("add-tunnel-extension: xcodeproj regenerated");
