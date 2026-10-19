//! The HTTP scope for the hosts a signed endpoint bundle names, granted
//! at run time.
//!
//! The capability scope written at build time (capabilities/default.json,
//! from the seed bundle) is all the HTTP plugin will reach. So a newer
//! bundle -- the mechanism for moving customers whose addresses were
//! blocked, without a release they cannot download -- could only ever
//! move them between hosts the build already knew. A new domain, or a
//! bare IP address, needed a release; on 2026-10-17 every domain the
//! mirrors used was blocked in Iran, and the one with room left under the
//! build's wildcards was all there was to move to.
//!
//! This command takes a bundle's signed envelope, checks the signature
//! itself -- with the same compiled-in keys as endpoint-bundle.ts, never
//! trusting the webview's word that it was checked -- and adds a runtime
//! capability letting the HTTP plugin reach that bundle's `panel` and
//! `mirror` hosts. Nothing unsigned can widen the scope, so a page in the
//! webview gains no host the owner did not sign for.
//!
//! An envelope is signed by a compiled-in key, or by a server key that a
//! compiled-in key vouches for until it expires (`cert`, a
//! `neoxify-bundle-key` statement; see `ServerKeyStatement` in
//! endpoint-bundle.ts, which checks it the same way).
//!
//! Hosts are only ever added, for the life of the process: Tauri cannot
//! take a capability back, and a host a newer bundle dropped is one the
//! client stops asking anyway. Each is held to plain DNS-name or IPv4
//! characters before it becomes a URL pattern -- the plugin parses every
//! pattern on every request, and one that did not parse would fail them
//! all.
//!
//! The mobile app compiles this file by path (apps/mobile/src-tauri/
//! src/lib.rs), as it does relay_http.rs. Changes here ship in both.

use std::collections::BTreeSet;
use std::net::Ipv4Addr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde_json::{json, Value};
use tauri::ipc::CapabilityBuilder;
use tauri::{Manager, Runtime};

/// The compiled-in keys, by id: `BUNDLE_KEYS` in endpoint-bundle.ts,
/// which bundle-scope-keys.test.ts holds this list to.
const BUNDLE_KEYS: [(&str, &str); 2] = [
    ("primary", "I7JX0c+ynlt9n51qwQUVeqKAfN0kVJ5D4LFMxMr0n/g="),
    ("backup", "BJ3ROKfvxHbec/Zq7jGdUweQEUr2K6VspEPRlEveYsI="),
];

/// `SERVER_KEY_STATEMENT_KIND` in endpoint-bundle.ts.
const STATEMENT_KIND: &str = "neoxify-bundle-key";

/// The window the scope is granted to: each app has one.
const WINDOW: &str = "main";

/// Hosts granted so far in this run. Read before granting so a bundle
/// adds only what is new, and so every capability gets an identifier of
/// its own.
static GRANTED: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Why an envelope grants nothing. A short fixed vocabulary, never the
/// envelope or a host: it is returned to the webview.
type Refusal = &'static str;

fn compiled_key(keys: &[(&str, &str)], id: &str) -> Option<Vec<u8>> {
    let (_, key) = keys.iter().find(|(name, _)| *name == id)?;
    STANDARD.decode(key).ok()
}

/// The decoded payload, if `sig` is `key`'s Ed25519 signature over it.
fn signed_by(payload: &str, sig: &str, key: &[u8]) -> Result<Vec<u8>, Refusal> {
    let payload = STANDARD.decode(payload).map_err(|_| "payload is not base64")?;
    let sig = STANDARD.decode(sig).map_err(|_| "signature is not base64")?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(&payload, &sig)
        .map_err(|_| "bad signature")?;
    Ok(payload)
}

