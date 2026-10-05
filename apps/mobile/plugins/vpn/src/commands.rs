//! The commands the UI calls.
//!
//! Their own module rather than the crate root, and not by taste:
//! `#[tauri::command]` emits a macro plus a `pub use` of it, and in the
//! root of a library crate those two collide with each other. Official
//! Tauri plugins put their commands in a submodule for the same reason.

use crate::{
    AppleIdentity, Apps, Empty, Granted, IapProducts, IapPurchase, IapUnfinished, Ikev2Profile,
    TunnelGone, VpnStatus, WireGuardProfile, XrayProfile,
};
// Only the mobile branch of vpn_open_auth_session names this; the
// desktop fallback returns an error without ever building one.
#[cfg(any(target_os = "android", target_os = "ios"))]
use crate::AuthCallback;
#[cfg(any(target_os = "android", target_os = "ios"))]
use crate::Vpn;
use tauri::{AppHandle, Runtime};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri::Manager;

/// Why a call cannot be served off Android.
///
/// This app has no desktop target; the fallbacks below exist so a
/// `cargo check` on the dev machine compiles and fails with a sentence
/// rather than panicking inside Tauri's state extractor.
#[allow(dead_code)]
fn unavailable() -> String {
    "The VPN engine is only available on Android".to_string()
}

/// The Kotlin handle, looked up rather than taken as a `State` argument
/// so the miss is a returned error instead of an extractor panic.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn handle<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::State<'_, Vpn<R>>, String> {
    app.try_state::<Vpn<R>>().ok_or_else(unavailable)
}

// Not every command exists on both platforms. The eight the iOS plugin
// implements are cfg'd for both; only list_apps stays Android-only,
// returning unavailable(), which is the truthful answer rather than a
// stub that fails later -- it has no iOS equivalent at all, because
// per-app routing there belongs to the system, not to the app.
//
// Seven commands, each a single forwarding call. Written out rather than
// generated: `#[tauri::command]` emits a macro named after the function,
// and expanding that from inside a `macro_rules!` collides with itself.

#[tauri::command]
pub async fn vpn_has_permission<R: Runtime>(app: AppHandle<R>) -> Result<Granted, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Granted>("hasPermission", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_request_permission<R: Runtime>(app: AppHandle<R>) -> Result<Granted, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Granted>("requestPermission", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_connect_wireguard<R: Runtime>(
    app: AppHandle<R>,
    profile: WireGuardProfile,
) -> Result<Empty, String> {
    // iOS as well. It runs wireguard-go inside the same packet-tunnel
    // extension as Xray rather than a second one, because iOS allows a
    // tunnel extension only one principal class -- the provider picks
    // the engine from which key the profile arrived under. `allowedApps`
    // is ignored there: per-app routing on iOS belongs to the system.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("connectWireguard", profile)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, profile);
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_connect_xray<R: Runtime>(
    app: AppHandle<R>,
    profile: XrayProfile,
) -> Result<Empty, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("connectXray", profile)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, profile);
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_connect_ikev2<R: Runtime>(
    app: AppHandle<R>,
    profile: Ikev2Profile,
) -> Result<Empty, String> {
    // iOS as well as Android now. Both dial it with the platform's own
    // IKEv2 client from the same username/password, so the profile
    // needed no second shape -- the iOS side maps `server` to both the
    // address and the remote identifier, which is what Android's
    // `Ikev2VpnProfile.Builder(server, server)` already did.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("connectIkev2", profile)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = (app, profile);
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_disconnect<R: Runtime>(app: AppHandle<R>) -> Result<Empty, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("disconnect", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

/// Disconnects, and removes the credentials the platform keeps in its
/// own VPN settings. Called when the customer's session ends.
///
/// Both platforms let a saved profile be switched on from the system's
/// Settings with the app signed out -- Android's platform IKEv2 profile,
/// iOS's tunnel profile and its IKEv2 one -- so a sign-out that only
/// stopped the tunnel left the previous customer's tunnel one tap away.
/// Separate from `vpn_disconnect` because the connect ladder calls that
/// between rungs and must not erase the profile it is about to dial.
#[tauri::command]
pub async fn vpn_forget_profiles<R: Runtime>(app: AppHandle<R>) -> Result<Empty, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("forgetProfiles", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

/// Whether the device has stopped being routed through a VPN.
///
/// Split out from `vpn_disconnect` so the teardown itself never blocks:
/// the connect ladder disconnects between rungs, and a wait inside the
/// disconnect ran once per protocol it tried. The dashboard polls this
/// after a customer asks to disconnect, and only then says it happened.
#[tauri::command]
pub async fn vpn_tunnel_gone<R: Runtime>(app: AppHandle<R>) -> Result<TunnelGone, String> {
    // iOS as well. While this was Android-only the dashboard's teardown
    // poll errored on every call, which its catch swallowed -- so every
    // disconnect on iOS ran the full eight-second wait and then reported
    // that the tunnel was still up.
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<TunnelGone>("tunnelGone", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_status<R: Runtime>(app: AppHandle<R>) -> Result<VpnStatus, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<VpnStatus>("status", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Err(unavailable())
    }
}

#[tauri::command]
pub async fn vpn_list_apps<R: Runtime>(app: AppHandle<R>) -> Result<Apps, String> {
    #[cfg(target_os = "android")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<Apps>("listApps", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err(unavailable())
    }
}

/// Sign in with Apple, through the system sheet.
///
/// iOS only, and not by preference: `AuthenticationServices`' native
/// sheet is an Apple-platform API. Everywhere else Sign in with Apple
/// means the web flow, which needs a Services ID and a signing key this
/// project has not set up -- so Android gets the same honest refusal a
/// desktop build gets rather than a sheet that cannot open.
#[tauri::command]
pub async fn vpn_sign_in_with_apple<R: Runtime>(app: AppHandle<R>) -> Result<AppleIdentity, String> {
    #[cfg(target_os = "ios")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<AppleIdentity>("signInWithApple", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Err("Sign in with Apple is only available on iOS".to_string())
    }
}

/// Opens a provider's sign-in page and waits for it to come back.
///
/// iOS uses `ASWebAuthenticationSession` and Android a Custom Tab. Both
/// are the platform's "sign in somewhere else and come back" primitive,
/// and both matter for the same reason an in-app WebView would not do:
/// they carry the customer's existing provider cookies, so somebody
/// already signed in to Google taps once rather than typing a password
/// into a window our app could be reading. Google refuses to serve its
/// sign-in page inside an embedded WebView at all, for exactly that
/// reason.
///
/// Returns the callback URL, or nothing if the sheet was dismissed.
#[tauri::command]
pub async fn vpn_open_auth_session<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    scheme: String,
) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            url: String,
            scheme: String,
        }
        handle(&app)?
            .0
            .run_mobile_plugin::<AuthCallback>("openAuthSession", Args { url, scheme })
            .map(|c| c.url)
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        // The desktop client does not come through here at all: it opens
        // the real browser and catches the neoconnect:// link the
        // deep-link plugin already registers. See social-auth.ts.
        let _ = (app, url, scheme);
        Err(unavailable())
    }
}

