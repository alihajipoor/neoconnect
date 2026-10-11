//! `/health/ip`, asked over IPv4 and nothing else.
//!
//! The egress check (`src/lib/egress.ts`) compares the address
//! `/health/ip` reports before connecting with the one it reports after.
//! That comparison is only worth anything when both readings are of the
//! same address family, and through tauri-plugin-http they were not
//! guaranteed to be: its reqwest client resolves through the system,
//! which on a machine with native IPv6 lists the AAAA record first, and
//! hyper's happy-eyeballs then prefers IPv6. So the baseline, taken on
//! the bare network, could be the customer's IPv6 address -- while every
//! reading taken after a full-tunnel connect is IPv4, because the
//! service blocks IPv6 machine-wide and every node is IPv4-only.
//!
//! An IPv6 string never equals an IPv4 one. So the check answered
//! "through the tunnel" on every such machine whatever IPv4 did,
//! including when IPv4 was going around the tunnel in the clear -- the
//! case it exists to catch. Binding the request to an IPv4 local address
//! makes hyper use the A records only (hyper-util's
//! `split_by_preference`), so both readings are IPv4 and the comparison
//! means what it says. IPv6 has its own instrument
//! (`vpn::probe_ipv6_egress`).
//!
//! A request that got no HTTP answer at all is an `Err`, never an
//! answer with a made-up status: the frontend tells those two apart,
//! because an error page from our own API is an outage of ours and
//! silence may be a dead tunnel.
//!
//! The mobile app compiles this file by path (`apps/mobile/src-tauri/
//! src/lib.rs`), as it does `control_plane_probe.rs`. Its tunnels are
//! IPv4 only too -- Android's VpnService blocks the family it was not
//! given, and iOS claims IPv6 only so it cannot leave beside the tunnel
//! -- so the same mismatch turned every reading of a dual-stack phone's
//! connect into a non-comparison. Changes here ship in both apps.
//!
//! Each answer also says which address the request actually connected
//! to (`HealthIpAnswer::peer`), and `resolve_ipv4` turns a server's name
//! into addresses the way the engines do. Together they let the egress
//! check recognise an endpoint that sits on the tunnel's own server:
//! where the client routes that address around the tunnel, such an
//! endpoint is asked over the customer's own line and answers with
//! their home address through a tunnel that works. Measured on
//! 2026-10-06 for Xray on Windows; which engines do it is
//! `reachesServerAround` in `src/lib/tunnel-server.ts`.
//!
//! No proxy, ever: neither `HTTPS_PROXY` nor the system's, which reqwest
//! reads on Windows. Through one, the reading is the proxy's exit rather
//! than this machine's route -- the same address before and after
//! connecting, "NOT protected" over a working tunnel -- and `peer` is the
//! proxy's address, so the tunnel's own server cannot be recognised
//! either. The question asked is where this machine's routing sends a
//! request, and a proxy answers a different one.

use std::net::{IpAddr, Ipv4Addr, ToSocketAddrs};
use std::time::Duration;

use hyper_util::client::proxy::matcher::Matcher;

/// What one `/health/ip` request came back with.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct HealthIpAnswer {
    /// The HTTP status the endpoint answered with.
    pub status: u16,
    /// The body, when it was JSON and small enough to be what this
    /// endpoint returns. `null` otherwise -- an error page, say.
    pub body: Option<serde_json::Value>,
    /// The address the request was actually made to, as connected --
    /// not as the name was expected to resolve. `null` only if the HTTP
    /// stack did not record it, which reqwest does for every connection
    /// it makes itself, TLS included.
    ///
    /// What the egress check needs it for: a `/health/ip` answer from the
    /// tunnel's own server was asked around the tunnel, not through it,
    /// and says nothing about where the tunnel's traffic leaves.
    pub peer: Option<String>,
}

/// Far more than `/health/ip` returns (an address, a country code, a
/// network number and a signed note), and a bound on what any endpoint
/// in the list can make this process hold.
const MAX_BODY_BYTES: usize = 16 * 1024;

/// The longest a caller may ask for. The frontend asks for six seconds.
const MAX_TIMEOUT: Duration = Duration::from_secs(30);