/// The public key the envelope must be signed with: a compiled-in one by
/// id, or the server key in a `cert` a compiled-in key signed, unexpired
/// at `now` (Unix seconds).
fn envelope_signer(envelope: &Value, keys: &[(&str, &str)], now: u64) -> Result<Vec<u8>, Refusal> {
    let id = envelope["key"].as_str().ok_or("no key id")?;
    if let Some(key) = compiled_key(keys, id) {
        return Ok(key);
    }
    let cert = envelope.get("cert").and_then(Value::as_object).ok_or("unknown key")?;
    let (Some(payload), Some(sig), Some(by)) = (
        cert.get("payload").and_then(Value::as_str),
        cert.get("sig").and_then(Value::as_str),
        cert.get("key").and_then(Value::as_str),
    ) else {
        return Err("malformed statement");
    };
    // Vouched for by a compiled-in key and only by one: a statement signed
    // by a server key would let one leaked key mint the next.
    let root = compiled_key(keys, by).ok_or("statement not by a compiled-in key")?;
    let statement: Value =
        serde_json::from_slice(&signed_by(payload, sig, &root)?).map_err(|_| "statement is not JSON")?;
    if statement["kind"].as_str() != Some(STATEMENT_KIND) {
        return Err("not a key statement");
    }
    if statement["id"].as_str() != Some(id) {
        return Err("statement is for another key");
    }
    let expires = statement["expires"].as_f64().filter(|e| e.is_finite()).ok_or("no expiry")?;
    if (now as f64) >= expires {
        return Err("statement expired");
    }
    let key = statement["publicKey"]
        .as_str()
        .and_then(|k| STANDARD.decode(k).ok())
        .filter(|k| k.len() == 32)
        .ok_or("bad server key")?;
    Ok(key)
}

/// Whether `name` is a host this command will turn into a URL pattern:
/// lower-case letters, digits and hyphens in dot-separated labels, which
/// is what a parsed URL leaves of any DNS name, punycode included.
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// The hosts of the `panel` and `mirror` entries of a verified payload.
/// `lastResort` entries never reach the HTTP plugin (relay_http.rs sends
/// those), and anything that is not https is not an endpoint at all.
fn bundle_hosts(payload: &[u8]) -> Result<BTreeSet<String>, Refusal> {
    let bundle: Value = serde_json::from_slice(payload).map_err(|_| "payload is not JSON")?;
    let endpoints = bundle["endpoints"].as_array().ok_or("no endpoints")?;
    let mut hosts = BTreeSet::new();
    for entry in endpoints {
        if !matches!(entry["kind"].as_str(), Some("panel" | "mirror")) {
            continue;
        }
        let Some(url) = entry["url"].as_str().filter(|u| u.starts_with("https://")) else {
            continue;
        };
        let Ok(parsed) = tauri::Url::parse(url) else {
            continue;
        };
        let Some(host) = parsed.host_str() else {
            continue;
        };
        if host.parse::<Ipv4Addr>().is_ok() || plain_name(host) {
            hosts.insert(host.to_owned());
        }
    }
    Ok(hosts)
}

/// The hosts a genuine envelope names, or why it names none.
fn verified_hosts(raw: &str, keys: &[(&str, &str)], now: u64) -> Result<BTreeSet<String>, Refusal> {
    let envelope: Value = serde_json::from_str(raw).map_err(|_| "envelope is not JSON")?;
    let (Some(payload), Some(sig)) = (envelope["payload"].as_str(), envelope["sig"].as_str()) else {
        return Err("malformed envelope");
    };
    let signer = envelope_signer(&envelope, keys, now)?;
    bundle_hosts(&signed_by(payload, sig, &signer)?)
}

/// The scope entries for one host: on any path, on the default port and
/// on any other -- the same two shapes apply-capability-scope.mjs writes.
fn patterns(host: &str) -> [Value; 2] {
    [json!({ "url": format!("https://{host}/*") }), json!({ "url": format!("https://{host}:*/*") })]
}

/// Lets the HTTP plugin reach the hosts of a genuine bundle; returns the
/// hosts this call added (none when all were granted before).
#[tauri::command]
pub async fn grant_bundle_scope<R: Runtime>(app: tauri::AppHandle<R>, envelope: String) -> Result<Vec<String>, String> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let hosts = verified_hosts(&envelope, &BUNDLE_KEYS, now).map_err(|why| format!("bundle scope: {why}"))?;
    grant_hosts(&app, hosts)
}

