// Adds the UI test target to the generated Xcode project.
//
// Separate from add-tunnel-extension.mjs, and not part of a normal
// build: a UI test bundle is only wanted when something is going to
// drive the phone, and it should not be signed or embedded otherwise.
// Run it after that script, which regenerates the project from the same
// spec.
//
// Exists because devicectl cannot touch a device. It installs,
// launches, reboots and screenshots, and Apple exposes no tap API for
// physical hardware at all -- so XCUITest is the only supported way to
// drive the app on the phone, and the tunnel cannot be exercised
// anywhere else because the simulator does not run a Network Extension.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const mobile = join(here, "..");
const apple = join(mobile, "src-tauri", "gen", "apple");
const spec = join(apple, "project.yml");
const TARGET = "NeoxifyUITests";
const APP = "mobile_iOS";
const team = process.env.APPLE_DEVELOPMENT_TEAM ?? "";

// The script is baked into the scheme rather than passed at run time.
// xcodebuild's TEST_RUNNER_<NAME> did not reach the runner -- the test
// fell back to its default every time, silently, which looks exactly
// like a harness that does not work. Regenerating is a second and
// removes the guesswork.

let text = readFileSync(spec, "utf8");

// Strip and reapply, like the extension script, so running twice is
// the same as running once.
text = text.replace(new RegExp(`\\n  ${TARGET}:\\n(?:[ ]{4,}.*\\n|\\n)*`, "g"), "\n");
text = text.replace(/\nschemes:\n(?:[ ]{2,}.*\n|\n)*/g, "\n");

const rel = relative(apple, join(mobile, "uitests"));
const target = `
  ${TARGET}:
    type: bundle.ui-testing
    platform: iOS
    sources:
      - path: ${rel}
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.neoxify.mobile.uitests
        # TEST_TARGET_NAME is what tells XCUITest which app it drives.
        # Without it, XCUIApplication(bundleIdentifier:) never resolves --
        # debugDescription returns only the query chain and every lookup
        # misses, which looks like an empty screen rather than a missing
        # setting.
        #
        # The scheme still builds only this target, so the app's Build
        # Rust Code phase -- which needs an RPC server only tauri ios
        # build starts -- is not run.
        TEST_TARGET_NAME: ${APP}
        # No dependency on the app target, for that same reason.
        # Either one makes this scheme build the app target, whose Build
        # Rust Code phase shells out to tauri ios xcode-script and needs
        # an RPC server only tauri ios build starts -- so the test run
        # dies on a refused connection to localhost, a mile from anything
        # to do with testing. The test attaches to the installed app by
        # bundle id instead.
        IPHONEOS_DEPLOYMENT_TARGET: "15.0"
        SWIFT_VERSION: "5.0"${team ? `\n        DEVELOPMENT_TEAM: ${team}` : ""}
`;
text = text.replace(/^targets:\n/m, `targets:\n${target}`);

// An explicit scheme. `xcodebuild test` needs one that builds the app
// and runs this bundle; the per-target schemes XcodeGen writes by
// default do not pair them.
text += `
schemes:
  ${TARGET}:
    build:
      targets:
        ${TARGET}: [test]
    test:
      targets:
        - ${TARGET}
      environmentVariables:
        NEOXIFY_SCRIPT: ${JSON.stringify(process.env.NEOXIFY_SCRIPT ?? "dump")}
`;

writeFileSync(spec, text);
console.log(`add-uitest-target: added ${TARGET}`);
execFileSync("xcodegen", ["generate", "--spec", spec, "--project", apple], { stdio: "inherit" });