/// The same identity the app's other requests present (tauri-plugin-
/// http's default), so the CDN in front of the API treats this request
/// exactly as it already treats those.
const USER_AGENT: &str = "tauri-plugin-http/2.5.9";

/// The URL asked for a given API base, or why that base is refused.
///
/// The frontend's HTTP permission is scoped by the capability file, and
/// this command sits outside it, so it does its own narrowing: one fixed
/// path, https only, no credentials, query or fragment smuggled in
/// through the base -- and no address on this machine except in a
/// development build, which talks to a local backend (plain http
/// allowed). A release build has no local backend, and allowing one let
/// the webview have this command fetch `/health/ip` from any port on
/// loopback.
///
/// Not narrowed to our own hosts. The endpoint list grows at run time
/// from signed bundles, and the capability scope -- fixed when the app
/// was built -- is exactly what lags it (see `bundle.mjs sign
/// --previous`); a copy of that scope here would refuse the hosts the
/// egress check most needs on a network where the older ones are
/// blocked. What a hostile page could get from this is the status and a
/// small JSON body of a GET to a fixed path, without cookies or
/// credentials.
pub fn health_url(base: &str) -> Result<reqwest::Url, &'static str> {
    health_url_allowing(base, cfg!(debug_assertions))
}

/// `health_url`, with whether a local development backend is allowed
/// given explicitly so both rules can be tested from one build.
fn health_url_allowing(base: &str, local_backend: bool) -> Result<reqwest::Url, &'static str> {
    let url = reqwest::Url::parse(&format!("{}/health/ip", base.trim_end_matches('/')))
        .map_err(|_| "not a URL")?;
    // An IPv6 literal comes back from `host_str` in its brackets.
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if loopback && !local_backend {
        return Err("an address on this machine is not an API base");
    }
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err("not an https address"),
    }
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("not a plain API base");
    }
    Ok(url)
}

/// Asks one endpoint's `/health/ip`, over IPv4 only.
#[tauri::command]
pub async fn health_ip_v4(base: String, timeout_ms: u64) -> Result<HealthIpAnswer, String> {
    let url = health_url(&base).map_err(str::to_string)?;
    let timeout = Duration::from_millis(timeout_ms.max(1)).min(MAX_TIMEOUT);
    let client = reqwest::Client::builder()
        // The whole point. An IPv4 local address makes the connector
        // drop every IPv6 address the name resolves to.
        .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
        // This machine's route, not a proxy's; see the module note.
        .no_proxy()
        // A redirect would hand the reading to a different endpoint than
        // the one it is recorded against. Its status is the answer.
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .user_agent(USER_AGENT)
        .build()
        .map_err(|_| "could not build the request".to_string())?;

    // Never the error's text: it carries the URL, and what the frontend
    // needs is only that there was no answer.
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "no answer".to_string())?;
    let status = response.status().as_u16();
    // Read before the body: `chunk` borrows the response mutably.
    let peer = response.remote_addr().map(|address| address.ip().to_canonical().to_string());

    let mut bytes = Vec::new();
    let mut whole = true;
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_BODY_BYTES {
                    whole = false;
                    break;
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => {
                whole = false;
                break;
            }
        }
    }
    let body = if whole { serde_json::from_slice(&bytes).ok() } else { None };
    Ok(HealthIpAnswer { status, body, peer })
}

/// The longest a hostname is allowed to be (RFC 1035's 253 in text).
const MAX_HOSTNAME: usize = 253;

/// Whether `host` is something a resolver should be asked about at all:
/// letters, digits, dots and hyphens, of a sane length. Nothing else a
/// server name in a credential can be.
fn plain_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= MAX_HOSTNAME
        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