/// The plans this build can sell, priced by the App Store.
///
/// iOS only. Android sells nothing in-app -- Play builds carry no
/// purchase surface either -- and the desktop client sends people to
/// the web checkout, which needs none of this.
#[tauri::command]
pub async fn vpn_iap_products<R: Runtime>(
    app: AppHandle<R>,
    product_ids: Vec<String>,
) -> Result<IapProducts, String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            product_ids: Vec<String>,
        }
        handle(&app)?
            .0
            .run_mobile_plugin::<IapProducts>("iapProducts", Args { product_ids })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, product_ids);
        Err("In-app purchase is only available on iOS".to_string())
    }
}

/// Charges for a plan. Does NOT mark it delivered -- see
/// `vpn_iap_finish`, which is called only once the server has granted
/// the subscription.
#[tauri::command]
pub async fn vpn_iap_purchase<R: Runtime>(
    app: AppHandle<R>,
    product_id: String,
) -> Result<IapPurchase, String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            product_id: String,
        }
        handle(&app)?
            .0
            .run_mobile_plugin::<IapPurchase>("iapPurchase", Args { product_id })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, product_id);
        Err("In-app purchase is only available on iOS".to_string())
    }
}

/// Purchases that were paid for and never granted.
///
/// Swept on launch. Without it, a customer whose app died between
/// paying Apple and reaching our API has been charged for nothing, and
/// the only record left is the transaction StoreKit is still holding.
#[tauri::command]
pub async fn vpn_iap_unfinished<R: Runtime>(app: AppHandle<R>) -> Result<IapUnfinished, String> {
    #[cfg(target_os = "ios")]
    {
        handle(&app)?
            .0
            .run_mobile_plugin::<IapUnfinished>("iapUnfinished", ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
        Ok(IapUnfinished { signed_transactions: Vec::new() })
    }
}

/// Tells StoreKit the subscription has been delivered.
#[tauri::command]
pub async fn vpn_iap_finish<R: Runtime>(
    app: AppHandle<R>,
    transaction_id: Option<String>,
) -> Result<Empty, String> {
    #[cfg(target_os = "ios")]
    {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Args {
            transaction_id: Option<String>,
        }
        handle(&app)?
            .0
            .run_mobile_plugin::<Empty>("iapFinish", Args { transaction_id })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, transaction_id);
        Err(unavailable())
    }
}
