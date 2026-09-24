import XCTest

/// A remote control for the app on a real iPhone.
///
/// `devicectl` can install, launch and screenshot a device but cannot
/// touch it -- Apple exposes no tap API for physical hardware. XCUITest
/// is the only supported way in, so this is a single test that reads a
/// script from the environment and performs it, rather than a suite of
/// fixed cases. That means a new interaction costs a string, not a
/// rebuild and reinstall of a test bundle.
///
/// Driven by scripts/drive-device.sh, which sets NEOXIFY_SCRIPT.
///
/// Why this exists at all: everything left to check on iOS is a
/// sequence of taps repeated per protocol -- connect, verify the exit
/// address, disconnect, change protocol, again -- and the tunnel cannot
/// be exercised any other way. The simulator does not run a Network
/// Extension.
final class RemoteControl: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = true
        // By bundle id, not XCUIApplication(), so this drives whatever
        // is already installed rather than building the app itself.
        //
        // Building it from here is not possible: the app target's "Build
        // Rust Code" phase shells out to `tauri ios xcode-script`, which
        // talks to an RPC server only `tauri ios build` starts, so a
        // plain `xcodebuild test` dies on a refused connection to
        // localhost. Decoupling also means a UI run costs seconds rather
        // than a full Rust rebuild.
        app = XCUIApplication(bundleIdentifier: "com.neoxify.mobile")

        // The VPN consent alert belongs to Springboard, not to the app,
        // and it blocks the first connect of a fresh install. An
        // interruption monitor is the only thing that can dismiss it:
        // it is not in the app's element tree at all.
        addUIInterruptionMonitor(withDescription: "system alert") { alert in
            for label in ["Allow", "OK", "Continue", "اجازه"] {
                let button = alert.buttons[label]
                if button.exists {
                    button.tap()
                    return true
                }
            }
            return false
        }
    }

    func testRunScript() throws {
        let script = ProcessInfo.processInfo.environment["NEOXIFY_SCRIPT"] ?? "dump"
        app.launch()

        // Split on both, because a multi-line value does not survive
        // being passed through xcodebuild's argument list -- the runner
        // received nothing and silently fell back to the default. A
        // semicolon-separated one-liner does survive.
        let separators = CharacterSet(charactersIn: "\n;")
        for rawLine in script.components(separatedBy: separators) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            let verb = parts[0]
            let arg = parts.count > 1 ? parts[1] : ""
            print("NEOXIFY-STEP \(line)")

            switch verb {
            case "tap":
                try tap(arg)
            case "wait":
                Thread.sleep(forTimeInterval: Double(arg) ?? 1)
            case "waitfor":
                try waitFor(arg)
            case "assert":
                let found = firstMatch(arg) != nil
                print("NEOXIFY-ASSERT \(arg) -> \(found ? "present" : "ABSENT")")
                XCTAssertTrue(found, "\(arg) is not on screen")
            case "text":
                // Parsed out of one tree snapshot, not enumerated.
                // `allElementsBoundByIndex` resolves every node, and against
                // a WKWebView that times out -- "Failed to resolve query:
                // Timed out while evaluating", which reads as the app being
                // unreachable rather than the query being too broad.
                for label in labels(in: app.debugDescription) {
                    print("NEOXIFY-TEXT \(label)")
                }
            case "dump":
                print("NEOXIFY-STATE exists=\(app.exists) state=\(app.state.rawValue)")
                print("NEOXIFY-TREE \(app.debugDescription)")
            case "screenshot":
                let shot = XCTAttachment(screenshot: app.screenshot())
                shot.name = arg.isEmpty ? "screen" : arg
                shot.lifetime = .keepAlways
                add(shot)
            default:
                XCTFail("unknown verb: \(verb)")
            }
            // No activate() here. It was meant to nudge the interruption
            // monitor, which fires on the next interaction after an alert
            // appears -- but activating an app attached by bundle id
            // fails with "Failed to launch", aborting the run after the
            // first step. The monitor fires on the taps the script does
            // anyway, which is the only time it matters.
        }
        print("NEOXIFY-DONE")
    }

    /// Matches on label, by exact hit first and then by substring, across
    /// the element kinds this app actually uses. The dashboard's controls
    /// are divs with roles rather than native buttons, so buttons alone
    /// finds almost nothing.
    private func firstMatch(_ needle: String) -> XCUIElement? {
        let pools = [app.buttons, app.staticTexts, app.otherElements, app.links, app.images]
        for pool in pools {
            let exact = pool[needle].firstMatch
            if exact.exists { return exact }
        }
        for pool in pools {
            // `.firstMatch` short-circuits; `allElementsBoundByIndex`
            // resolves the whole tree and times out on a web view.
            let predicate = NSPredicate(format: "label CONTAINS[c] %@", needle)
            let found = pool.matching(predicate).firstMatch
            if found.exists { return found }
        }
        return nil
    }

    /// Pulls the label out of each line of a tree snapshot. The snapshot
    /// prints them as `label: 'Connected'`, which is the only reliable
    /// way to read this app's text: it is a web view, so almost nothing
    /// is a native control and the element pools are close to empty.
    private func labels(in dump: String) -> [String] {
        var out: [String] = []
        for line in dump.components(separatedBy: "\n") {
            guard let range = line.range(of: "label: '") else { continue }
            let rest = line[range.upperBound...]
            guard let end = rest.range(of: "'") else { continue }
            let text = String(rest[..<end.lowerBound])
            if !text.isEmpty && !out.contains(text) { out.append(text) }
        }
        return out
    }

    private func tap(_ needle: String) throws {
        guard let element = firstMatch(needle) else {
            print("NEOXIFY-MISS \(needle)")
            XCTFail("nothing matching '\(needle)' on screen")
            return
        }
        // coordinate-tap rather than .tap(): a WKWebView element can be
        // hittable-false while still perfectly tappable, and .tap()
        // refuses in that case.
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func waitFor(_ arg: String) throws {
        let parts = arg.split(separator: " ")
        let timeout = parts.count > 1 ? Double(parts.last!) ?? 30 : 30
        let needle = parts.count > 1 ? parts.dropLast().joined(separator: " ") : arg
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if firstMatch(needle) != nil {
                print("NEOXIFY-FOUND \(needle)")
                return
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        print("NEOXIFY-TIMEOUT \(needle)")
        XCTFail("'\(needle)' did not appear within \(Int(timeout))s")
    }
}