/// The IPv4 addresses a server name resolves to, the way the engines
/// resolve it: an address literal is itself, and a name goes to the
/// system resolver, keeping IPv4 only -- every node is IPv4-only, and
/// the route the client installs around the tunnel for its server is an
/// IPv4 one (`engines::xray::resolve_server` in the service; Windows'
/// own IKEv2 client and the phones resolve through the same system
/// resolver).
///
/// For the egress check, which has to recognise the tunnel's own server
/// in `HealthIpAnswer::peer`. Credentials name their server by address
/// today -- `connection.host` is a node's validated `publicIp` -- so this
/// mostly answers for IKEv2, which dials the node's certificate name.
///
/// Bounded: the system resolver cannot be interrupted, so it runs on a
/// thread of its own and is abandoned, not waited for, past the timeout.
///
/// `with_ipv6` keeps the name's IPv6 addresses as well, after the IPv4
/// ones. For the control-plane race's look at Iran's DNS block page
/// (`resolvesToBlockPage` in endpoint-demotion.ts): the HTTP plugin's own
/// connection tries a name's IPv6 addresses too, and a name whose IPv4
/// answer is the block page while its IPv6 answer is real is not one to
/// stop a request to. Absent, as every caller before it sends, the answer
/// is IPv4 only.
///
/// `unless_proxied` is the same look's too. It asks where the app's own
/// requests to the name connect, and when those go through a proxy
/// (`http_proxied`) this machine's resolver does not say: the answer is
/// then an error, as for a name that does not resolve, which the look
/// reads as nothing known. The resolver is not asked at all. Absent, the
/// lookup is the engines', which connect directly whatever proxy is set.
#[tauri::command]
pub async fn resolve_ipv4(
    host: String,
    timeout_ms: u64,
    with_ipv6: Option<bool>,
    unless_proxied: Option<bool>,
) -> Result<Vec<String>, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']').to_string();
    if let Ok(address) = host.parse::<IpAddr>() {
        return Ok(vec![address.to_canonical().to_string()]);
    }
    if !plain_hostname(&host) {
        return Err("not a hostname".to_string());
    }
    if unless_proxied == Some(true) && http_proxied(&host) {
        return Err("proxied".to_string());
    }
    let timeout = Duration::from_millis(timeout_ms.max(1)).min(MAX_TIMEOUT);
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let found = (host.as_str(), 0).to_socket_addrs().map(|found| found.collect::<Vec<_>>());
        // Nobody listening any more is the timeout below, already answered.
        let _ = sender.send(found);
    });
    let found = tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(timeout))
        .await
        .map_err(|_| "could not resolve".to_string())?
        .map_err(|_| "no answer in time".to_string())?
        .map_err(|_| "could not resolve".to_string())?;
    let mut addresses: Vec<String> = Vec::new();
    for address in &found {
        if let IpAddr::V4(v4) = address.ip() {
            let text = v4.to_string();
            if !addresses.contains(&text) {
                addresses.push(text);
            }
        }
    }
    if with_ipv6 == Some(true) {
        for address in &found {
            if let IpAddr::V6(v6) = address.ip() {
                // An IPv4-mapped answer is the IPv4 address it carries,
                // which the loop above has already kept if it was there.
                let text = IpAddr::V6(v6).to_canonical().to_string();
                if !addresses.contains(&text) {
                    addresses.push(text);
                }
            }
        }
    }
    Ok(addresses)
}

/// Whether the app's request to `https://{host}/` -- through tauri-plugin-
/// http, as every control-plane request is -- goes through a proxy rather
/// than to the addresses this machine's resolver gives for the name, or
/// may.
///
/// For the two things that judge a name by that resolver's answer: the
/// race's look at Iran's DNS block page (`resolve_ipv4`'s `unless_proxied`)
/// and the probe after a failed request (control_plane_probe.rs). Through a
/// proxy the request never uses that answer. It asks the proxy to connect
/// to the name, and the proxy resolves it at its own end. Psiphon, v2rayN
/// and Clash in system-proxy mode are how people in Iran get past a blocked
/// sign-in; with one of them on, a race stopped and demoted every name the
/// local resolver sent to the block page, sent nothing more to them, and
/// the screen said the network blocks Neoxify -- about requests that the
/// proxy would have had answered.
///
/// The plugin's reqwest (0.12, built with its `system-proxy` feature)
/// builds a client for every request, and that client asks hyper-util's
/// `Matcher::from_system` which proxy takes the URL: `HTTPS_PROXY` or
/// `ALL_PROXY` from the environment, less `NO_PROXY`, and on Windows the
/// WinINet `ProxyServer` while `ProxyEnable` is on, less `ProxyOverride`.
/// The same matcher, built the same way just before the request, is asked
/// here, so this follows reqwest's own decision rather than a copy of its
/// rules. It is the same code: Cargo.lock holds one hyper-util 0.1. Should
/// the plugin move to a reqwest that decides otherwise, this has to follow.
///
/// Beyond that, anything set in WinINet counts (`wininet_names_a_proxy`):
/// a `ProxyServer` in the per-protocol form, which the matcher may read
/// otherwise than WinINet does, and a PAC script (`AutoConfigURL`), which
/// reqwest does not follow today and a later version might. Where a proxy
/// cannot be ruled out the look is given up. A request left to find out
/// for itself costs at most a head start; one stopped on an answer that
/// was not its own was never sent.
///
/// Not "Automatically detect settings" (WPAD), which Windows has on by
/// default. Counted, it would end the look on nearly every machine, and
/// reqwest follows it no more than a PAC.
///
/// On the phones reqwest reads only the environment, and neither Android's
/// nor iOS's proxy setting: the request goes where the system resolver
/// says, through whatever VPN is up, as the look does. The environment is
/// still asked, the same way.
pub fn http_proxied(host: &str) -> bool {
    proxied_by(&Matcher::from_system(), wininet_proxy_set(), host)
}

