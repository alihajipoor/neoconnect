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
        app = XCUIApplication()

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

        for rawLine in script.split(separator: "\n") {
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
                // Everything readable, which is how the runner learns the
                // exit address and the session timer without a screenshot.
                for element in app.staticTexts.allElementsBoundByIndex where !element.label.isEmpty {
                    print("NEOXIFY-TEXT \(element.label)")
                }
            case "dump":
                print("NEOXIFY-TREE \(app.debugDescription)")
            case "screenshot":
                let shot = XCTAttachment(screenshot: app.screenshot())
                shot.name = arg.isEmpty ? "screen" : arg
                shot.lifetime = .keepAlways
                add(shot)
            default:
                XCTFail("unknown verb: \(verb)")
            }
            // Nudges the interruption monitor, which only fires on the
            // next interaction after an alert appears -- without this a
            // consent dialog sits there and every later step misses.
            app.activate()
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
            let exact = pool[needle]
            if exact.exists { return exact }
        }
        for pool in pools {
            let predicate = NSPredicate(format: "label CONTAINS[c] %@", needle)
            let found = pool.matching(predicate).allElementsBoundByIndex.first { $0.exists }
            if let found { return found }
        }
        return nil
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