/// Adds one runtime capability for those of `hosts` not granted before.
/// Only ever handed hosts that passed `plain_name` or parse as IPv4.
pub(crate) fn grant_hosts<R: Runtime>(app: &tauri::AppHandle<R>, hosts: BTreeSet<String>) -> Result<Vec<String>, String> {
    let mut granted = GRANTED.lock().map_err(|_| "bundle scope: unavailable".to_owned())?;
    let new: Vec<String> = hosts.into_iter().filter(|host| !granted.contains(host)).collect();
    if new.is_empty() {
        return Ok(new);
    }
    let allow: Vec<Value> = new.iter().flat_map(|host| patterns(host)).collect();
    let capability = CapabilityBuilder::new(format!("bundle-hosts-{}", granted.len()))
        .window(WINDOW)
        .permission_scoped("http:default", allow, Vec::<Value>::new());
    app.add_capability(capability)
        .map_err(|_| "bundle scope: not granted".to_owned())?;
    granted.extend(new.iter().cloned());
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn keypair() -> Ed25519KeyPair {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap()
    }

    fn b64(bytes: &[u8]) -> String {
        STANDARD.encode(bytes)
    }

    const NOW: u64 = 1_792_300_000;

    fn bundle() -> Value {
        json!({ "v": 7, "issuedAt": "x", "endpoints": [
            { "kind": "panel", "url": "https://edge.example.net/api" },
            { "kind": "mirror", "url": "https://a5.example.org:2096/api", "region": "de" },
            { "kind": "mirror", "url": "https://198.51.100.7:2096/api" },
            { "kind": "lastResort", "url": "https://203.0.113.9:4433/api", "pins": ["sha256/x"] },
            { "kind": "panel", "url": "http://plain.example.net/api" },
            { "kind": "panel", "url": "https://[2001:db8::1]/api" },
        ]})
    }

    /// An envelope a root key signs, and the key list that knows it.
    fn rooted(root: &Ed25519KeyPair, id: &'static str, payload: &Value) -> (String, String) {
        let bytes = serde_json::to_vec(payload).unwrap();
        let envelope = json!({ "payload": b64(&bytes), "sig": b64(root.sign(&bytes).as_ref()), "key": id });
        (envelope.to_string(), b64(root.public_key().as_ref()))
    }

    /// An envelope a server key signs, under `statement` signed by `root`.
    fn served(root: &Ed25519KeyPair, statement: Value, server: &Ed25519KeyPair, key: &str) -> String {
        let statement = serde_json::to_vec(&statement).unwrap();
        let payload = serde_json::to_vec(&bundle()).unwrap();
        json!({
            "payload": b64(&payload), "sig": b64(server.sign(&payload).as_ref()), "key": key,
            "cert": { "payload": b64(&statement), "sig": b64(root.sign(&statement).as_ref()), "key": "primary" },
        })
        .to_string()
    }

    fn statement(server: &Ed25519KeyPair) -> Value {
        json!({ "kind": STATEMENT_KIND, "id": "server-1", "publicKey": b64(server.public_key().as_ref()), "expires": NOW + 60 })
    }

    fn hosts(list: &[&str]) -> BTreeSet<String> {
        list.iter().map(|h| (*h).to_owned()).collect()
    }

    #[test]
    fn grants_the_panel_and_mirror_hosts_of_a_root_signed_list() {
        let root = keypair();
        let (raw, public) = rooted(&root, "primary", &bundle());
        let keys = [("primary", public.as_str())];
        assert_eq!(
            verified_hosts(&raw, &keys, NOW),
            Ok(hosts(&["198.51.100.7", "a5.example.org", "edge.example.net"]))
        );
    }

    #[test]
    fn refuses_a_list_altered_after_signing() {
        let root = keypair();
        let (raw, public) = rooted(&root, "primary", &bundle());
        let mut envelope: Value = serde_json::from_str(&raw).unwrap();
        let forged = json!({ "v": 7, "issuedAt": "x", "endpoints": [{ "kind": "panel", "url": "https://attacker.example/api" }] });
        envelope["payload"] = Value::String(b64(&serde_json::to_vec(&forged).unwrap()));
        assert_eq!(verified_hosts(&envelope.to_string(), &[("primary", public.as_str())], NOW), Err("bad signature"));
    }

    #[test]
    fn refuses_a_key_it_does_not_know() {
        let root = keypair();
        let (raw, _) = rooted(&root, "primary", &bundle());
        let other = b64(keypair().public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", other.as_str())], NOW), Err("bad signature"));
        assert_eq!(verified_hosts(&raw, &[("backup", other.as_str())], NOW), Err("unknown key"));
    }

    #[test]
    fn grants_a_list_a_vouched_server_key_signed() {
        let (root, server) = (keypair(), keypair());
        let raw = served(&root, statement(&server), &server, "server-1");
        let public = b64(root.public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", public.as_str())], NOW).map(|h| h.len()), Ok(3));
    }

    #[test]
    fn refuses_an_expired_statement() {
        let (root, server) = (keypair(), keypair());
        let raw = served(&root, statement(&server), &server, "server-1");
        let public = b64(root.public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", public.as_str())], NOW + 60), Err("statement expired"));
    }

    #[test]
    fn refuses_a_statement_no_compiled_in_key_signed() {
        let (root, server) = (keypair(), keypair());
        let raw = served(&root, statement(&server), &server, "server-1");
        let other = b64(keypair().public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", other.as_str())], NOW), Err("bad signature"));
    }

    #[test]
    fn refuses_a_statement_for_another_key() {
        let (root, server) = (keypair(), keypair());
        let raw = served(&root, statement(&server), &server, "server-2");
        let public = b64(root.public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", public.as_str())], NOW), Err("statement is for another key"));
    }

    #[test]
    fn refuses_a_statement_of_another_kind() {
        let (root, server) = (keypair(), keypair());
        let mut wrong = statement(&server);
        wrong["kind"] = json!("something-else");
        let raw = served(&root, wrong, &server, "server-1");
        let public = b64(root.public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", public.as_str())], NOW), Err("not a key statement"));
    }

    // Checked against the compiled-in key of that name, which did not sign.
    #[test]
    fn refuses_a_server_key_using_a_compiled_in_name() {
        let (root, server) = (keypair(), keypair());
        let raw = served(&root, statement(&server), &server, "primary");
        let public = b64(root.public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", public.as_str())], NOW), Err("bad signature"));
    }

    #[test]
    fn refuses_a_server_key_that_is_not_32_bytes() {
        let (root, server) = (keypair(), keypair());
        let mut short = statement(&server);
        short["publicKey"] = json!(b64(b"short"));
        let raw = served(&root, short, &server, "server-1");
        let public = b64(root.public_key().as_ref());
        assert_eq!(verified_hosts(&raw, &[("primary", public.as_str())], NOW), Err("bad server key"));
    }

    #[test]
    fn keeps_only_plain_names_and_ipv4_addresses() {
        assert!(plain_name("mirror-1.example.org"));
        assert!(plain_name("xn--mgba3a4f16a.ir"));
        for bad in ["", "a..b", "*.example.net", "a{b}.net", "a:1", "-".repeat(64).as_str(), "UPPER.example"] {
            assert!(!plain_name(bad), "{bad}");
        }
    }

    #[test]
    fn writes_the_two_pattern_shapes_the_build_writes() {
        assert_eq!(
            patterns("a5.example.org"),
            [json!({ "url": "https://a5.example.org/*" }), json!({ "url": "https://a5.example.org:*/*" })]
        );
    }

    #[test]
    fn answers_junk_with_a_refusal_rather_than_a_panic() {
        for junk in ["", "{", "null", "[]", r#"{"payload":"!!","sig":"!!","key":"primary"}"#] {
            assert!(verified_hosts(junk, &BUNDLE_KEYS, NOW).is_err(), "{junk}");
        }
    }
}