/// `http_proxied`, with what it reads handed in, so it can be shown
/// without changing this machine's proxy settings. A name that does not
/// make a URL counts as proxied: nothing is known about its request.
fn proxied_by(matcher: &Matcher, wininet: bool, host: &str) -> bool {
    if wininet {
        return true;
    }
    // An IPv6 literal goes in brackets, as it does in the request's URL.
    let host = match host.parse::<std::net::Ipv6Addr>() {
        Ok(_) => format!("[{host}]"),
        Err(_) => host.to_string(),
    };
    match format!("https://{host}/").parse::<tauri::http::Uri>() {
        Ok(uri) => matcher.intercept(&uri).is_some(),
        Err(_) => true,
    }
}

/// Whether the current user's WinINet settings name a proxy, read where
/// reqwest's matcher reads them. A key that cannot be opened is one that
/// matcher cannot read either, so its requests go direct.
#[cfg(windows)]
fn wininet_proxy_set() -> bool {
    let Ok(settings) =
        windows_registry::CURRENT_USER.open(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
    else {
        return false;
    };
    wininet_names_a_proxy(
        settings.get_u32("ProxyEnable").ok(),
        settings.get_string("ProxyServer").ok().as_deref(),
        settings.get_string("AutoConfigURL").ok().as_deref(),
    )
}

/// Only Windows has WinINet.
#[cfg(not(windows))]
fn wininet_proxy_set() -> bool {
    false
}

/// A proxy server while proxying is switched on, or a PAC script.
#[cfg_attr(not(windows), allow(dead_code))]
fn wininet_names_a_proxy(enable: Option<u32>, server: Option<&str>, pac: Option<&str>) -> bool {
    let named = |value: Option<&str>| value.is_some_and(|value| !value.trim().is_empty());
    (enable.unwrap_or(0) != 0 && named(server)) || named(pac)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_the_one_path_of_an_https_base() {
        let url = health_url("https://connect.neoxify.site/api").unwrap();
        assert_eq!(url.as_str(), "https://connect.neoxify.site/api/health/ip");
        // A mirror on its own port, and a base written with a slash.
        let url = health_url("https://mirror.example:2053/api/").unwrap();
        assert_eq!(url.as_str(), "https://mirror.example:2053/api/health/ip");
    }

    #[test]
    fn allows_plain_http_only_for_a_local_backend() {
        assert!(health_url_allowing("http://localhost:4000/api", true).is_ok());
        assert!(health_url_allowing("http://127.0.0.1:4000/api", true).is_ok());
        assert!(health_url_allowing("http://connect.neoxify.site/api", true).is_err());
        assert!(health_url_allowing("http://connect.neoxify.site/api", false).is_err());
    }

    /// A release build has no local backend, and the command sits outside
    /// the capability scope: the webview could otherwise have it fetch
    /// from any port on this machine, over https as well as http.
    #[test]
    fn a_release_build_asks_nothing_on_this_machine() {
        for base in [
            "http://localhost:4000/api",
            "https://localhost:8443/api",
            "https://LOCALHOST/api",
            "http://127.0.0.1:4000/api",
            "https://127.0.0.1:9/api",
            "https://127.5.5.5/api",
            "https://[::1]:8443/api",
        ] {
            assert!(health_url_allowing(base, false).is_err(), "{base} should be refused");
        }
        assert!(health_url_allowing("https://connect.neoxify.site/api", false).is_ok());
        assert!(health_url_allowing("https://mirror.example:2053/api", false).is_ok());
        // Which rule the build gets.
        assert_eq!(
            health_url("https://localhost:8443/api").is_ok(),
            cfg!(debug_assertions),
        );
    }

    /// The HTTPS path, which the tests above never take (they use plain
    /// http on loopback), against a real server, by hand:
    ///
    /// ```text
    /// NEOXIFY_HEALTH_IP_LIVE=https://host[:port]/base \
    ///   cargo test -p neoconnect-desktop --lib live_health_ip -- --ignored --nocapture
    /// ```
    ///
    /// Any https base will do to show the TLS and IPv4-only connection
    /// work (a host without `/health/ip` answers 404, which is still an
    /// answer); ours to see the address it reports. Ignored because its
    /// answer depends on the network, and the base comes from the
    /// environment so no host is committed.
    #[test]
    #[ignore]
    fn live_health_ip() {
        let base = std::env::var("NEOXIFY_HEALTH_IP_LIVE").expect("set NEOXIFY_HEALTH_IP_LIVE=https://...");
        let started = std::time::Instant::now();
        let answer = tauri::async_runtime::block_on(health_ip_v4(base, 6_000));
        println!("{answer:?} in {}ms", started.elapsed().as_millis());
        assert!(answer.is_ok(), "no HTTP answer over IPv4");
    }

    /// Serves exactly one HTTP response on `listener`, in a thread, and
    /// hands back the request line it was asked with.
    fn serve_once(
        listener: std::net::TcpListener,
        response: &'static str,
    ) -> std::thread::JoinHandle<Option<String>> {
        use std::io::{BufRead, BufReader, Write};
        std::thread::spawn(move || {
            listener.set_nonblocking(false).ok()?;
            let (stream, _) = listener.accept().ok()?;
            let mut reader = BufReader::new(stream.try_clone().ok()?);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).ok()?;
            // Drain the headers so the client sees an orderly exchange.
            let mut line = String::new();
            while reader.read_line(&mut line).ok()? > 2 {
                line.clear();
            }
            let mut stream = stream;
            stream.write_all(response.as_bytes()).ok()?;
            Some(request_line)
        })
    }

    const OK_JSON: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"ip\":\"192.0.2.1\"}";
    const GATEWAY_PAGE: &str = "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: 11\r\nConnection: close\r\n\r\n<h1>502</h1>";

    #[test]
    fn reads_the_answer_from_an_ipv4_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_once(listener, OK_JSON);

        let answer = tauri::async_runtime::block_on(health_ip_v4(
            format!("http://localhost:{port}/api"),
            3_000,
        ))
        .expect("an IPv4 listener answers");
        assert_eq!(answer.status, 200);
        assert_eq!(answer.body, Some(serde_json::json!({ "ip": "192.0.2.1" })));
        let request_line = server.join().unwrap().unwrap();
        assert!(request_line.starts_with("GET /api/health/ip "), "{request_line}");
    }

    /// The address actually connected to, not the name asked for: the
    /// base says `localhost`, the connection went to 127.0.0.1, and that
    /// is what the egress check compares with the tunnel's server.
    #[test]
    fn reports_the_address_it_connected_to() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_once(listener, OK_JSON);

        let answer = tauri::async_runtime::block_on(health_ip_v4(
            format!("http://localhost:{port}/api"),
            3_000,
        ))
        .expect("an IPv4 listener answers");
        assert_eq!(answer.peer.as_deref(), Some("127.0.0.1"));
        server.join().unwrap();

        // And it is one of the addresses the name resolves to, which is
        // how a server named by hostname is recognised.
        let resolved = tauri::async_runtime::block_on(resolve_ipv4("localhost".to_string(), 3_000, None, None)).unwrap();
        assert!(resolved.contains(&"127.0.0.1".to_string()), "{resolved:?}");
    }

    /// The child half of [`asks_around_any_proxy`]: run only in a process
    /// of its own, whose environment names a proxy. Ignored, and a no-op
    /// without its marker, so a plain `--ignored` run passes it by.
    #[test]
    #[ignore]
    fn proxied_child() {
        if std::env::var_os("NEOXIFY_PROXIED_CHILD").is_none() {
            return;
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_once(listener, OK_JSON);
        let answer = tauri::async_runtime::block_on(health_ip_v4(
            format!("http://localhost:{port}/api"),
            3_000,
        ));
        assert_eq!(
            answer.map(|a| a.peer),
            Ok(Some("127.0.0.1".to_string())),
            "the request went to the proxy, not to the endpoint",
        );
        server.join().unwrap();
        println!("NEOXIFY_PROXIED_CHILD reached the endpoint");
    }

    /// A proxy in the environment is not used: the request still goes
    /// straight to the endpoint, and `peer` is the endpoint's address.
    /// In a child process, because the environment is the whole process's
    /// and the other tests here run beside this one. The proxy named is a
    /// port nothing listens on, so a request that went to it gets no
    /// answer at all.
    #[test]
    fn asks_around_any_proxy() {
        let dead = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy = format!("http://127.0.0.1:{}", dead.local_addr().unwrap().port());
        drop(dead);
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "health_ip::tests::proxied_child", "--nocapture"])
            .env("NEOXIFY_PROXIED_CHILD", "1")
            .env("HTTP_PROXY", &proxy)
            .env("HTTPS_PROXY", &proxy)
            .env("ALL_PROXY", &proxy)
            .env_remove("NO_PROXY")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
        // And the child really ran it, rather than matching nothing.
        assert!(stdout.contains("NEOXIFY_PROXIED_CHILD reached the endpoint"), "{stdout}");
    }

    #[test]
    fn resolves_a_literal_to_itself_and_a_name_to_ipv4_only() {
        let resolve = |host: &str| tauri::async_runtime::block_on(resolve_ipv4(host.to_string(), 3_000, None, None));
        assert_eq!(resolve("192.0.2.1"), Ok(vec!["192.0.2.1".to_string()]));
        assert_eq!(resolve(" 192.0.2.1 "), Ok(vec!["192.0.2.1".to_string()]));
        // An IPv4-mapped literal is the IPv4 address it carries.
        assert_eq!(resolve("::ffff:192.0.2.1"), Ok(vec!["192.0.2.1".to_string()]));
        // `localhost` has an IPv6 answer on Windows too; only IPv4 is kept.
        let local = resolve("localhost").unwrap();
        assert!(!local.is_empty() && local.iter().all(|a| a.parse::<Ipv4Addr>().is_ok()), "{local:?}");
        // Asked for explicitly, IPv4 is said as well -- and Some(false) is
        // the same as not asking.
        let ipv4_only = |host: &str, with: Option<bool>| tauri::async_runtime::block_on(resolve_ipv4(host.to_string(), 3_000, with, None));
        assert_eq!(ipv4_only("localhost", Some(false)), Ok(local.clone()));
    }

    /// With IPv6 asked for, a name's IPv6 addresses come back after its
    /// IPv4 ones, which lead unchanged. The block-page look depends on it:
    /// a name with a real IPv6 address is not one to stop a request to.
    #[test]
    fn keeps_a_names_ipv6_addresses_when_asked() {
        let resolve = |with: Option<bool>| {
            tauri::async_runtime::block_on(resolve_ipv4("localhost".to_string(), 3_000, with, None)).unwrap()
        };
        let ipv4 = resolve(None);
        let both = resolve(Some(true));
        assert_eq!(&both[..ipv4.len()], &ipv4[..], "{both:?}");
        assert!(both[ipv4.len()..].iter().all(|a| a.parse::<std::net::Ipv6Addr>().is_ok()), "{both:?}");
        // Windows answers `localhost` with ::1 as well (see above), so
        // there the IPv6 half is not empty.
        if cfg!(windows) {
            assert!(both.contains(&"::1".to_string()), "{both:?}");
        }
    }

    #[test]
    fn asks_the_resolver_nothing_that_is_not_a_hostname() {
        for host in ["", "a b", "x/y", "http://example.com", "example.com:443", "exa_mple.com"] {
            let answer = tauri::async_runtime::block_on(resolve_ipv4(host.to_string(), 1_000, None, None));
            assert_eq!(answer, Err("not a hostname".to_string()), "{host:?}");
        }
        let long = "a".repeat(MAX_HOSTNAME + 1);
        assert!(tauri::async_runtime::block_on(resolve_ipv4(long, 1_000, None, None)).is_err());
    }

    /// Which settings put an https request through a proxy, by the matcher
    /// reqwest asks: a proxy for https or for everything does, one for
    /// plain http alone does not, and `NO_PROXY` takes a name and the names
    /// under it back out. Anything WinINet names counts whatever the
    /// matcher says.
    #[test]
    fn a_proxy_for_https_requests_is_one_the_resolver_says_nothing_about() {
        let none = Matcher::builder().build();
        assert!(!proxied_by(&none, false, "api.example.test"));
        // Address literals make URLs too, an IPv6 one in or out of brackets.
        assert!(!proxied_by(&none, false, "192.0.2.1"));
        assert!(!proxied_by(&none, false, "2001:db8::1"));
        assert!(!proxied_by(&none, false, "[2001:db8::1]"));

        let https = Matcher::builder().https("http://127.0.0.1:8080").build();
        assert!(proxied_by(&https, false, "api.example.test"));
        let all = Matcher::builder().all("socks5://127.0.0.1:1080").build();
        assert!(proxied_by(&all, false, "api.example.test"));
        // reqwest sends an https request through `HTTPS_PROXY` or
        // `ALL_PROXY`, never through `HTTP_PROXY`.
        let http_only = Matcher::builder().http("http://127.0.0.1:8080").build();
        assert!(!proxied_by(&http_only, false, "api.example.test"));

        let excepted = Matcher::builder().https("http://127.0.0.1:8080").no("example.test").build();
        assert!(!proxied_by(&excepted, false, "api.example.test"));
        assert!(proxied_by(&excepted, false, "mirror.example.org"));

        assert!(proxied_by(&none, true, "api.example.test"));
        assert!(proxied_by(&excepted, true, "api.example.test"));
    }

    /// What in WinINet's settings counts as a proxy that may take the
    /// app's requests.
    #[test]
    fn wininet_names_a_proxy_by_its_server_while_on_or_by_a_pac() {
        // Psiphon, v2rayN and Clash in system-proxy mode.
        assert!(wininet_names_a_proxy(Some(1), Some("127.0.0.1:8080"), None));
        // The per-protocol form counts too, however the matcher reads it.
        assert!(wininet_names_a_proxy(Some(1), Some("http=127.0.0.1:8080;https=127.0.0.1:8080"), None));
        // A server left behind with proxying switched off is not in use.
        assert!(!wininet_names_a_proxy(Some(0), Some("127.0.0.1:8080"), None));
        assert!(!wininet_names_a_proxy(None, Some("127.0.0.1:8080"), None));
        assert!(!wininet_names_a_proxy(Some(1), Some("  "), None));
        // A PAC script, which reqwest does not follow today, counts on its
        // own: it cannot be ruled out.
        assert!(wininet_names_a_proxy(Some(0), None, Some("http://127.0.0.1:10808/pac")));
        assert!(wininet_names_a_proxy(None, None, Some("http://127.0.0.1:10808/pac")));
        assert!(!wininet_names_a_proxy(None, None, Some("")));
        assert!(!wininet_names_a_proxy(None, None, None));
    }

    /// The child half of [`a_proxy_in_the_environment_ends_the_look`]: run
    /// only in a process of its own, whose environment names a proxy.
    /// Ignored, and a no-op without its marker, so a plain `--ignored` run
    /// passes it by.
    #[test]
    #[ignore]
    fn proxy_environment_child() {
        if std::env::var_os("NEOXIFY_PROXY_ENV_CHILD").is_none() {
            return;
        }
        let look = |host: &str, unless_proxied: Option<bool>| {
            tauri::async_runtime::block_on(resolve_ipv4(host.to_string(), 3_000, Some(true), unless_proxied))
        };
        // The system's matcher reads the environment, as reqwest's does.
        assert!(http_proxied("api.example.test"));
        // The look is given up, and before the resolver is asked: a name
        // under the reserved `.test` would otherwise fail to resolve.
        assert_eq!(look("api.example.test", Some(true)), Err("proxied".to_string()));
        // The engines' lookup is not the HTTP plugin's, and goes on.
        assert!(look("localhost", None).is_ok_and(|found| !found.is_empty()));
        // `NO_PROXY` names localhost: its requests go direct, and the look
        // is made -- unless WinINet on this machine names a proxy too.
        assert_eq!(look("localhost", Some(true)).is_ok(), !wininet_proxy_set());
        println!("NEOXIFY_PROXY_ENV_CHILD looked");
    }

    /// `HTTPS_PROXY` in the environment, which reqwest honours, ends the
    /// block-page look for the names it covers and no other. In a child
    /// process, because the environment is the whole process's and the
    /// other tests here run beside this one.
    #[test]
    fn a_proxy_in_the_environment_ends_the_look() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "health_ip::tests::proxy_environment_child", "--nocapture"])
            .env("NEOXIFY_PROXY_ENV_CHILD", "1")
            .env("HTTPS_PROXY", "http://127.0.0.1:9")
            .env("NO_PROXY", "localhost")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(output.status.success(), "{stdout}\n{}", String::from_utf8_lossy(&output.stderr));
        assert!(stdout.contains("NEOXIFY_PROXY_ENV_CHILD looked"), "{stdout}");
    }

    #[test]
    fn reports_an_error_page_as_an_answer_with_no_body() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = serve_once(listener, GATEWAY_PAGE);

        let answer = tauri::async_runtime::block_on(health_ip_v4(
            format!("http://localhost:{port}/api"),
            3_000,
        ))
        .expect("a 502 is still an answer");
        assert_eq!(
            answer,
            HealthIpAnswer { status: 502, body: None, peer: Some("127.0.0.1".to_string()) },
        );
        server.join().unwrap();
    }

    /// The property the module exists for, shown on this machine's own
    /// loopback rather than argued: `localhost` resolves to both `::1`
    /// and `127.0.0.1` on Windows, and with only an IPv6 listener the
    /// pinned request finds nobody, where an unpinned client -- what
    /// tauri-plugin-http builds -- happily answers over IPv6.
    #[test]
    fn never_asks_over_ipv6() {
        let Ok(listener) = std::net::TcpListener::bind("[::1]:0") else {
            eprintln!("no IPv6 loopback here; nothing to show");
            return;
        };
        let port = listener.local_addr().unwrap().port();
        // Nothing may be listening on the IPv4 side of the same port.
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            eprintln!("port {port} is taken on IPv4 too; inconclusive");
            return;
        }

        let pinned = tauri::async_runtime::block_on(health_ip_v4(
            format!("http://localhost:{port}/api"),
            2_000,
        ));
        assert_eq!(pinned, Err("no answer".to_string()));
        // And not "connected over IPv6, then gave up waiting": the kernel
        // completes a handshake into the backlog without `accept`, so a
        // connection made over IPv6 would be sitting there now.
        listener.set_nonblocking(true).unwrap();
        assert!(
            matches!(listener.accept(), Err(e) if e.kind() == std::io::ErrorKind::WouldBlock),
            "the pinned request reached the IPv6 listener",
        );

        // Control: the same request, unpinned, reaches the IPv6 listener.
        let server = serve_once(listener, OK_JSON);
        let unpinned = tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            client
                .get(format!("http://localhost:{port}/api/health/ip"))
                .send()
                .await
                .map(|r| r.status().as_u16())
        });
        assert_eq!(unpinned.ok(), Some(200), "an unpinned client uses IPv6 here");
        server.join().unwrap();
    }

    #[test]
    fn refuses_anything_that_is_not_a_plain_base() {
        for base in [
            "file:///C:/Windows/win.ini",
            "ftp://example.com/api",
            "https://user:secret@example.com/api",
            "https://example.com/api?x=1#",
            "https://example.com/api#frag",
            "not a url",
            "",
        ] {
            assert!(health_url(base).is_err(), "{base} should be refused");
        }
    }
}
