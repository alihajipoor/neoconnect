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
extension NeoxifyVpnPlugin {
    @objc public func signInWithApple(_ invoke: Invoke) {
        DispatchQueue.main.async {
            let request = ASAuthorizationAppleIDProvider().createRequest()
            // The address is the only thing we need and the only thing
            // asked for. Apple sends it once, on the very first consent,
            // and never again -- the backend joins on the subject for
            // exactly that reason.
            request.requestedScopes = [.email]

            let controller = ASAuthorizationController(authorizationRequests: [request])
            let delegate = AppleSignInDelegate(invoke: invoke)
            controller.delegate = delegate
            controller.presentationContextProvider = delegate
            // Same lifetime problem as the session above: performRequests()
            // returns straight away and the controller is a local, so
            // without this ARC frees it before the sheet answers.
            delegate.controller = controller
            // The delegate is the only strong reference to itself:
            // ASAuthorizationController holds both of these weakly, so
            // without this the object is deallocated before the sheet
            // returns and no callback ever fires. The sheet appears,
            // the customer signs in, and the button spins forever.
            delegate.retain()
            controller.performRequests()
        }
    }

    @objc public func openAuthSession(_ invoke: Invoke) {
        struct Args: Decodable {
            let url: String
            let scheme: String
        }
        do {
            let args = try invoke.parseArgs(Args.self)
            guard let url = URL(string: args.url) else {
                invoke.reject("that sign-in address is not valid")
                return
            }
            DispatchQueue.main.async {
                let context = AuthPresentationContext()
                let session = ASWebAuthenticationSession(
                    url: url,
                    callbackURLScheme: args.scheme
                ) { callbackURL, error in
                    // Held until here so ARC does not take the session
                    // away mid-flight; releasing it now is what lets the
                    // context go too.
                    context.release()
                    if let error = error as? ASWebAuthenticationSessionError,
                       error.code == .canceledLogin {
                        // Dismissed. Not a failure: the customer knows
                        // what they just did, and an error alert here
                        // would be both wrong and alarming.
                        invoke.resolve(["url": NSNull()])
                        return
                    }
                    if let error = error {
                        invoke.reject("sign-in could not be completed: \(error.localizedDescription)")
                        return
                    }
                    guard let callbackURL = callbackURL else {
                        invoke.resolve(["url": NSNull()])
                        return
                    }
                    invoke.resolve(["url": callbackURL.absoluteString])
                }
                context.session = session
                session.presentationContextProvider = context
                // The customer's existing provider cookies are the whole
                // point: somebody already signed in to Google taps once
                // instead of typing a password. An ephemeral session
                // would ask for the password every time and lose most of
                // the reason to offer the button.
                session.prefersEphemeralWebBrowserSession = false
                context.retain()
                if !session.start() {
                    context.release()
                    invoke.reject("could not open the sign-in page")
                }
            }
        } catch {
            invoke.reject("bad arguments: \(error.localizedDescription)")
        }
    }
}

/// Somewhere to put the sheet.
///
/// Both APIs ask the app which window to present over, and both hold
/// this weakly, so it keeps itself alive across the call.
private class AuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
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

private class AppleSignInDelegate: NSObject, ASAuthorizationControllerDelegate,
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
        invoke.reject("Apple sign-in failed: \(error.localizedDescription)")
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
private func activeWindow() -> ASPresentationAnchor {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let active = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
    return active?.keyWindow ?? active?.windows.first ?? UIWindow()
}
