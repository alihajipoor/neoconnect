import AuthenticationServices
import Tauri
import UIKit

/// Signing in with a provider, on iOS.
///
/// Two mechanisms, because Apple's is a platform API and the other two
/// are not:
///
///  - Sign in with Apple is `ASAuthorizationController`. It returns an
///    identity token the backend verifies against Apple's published
///    keys, and it needs no client secret and no browser at all.
///  - Google and Facebook go through `ASWebAuthenticationSession`. That
///    is not merely convenient: Google refuses to serve its sign-in
///    page inside an embedded WebView, precisely because an app hosting
///    one can read what is typed into it. The session is the system's
///    browser, with the customer's existing cookies, isolated from us.
///
/// Both are extensions on the VPN plugin rather than a plugin of their
/// own. That is a compromise -- signing in has nothing to do with
/// carrying packets -- but a second Tauri plugin means a second Rust
/// crate, Swift package, Kotlin module and permission set for two
/// methods, and the app has exactly one native surface today.
//
// NOTE ON PLACEMENT: the two @objc methods that belong to the plugin are
// in NeoxifyVpnPlugin.swift, not here, and that is load bearing.
//
// Tauri reaches a command through `responds(to: Selector("name:"))`, so
// nothing in the binary ever references these methods statically. They
// began as an extension in this file, which compiled, linked and then
// failed at run time with "No command openAuthSession found for plugin
// neoxify-vpn": the Swift package is linked as a static archive, the
// linker pulls object files only when something in them is referenced,
// and an object file holding nothing but an unreferenced extension is
// dropped entirely. The selectors were present in the .a and absent
// from the app.
//
// Apple's usual answer is -ObjC or -force_load. Putting the methods in
// the same file as the class the plugin already links is the version
// that needs no link flag, and so cannot be lost the next time the
// Xcode project is regenerated.

/// Somewhere to put the sheet.
///
/// Both APIs ask the app which window to present over, and both hold
/// this weakly, so it keeps itself alive across the call.
class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var self_: AuthPresentationContext?

    /// The session itself.
    ///
    /// ASWebAuthenticationSession is not retained by the system while it
    /// runs: start() returns immediately, and if the only reference was
    /// a local in the calling function, ARC frees it there and the
    /// browser closes the instant it opens. Holding it here means the
    /// one retain() covers both objects and the one release() in the
    /// completion handler frees both.
    var session: ASWebAuthenticationSession?

    func retain() { self_ = self }
    func release() {
        session = nil
        self_ = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        activeWindow()
    }
}

class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate,
                                   ASAuthorizationControllerPresentationContextProviding {
    private let invoke: Invoke
    private var self_: AppleSignInDelegate?
    var controller: ASAuthorizationController?

    init(invoke: Invoke) {
        self.invoke = invoke
        super.init()
    }

    func retain() { self_ = self }
    private func release() {
        controller = nil
        self_ = nil
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        defer { release() }
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let token = String(data: tokenData, encoding: .utf8)
        else {
            invoke.reject("Apple did not return a usable sign-in")
            return
        }
        // Only the token crosses. The credential also carries an email
        // and a name on first consent, but those are unsigned claims
        // from the client -- the backend reads them out of the token it
        // has verified instead, which is the same data with a signature
        // on it.
        invoke.resolve(["identityToken": token])
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        defer { release() }
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            invoke.resolve(["identityToken": NSNull()])
            return
        }
        // A stable token, not localizedDescription.
        //
        // Apple's text is written for a developer: the no-Apple-Account
        // case arrives as "The operation couldn't be completed.
        // (com.apple.AuthenticationServices.AuthorizationError error
        // 1000.)", which is what a customer would otherwise read. It is
        // also English-only, and Persian is this product's largest
        // market. The JS side turns these into a translated sentence;
        // the real reason is logged here where it is useful.
        NSLog("[Neoxify] Apple sign-in failed: \(error)")
        let token: String
        if let authError = error as? ASAuthorizationError, authError.code == .unknown {
            // Overwhelmingly "no Apple Account signed in on this device",
            // which is the one cause the customer can actually act on.
            token = "apple-no-account"
        } else {
            token = "apple-failed"
        }
        invoke.reject(token)
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        activeWindow()
    }
}

/// The window to present over.
///
/// Walks the connected scenes rather than using the deprecated
/// `UIApplication.shared.windows`, and falls back to a fresh window so
/// this can never return an implicitly-unwrapped nil and crash the app
/// at the moment somebody tries to sign in.
func activeWindow() -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let active = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    return active?.keyWindow ?? active?.windows.first ?? UIWindow()
}
